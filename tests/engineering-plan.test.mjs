import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRevision } from '../lib/planning-review.mjs';
import { ENGINEERING_PLATFORM, engineeringPlanPolicy, inspectEngineeringContext, validateEngineeringPlan } from '../lib/engineering-plan.mjs';

function spec() { return { title: '工单协作', roles: ['访客：提交并查看本人问题', '处理员：分派及处理问题'], constraints: ['非法操作不得改变记录'],
  stack: { frontend: '原生 HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [
    { id: 'REQ1', title: '提交问题', description: '用户提交有效问题', acceptance: ['标题非空且新增成功'], sourceQuote: '用户可以提交问题', kind: 'functional' },
    { id: 'REQ2', title: '分派问题', description: '处理员分派给已存在用户', acceptance: ['不存在用户被拒绝'], sourceQuote: '处理员分派给用户', kind: 'functional' },
  ] }; }
const bindingFor = value => ({ projectId: 'project', runId: 'run', specRevision: contentRevision(value) });
function proposal() { return { version: 1, title: '工单工程设计', summary: '需求驱动的实体、接口和任务草案', entities: [
  { id: 'USER', name: '用户', constraints: [], fields: [{ name: 'id', type: 'string', required: true, unique: true }] },
  { id: 'ISSUE', name: '问题', constraints: ['标题不得为空'], fields: [{ name: 'id', type: 'string', required: true, unique: true }, { name: 'title', type: 'string', required: true }, { name: 'ownerId', type: 'string', required: true, references: { entityId: 'USER', field: 'id' } }] },
], routes: [
  { id: 'CREATE', method: 'POST', path: '/api/issues', roles: ['ROLE-001'], request: 'JSON标题', response: '201与新问题', errors: [{ status: 400, reason: '标题无效' }], requirementIds: ['REQ1'] },
  { id: 'ASSIGN', method: 'PUT', path: '/api/issues/:issueId/assignee', roles: ['ROLE-002'], request: '目标用户ID', response: '200与分派结果', errors: [{ status: 403, reason: '无权分派' }, { status: 404, reason: '目标用户不存在' }], requirementIds: ['REQ2'] },
], views: [{ id: 'ISSUES', path: '/', title: '问题工作台', requirementIds: ['REQ1', 'REQ2'], selectors: [{ testId: 'issue-title', role: 'textbox' }, { testId: 'issue-submit', role: 'button' }] }], tasks: [
  { id: 'SCHEMA', title: '数据契约', description: '按实体建立持久化数据', requirementIds: ['REQ1', 'REQ2'], dependsOn: [], writePaths: ['migrations/001.sql'], inputs: ['已确认需求'], outputs: ['数据结构'], acceptance: ['关联约束明确'] },
  { id: 'BACKEND', title: '接口实现', description: '处理新增与分派', requirementIds: ['REQ1', 'REQ2'], dependsOn: ['SCHEMA'], writePaths: ['src/app.mjs'], inputs: ['数据契约'], outputs: ['后端接口'], acceptance: ['权限和非法输入拒绝'] },
  { id: 'FRONTEND', title: '原生页面', description: '外置资源展示交互', requirementIds: ['REQ1', 'REQ2'], dependsOn: ['BACKEND'], writePaths: ['public/index.html', 'public/app.js'], inputs: ['接口契约'], outputs: ['原生界面'], acceptance: ['表单可访问'] },
  { id: 'VERIFY', title: '回归素材', description: '记录开发自检案例', requirementIds: ['REQ2'], dependsOn: ['FRONTEND'], writePaths: ['tests/api.test.mjs'], inputs: ['原始需求'], outputs: ['自检案例'], acceptance: ['保留非法分派反例，可信验收另行运行'] },
] }; }
function draft(raw = proposal(), original = spec()) { return validateEngineeringPlan({ proposal: raw, spec: original, binding: bindingFor(original) }); }
function rejects(mutate, pattern) { const value = proposal(); mutate(value); assert.throws(() => draft(value), pattern ?? { code: 'invalid_engineering_plan' }); }

test('confirmed content, original requirements and Chinese role definitions remain immutable data with a canonical draft hash', () => {
  const original = spec(), raw = proposal(), result = draft(raw, original), { hash, ...body } = result;
  assert.equal(hash, contentRevision(body)); assert.equal(result.specHash, contentRevision(original)); assert.deepEqual(result.binding, bindingFor(original));
  assert.deepEqual(result.requirements, original.requirements); assert.deepEqual(result.roleDefinitions, [{ id: 'ROLE-001', text: original.roles[0] }, { id: 'ROLE-002', text: original.roles[1] }]);
  assert.equal(result.policyHash, engineeringPlanPolicy.hash); assert.deepEqual(result.platform, ENGINEERING_PLATFORM); assert.equal(result.coverage, 'structural_only');
  assert.equal(Object.hasOwn(result, 'passed'), false); assert.equal(Object.hasOwn(result, 'approval'), false); assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.proposal.tasks[0]) && Object.isFrozen(result.requirements));
  original.roles[0] = 'changed'; original.requirements[0].description = 'changed'; raw.tasks[0].description = 'changed';
  assert.equal(result.roleDefinitions[0].text, '访客：提交并查看本人问题'); assert.equal(result.requirements[0].description, '用户提交有效问题'); assert.equal(result.proposal.tasks[0].description, '按实体建立持久化数据');
});

test('object key order is canonical, while changed spec content, role order, binding or proposal has a new hash', () => {
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
  assert.equal(draft().hash, draft(reverse(proposal()), reverse(spec())).hash);
  const raw = proposal(); raw.summary += '补充业务说明'; assert.notEqual(draft().hash, draft(raw).hash);
  const changed = spec(); changed.roles.reverse(); assert.notEqual(draft().hash, draft(proposal(), changed).hash);
  const original = spec(), binding = { ...bindingFor(original), runId: 'another-run' }; assert.notEqual(draft().hash, validateEngineeringPlan({ proposal: proposal(), spec: original, binding }).hash);
});

test('fixed revision must match current spec and unsupported stack cannot be silently redesigned', () => {
  const original = spec(); assert.throws(() => inspectEngineeringContext({ spec: original, binding: { ...bindingFor(original), specRevision: 'a'.repeat(64) } }), /specRevision/u);
  for (const mutate of [value => { value.stack.frontend = 'React'; }, value => { value.stack.backend = 'Java'; }, value => { value.stack.backend = 'Node.js 18'; }, value => { value.stack.backend = 'Node.js 22.20'; }, value => { value.stack.backend = 'Node.js ' + '9'.repeat(100); }, value => { value.stack.storage = 'PostgreSQL'; }, value => { value.stack.storage = 'SQLite 2'; }, value => { value.requirements[0].acceptance = []; }, value => { value.requirements[0].id = value.requirements[1].id; }]) {
    const value = spec(); mutate(value); assert.throws(() => inspectEngineeringContext({ spec: value, binding: bindingFor(value) }));
  }
  for (const backend of ['Node.js', 'Node.js 22', 'Node.js 22.21', 'Node.js 24.0']) { const compatible = spec(); compatible.stack = { frontend: '原生HTML', backend, storage: 'SQLite 3' }; assert.doesNotThrow(() => draft(proposal(), compatible)); }
});

test('pure snapshot rejects getters, toJSON, cycles, sparse/custom arrays, symbols and non-finite numbers without invoking code', () => {
  let invoked = false;
  const getter = spec(); Object.defineProperty(getter, 'hidden', { enumerable: true, get() { invoked = true; return 1; } });
  assert.throws(() => inspectEngineeringContext({ spec: getter, binding: bindingFor(spec()) }));
  for (const mutate of [value => { value.extra = Infinity; }, value => { value.extra = NaN; }, value => { value.extra = '\ud800'; }, value => { value.extra = value; },
    value => { value.toJSON = () => { invoked = true; }; }, value => { Object.defineProperty(value.requirements, 'map', { value() { invoked = true; } }); },
    value => { Object.setPrototypeOf(value.requirements, { map() { invoked = true; } }); }, value => { delete value.requirements[0]; }, value => { value[Symbol('x')] = 'bad'; }, value => { value['\ud800'] = 1; }]) {
    const value = spec(); mutate(value); assert.throws(() => inspectEngineeringContext({ spec: value, binding: bindingFor(spec()) }));
  }
  const outer = { spec: spec(), binding: bindingFor(spec()) }; Object.defineProperty(outer, 'proposal', { enumerable: true, get() { invoked = true; return proposal(); } }); assert.throws(() => validateEngineeringPlan(outer));
  const raw = proposal(); Object.defineProperty(raw.tasks[0], 'acceptance', { enumerable: true, get() { invoked = true; return []; } }); assert.throws(() => draft(raw)); assert.equal(invoked, false);
});

test('unknown executable fields, completion flags, missing fields and wrong primitive types are rejected', () => {
  for (const key of ['passed', 'approved', 'sql', 'scripts', 'commands', 'platform', 'requirements', 'roleDefinitions', 'package']) rejects(raw => { raw[key] = 'not permitted'; });
  rejects(raw => { raw.routes[0].headers = { authorization: 'not permitted' }; }); rejects(raw => { raw.tasks[0].command = 'npm test'; });
  rejects(raw => { raw.entities[0].sql = 'CREATE TABLE'; }); rejects(raw => { delete raw.summary; }); rejects(raw => { raw.version = '1'; });
  rejects(raw => { raw.tasks[0].acceptance = []; }); rejects(raw => { raw.tasks[0].inputs = []; }); rejects(raw => { raw.tasks[0].outputs = []; });
});

test('entity references require known same-type unique targets; relationships may cycle without task cycles', () => {
  for (const reference of [{ entityId: 'UNKNOWN', field: 'id' }, { entityId: 'USER', field: 'missing' }]) rejects(raw => { raw.entities[1].fields[2].references = reference; });
  rejects(raw => { raw.entities[0].fields[0].unique = false; }); rejects(raw => { raw.entities[1].fields[2].type = 'integer'; });
  rejects(raw => { raw.entities[0].fields.push({ ...raw.entities[0].fields[0] }); }); rejects(raw => { raw.entities[0].fields[0].type = 'object'; });
  rejects(raw => { raw.entities[0].fields[0].required = 'true'; }); rejects(raw => { raw.entities[0].fields[0].unique = 1; });
  const raw = proposal(); raw.entities[0].fields.push({ name: 'firstIssue', type: 'string', required: false, references: { entityId: 'ISSUE', field: 'id' } }); assert.doesNotThrow(() => draft(raw));
});

test('IDs, field names and global testIds must be unique in their stated scopes', () => {
  for (const collection of ['entities', 'routes', 'views', 'tasks']) rejects(raw => { raw[collection].push(structuredClone(raw[collection][0])); });
  rejects(raw => { raw.entities[0].fields[0].name = '__proto__'; }); rejects(raw => { raw.views[0].selectors[1].testId = raw.views[0].selectors[0].testId; });
  rejects(raw => { raw.views.push({ ...structuredClone(raw.views[0]), id: 'SECOND', path: '/another' }); });
  rejects(raw => { raw.views[0].selectors[0].role = 'administrator'; }); rejects(raw => { raw.views[0].selectors[0].testId = 'field[0]'; });
});

test('roles and requirement maps come only from fixed context; tasks must cover every known requirement', () => {
  for (const role of ['admin', '访客：提交并查看本人问题', 'ROLE-999']) rejects(raw => { raw.routes[0].roles = [role]; });
  const publicRoute = proposal(); publicRoute.routes[0].roles = []; assert.doesNotThrow(() => draft(publicRoute));
  rejects(raw => { raw.routes[0].requirementIds = ['UNKNOWN']; }); rejects(raw => { raw.views[0].requirementIds = ['UNKNOWN']; }); rejects(raw => { raw.tasks[0].requirementIds = ['UNKNOWN']; });
  rejects(raw => { raw.tasks.forEach(item => { item.requirementIds = ['REQ1']; }); }, /覆盖/u); rejects(raw => { raw.tasks[0].requirementIds = []; });
});

test('REST and view paths reject URLs/encoding/traversal, and parameter-renaming cannot duplicate endpoints', () => {
  for (const path of ['https://external.invalid/', '//external.invalid/a', '/api/%2e%2e/secret', '/api/../secret', '/api//x', '/api\\x', '/api#fragment', '/api?x=1', '/api/:id/:id', '/api/:id.json', '/api/']) {
    rejects(raw => { raw.routes[0].path = path; }); rejects(raw => { raw.views[0].path = path; });
  }
  rejects(raw => { raw.routes.push({ ...structuredClone(raw.routes[1]), id: 'DUPLICATE', path: '/api/issues/:recordId/assignee' }); });
  rejects(raw => { raw.views = [{ ...raw.views[0], path: '/issues/:id' }, { ...raw.views[0], id: 'OTHER', path: '/issues/:recordId', selectors: [{ testId: 'another', role: 'heading' }] }]; });
  for (const status of [200, 399, 600, '400', NaN]) rejects(raw => { raw.routes[0].errors[0].status = status; });
  rejects(raw => { raw.routes[0].method = 'CONNECT'; }); rejects(raw => { raw.routes[0].errors.push({ status: 400, reason: '重复错误状态' }); });
});

test('DAG allows forward references and transitive serialized shared files but never sibling writers or cycles', () => {
  const reordered = proposal(); reordered.tasks.reverse(); assert.doesNotThrow(() => draft(reordered));
  rejects(raw => { raw.tasks[0].dependsOn = ['UNKNOWN']; }); rejects(raw => { raw.tasks[0].dependsOn = ['SCHEMA']; }); rejects(raw => { raw.tasks[0].dependsOn = ['VERIFY']; });
  const chain = proposal(); chain.tasks[2].writePaths.push('src/app.mjs'); chain.tasks[3].writePaths.push('src/app.mjs'); assert.doesNotThrow(() => draft(chain));
  rejects(raw => { raw.tasks[2].dependsOn = ['BACKEND']; raw.tasks[3].dependsOn = ['BACKEND']; raw.tasks[2].writePaths.push('public/shared.js'); raw.tasks[3].writePaths.push('public/shared.js'); }, /串行/u);
  const readOnly = proposal(); readOnly.tasks[3].writePaths = []; assert.doesNotThrow(() => draft(readOnly));
});

test('exact writable file scope reuses platform rules and cross-task aliases/parent collisions are rejected', () => {
  for (const path of ['../escape.mjs', '/root/x.mjs', 'C:/x.mjs', 'package.json', 'package-lock.json', 'server.mjs', '.platform/x.json', '.git/x.txt', 'node_modules/x.js', 'src/**', 'src/', 'src\\x.mjs', 'src/%2e/x.js', 'public/CON.txt', 'src/app.mjs:stream']) rejects(raw => { raw.tasks[0].writePaths = [path]; });
  rejects(raw => { raw.tasks[0].writePaths = ['src/A.mjs', 'src/a.mjs']; }); rejects(raw => { raw.tasks[3].writePaths = ['src/App.mjs']; });
  rejects(raw => { raw.tasks[0].writePaths = ['src/a.json']; raw.tasks[1].writePaths = ['src/a.json/child.mjs']; });
  rejects(raw => { raw.tasks[0].writePaths = Array.from({ length: 60 }, (_, index) => `src/file-${index}.mjs`); });
});

test('structure, byte, count and node budgets are enforced before processing unbounded plans', () => {
  rejects(raw => { raw.summary = 'x'.repeat(256 * 1024); });
  for (const [collection, count] of [['entities', 41], ['routes', 101], ['views', 41], ['tasks', 81]]) rejects(raw => { raw[collection] = Array.from({ length: count }, (_, index) => ({ ...raw[collection][0], id: 'ID-' + index })); });
  rejects(raw => { raw.entities[0].fields = Array.from({ length: 65 }, (_, index) => ({ name: 'field' + index, type: 'string', required: true })); });
  rejects(raw => { raw.views[0].selectors = Array.from({ length: 31 }, (_, index) => ({ testId: 'field' + index, role: 'textbox' })); });
  for (const mutate of [value => { value.extra = 'x'.repeat(128 * 1024); }, value => { value.extra = Array.from({ length: 1000 }, () => Array(30).fill(0)); }, value => { value.extra = {}; let node = value.extra; for (let index = 0; index < 17; index++) node = node.next = {}; }]) {
    const value = spec(); mutate(value); assert.throws(() => inspectEngineeringContext({ spec: value, binding: bindingFor(value) }));
  }
});

test('a different static domain need not invent entities or backend routes to satisfy a fixed business template', () => {
  const original = { title: '展览介绍', requirements: [{ id: 'SHOW', title: '展示内容', description: '展示已提供的展览介绍', acceptance: ['页面存在展览标题'] }], roles: [], constraints: [], stack: { frontend: 'HTML', backend: 'Node', storage: 'SQLite' } };
  const raw = { version: 1, title: '静态展览工程', summary: '无持久实体和业务API的原生页面', entities: [], routes: [], views: [{ id: 'HOME', path: '/', title: '展览', requirementIds: ['SHOW'], selectors: [{ testId: 'exhibition-title', role: 'heading' }] }],
    tasks: [{ id: 'PAGE', title: '展示介绍', description: '根据规格实现外置资源', requirementIds: ['SHOW'], dependsOn: [], writePaths: ['public/index.html', 'public/app.css'], inputs: ['确认的介绍'], outputs: ['可访问页面'], acceptance: ['标题与原文一致'] }] };
  const result = draft(raw, original); assert.equal(result.proposal.entities.length, 0); assert.deepEqual(result.roleDefinitions, []); assert.equal(result.coverage, 'structural_only');
});
