import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateProjectFiles } from './project-files.mjs';

export const ENGINEERING_LIMITS = Object.freeze({ contextBytes: 128 * 1024, proposalBytes: 256 * 1024,
  nodes: 20000, depth: 16, requirements: 80, roles: 50, entities: 40, fields: 64, routes: 100, views: 40, selectors: 30, tasks: 80, files: 60 });
export const ENGINEERING_PLATFORM = Object.freeze({ backend: 'Node.js >=22.21, built-in modules only', storage: 'SQLite',
  appModule: 'src/app.mjs', appExport: 'createApp', factoryInput: '{databasePath}', frontend: 'native HTML/CSS/JavaScript',
  publicRoot: 'public/', assets: 'same-origin external JS/CSS', stdout: 'platform protocol only', network: false, shell: false, installDependencies: false });
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u, fieldName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const types = new Set(['string', 'integer', 'number', 'boolean', 'datetime']);
const ariaRoles = new Set(['button', 'textbox', 'combobox', 'list', 'listitem', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'heading', 'form', 'navigation', 'link', 'dialog', 'status', 'alert', 'checkbox', 'radio', 'spinbutton', 'searchbox', 'tab', 'tablist', 'tabpanel', 'region', 'article', 'main', 'banner', 'contentinfo', 'group', 'progressbar', 'separator', 'img']);
const error = message => Object.assign(new Error(message), { code: 'invalid_engineering_plan' });
const need = (condition, message) => { if (!condition) throw error(message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function ordered(value) { return Array.isArray(value) ? value.map(ordered) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value; }
const canonical = value => JSON.stringify(ordered(value));
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }

function copyData(raw, maxBytes) {
  let nodes = 0; const ancestors = new Set();
  function walk(value, depth) {
    need(++nodes <= ENGINEERING_LIMITS.nodes && depth <= ENGINEERING_LIMITS.depth, '工程资料结构超限。');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { need(Number.isFinite(value), '工程资料数值必须有限。'); return value; }
    if (typeof value === 'string') { need(value.isWellFormed() && Buffer.byteLength(value) <= maxBytes, '工程资料文本无效或超限。'); return value; }
    need((Array.isArray(value) ? Object.getPrototypeOf(value) === Array.prototype : plain(value)) && !ancestors.has(value), '工程资料只允许无循环纯JSON。');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    need(Object.getOwnPropertySymbols(value).length === 0 && Object.values(descriptors).every(item => 'value' in item), '工程资料不能有访问器或符号。');
    ancestors.add(value); let result;
    if (Array.isArray(value)) {
      need(value.length <= 2000 && Object.keys(value).length === value.length && Object.keys(descriptors).every(key => key === 'length' || /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length), '工程资料数组必须连续、有界且无附加属性。');
      result = Array.from({ length: value.length }, (_, index) => walk(descriptors[index].value, depth + 1));
    } else {
      need(Object.keys(descriptors).every(key => !forbidden.has(key) && key.isWellFormed() && key.length <= maxBytes && Buffer.byteLength(key) <= maxBytes && descriptors[key].enumerable), '工程资料字段无效。');
      result = Object.fromEntries(Object.keys(descriptors).map(key => [key, walk(descriptors[key].value, depth + 1)]));
    }
    ancestors.delete(value); return result;
  }
  const result = walk(raw, 0); need(Buffer.byteLength(JSON.stringify(result)) <= maxBytes, '工程资料总字节超限。'); return result;
}
function keys(value, allowed, required = allowed) { need(plain(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), '工程对象缺少必要字段或包含未知执行字段。'); }
function text(value, label, max = 2000) { need(typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value), `${label}必须是有界非空文本。`); return value; }
function id(value) { need(typeof value === 'string' && identifier.test(value) && !forbidden.has(value), '工程编号无效。'); return value; }
function field(value) { need(typeof value === 'string' && fieldName.test(value) && !forbidden.has(value), '实体字段名无效。'); return value; }
function array(value, max, label, nonempty = true) { need(Array.isArray(value) && value.length <= max && (!nonempty || value.length > 0), `${label}数量无效。`); return value; }
function strings(value, max, label, nonempty = true) { array(value, max, label, nonempty).forEach(item => text(item, label)); need(new Set(value).size === value.length, `${label}不能重复。`); return value; }
function uniqueIds(items, label) { const result = new Map(); for (const item of items) { need(plain(item), `${label}项无效。`); id(item.id); need(!result.has(item.id), `${label}编号重复。`); result.set(item.id, item); } return result; }
function relativePath(value) {
  need(typeof value === 'string' && value.length <= 1024 && value.startsWith('/') && !value.startsWith('//'), '工程HTTP路径必须为应用内相对路径。');
  if (value === '/') return value;
  const segments = value.slice(1).split('/'), parameters = new Set();
  for (const segment of segments) {
    need(/^(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|:[A-Za-z][A-Za-z0-9_]{0,31})$/u.test(segment), '工程HTTP路径包含空段、点段、编码或不安全字符。');
    if (segment.startsWith(':')) { need(!parameters.has(segment), '工程HTTP路径参数重复。'); parameters.add(segment); }
  }
  return value.replace(/:[A-Za-z][A-Za-z0-9_]*/gu, ':parameter');
}
function knownRequirements(ids, requirements) { strings(ids, ENGINEERING_LIMITS.requirements, '需求映射'); ids.forEach(value => need(requirements.has(value), '工程草案引用了未知需求。')); }
// Consume only bounded positive qualifiers. Unknown/conflicting prose cannot
// become supported merely because it contains HTML, Node or SQLite keywords.
function stackQualifiers(value, rule, maximum) {
  const remaining = value.trim(); if (!remaining) return true;
  const clauses = remaining.replace(/^[,，;；]\s*/u, '').split(/[,，;；]/u);
  return clauses.length <= maximum && clauses.every(clause => rule.test(clause.trim()));
}
function supportedStack(stack) {
  need(plain(stack), '规格缺少技术栈。');
  for (const value of [stack.frontend, stack.backend, stack.storage]) text(value, '规格技术栈', 200);
  const frontendText = stack.frontend.trim(), backendText = stack.backend.trim();
  const frontend = frontendText.match(/^(?:原生\s*|native\s*)?HTML(?:\s*[/+]\s*CSS)?(?:\s*[/+]\s*(?:JavaScript|JS))?/iu);
  const frontendQualifier = /^(?:同源\s*外置|same-origin\s+external)\s*(?:(?:JavaScript|JS)\s*[/+]\s*CSS|CSS\s*[/+]\s*(?:JavaScript|JS))$/iu;
  const backend = backendText.match(/^Node(?:\.js)?(?:(?:\s*(?:>=|≥)\s*|\s+v?)(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\s*(?:及以上|以上))?)?/iu);
  const backendQualifier = /^(?:原生\s*HTTP(?:服务(?:器)?)?|native\s+HTTP(?:\s+server)?|ES\s*Modules|ESM|(?:仅(?:使用)?\s*)?内置模块|built(?:-|\s+)in\s+modules\s+only)$/iu;
  const versionNumbers = match => match && match.slice(1).filter(value => value !== undefined).every(value => Number.isSafeInteger(Number(value)));
  const supportedNode = versionNumbers(backend) && (backend[1] === undefined || Number(backend[1]) > 22 || Number(backend[1]) === 22 && (backend[2] === undefined || Number(backend[2]) >= 21));
  const storage = stack.storage.trim().match(/^(?:(?:Node(?:\.js)?\s*)?(?:内置|built-in)\s*)?SQLite(?:\s+(\d+)(?:\.(\d+))?(?:\.(\d+))?)?$/iu);
  need(frontend && stackQualifiers(frontendText.slice(frontend[0].length), frontendQualifier, 1)
    && supportedNode && stackQualifiers(backendText.slice(backend[0].length), backendQualifier, 3)
    && versionNumbers(storage) && (storage[1] === undefined || Number(storage[1]) === 3), '本工程草案版本只支持原生HTML/CSS/JS、Node.js和SQLite，不能改写不兼容规格。');
}

export const engineeringPlanPolicy = Object.freeze({ version: 'engineering-plan-v1',
  hash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL('./project-files.mjs', import.meta.url))).digest('hex') });

/** Copies content and checks its revision, without asserting any approval. */
export function inspectEngineeringContext(input) {
  const data = copyData(input, ENGINEERING_LIMITS.contextBytes); keys(data, ['spec', 'binding']);
  const { spec, binding } = data; keys(binding, ['projectId', 'runId', 'specRevision']);
  for (const key of ['projectId', 'runId']) need(typeof binding[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(binding[key]), '工程项目/运行编号无效。');
  need(typeof binding.specRevision === 'string' && /^[a-f0-9]{64}$/u.test(binding.specRevision), '工程规格版本必须为SHA256。');
  need(plain(spec), '工程输入必须为已确认规格资料。'); text(spec.title, '规格标题', 200);
  array(spec.requirements, ENGINEERING_LIMITS.requirements, '规格需求'); const reqIds = new Set();
  for (const requirement of spec.requirements) {
    need(plain(requirement), '规格需求无效。'); id(requirement.id); need(!reqIds.has(requirement.id), '规格需求编号重复。'); reqIds.add(requirement.id);
    text(requirement.title, '需求标题', 200); text(requirement.description, '需求说明', 12000); strings(requirement.acceptance, 30, '需求验收');
  }
  const roles = spec.roles ?? []; array(roles, ENGINEERING_LIMITS.roles, '规格角色', false); roles.forEach(value => text(value, '规格角色', 1000));
  if (spec.constraints !== undefined) strings(spec.constraints, 100, '规格约束', false);
  supportedStack(spec.stack);
  const specHash = hash(spec); need(binding.specRevision === specHash, '规格内容与固定specRevision不一致。');
  return freeze({ spec, binding, specHash, roleDefinitions: roles.map((value, index) => ({ id: `ROLE-${String(index + 1).padStart(3, '0')}`, text: value })), platform: { ...ENGINEERING_PLATFORM } });
}

/** Engineering data only. It neither approves nor runs tasks or commands. */
export function validateEngineeringPlan(input) {
  // Inspect the outer descriptors before reading even spec/binding/proposal.
  need(plain(input) && Object.getOwnPropertySymbols(input).length === 0, '工程校验输入无效。');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  need(Object.keys(descriptors).length === 3 && ['proposal', 'spec', 'binding'].every(key => descriptors[key]?.enumerable && 'value' in descriptors[key]), '工程校验输入字段无效或包含访问器。');
  const context = inspectEngineeringContext({ spec: descriptors.spec.value, binding: descriptors.binding.value });
  const proposal = copyData(descriptors.proposal.value, ENGINEERING_LIMITS.proposalBytes);
  keys(proposal, ['version', 'title', 'summary', 'entities', 'routes', 'views', 'tasks']); need(proposal.version === 1, '工程草案版本不支持。');
  text(proposal.title, '工程标题', 200); text(proposal.summary, '工程摘要', 5000);
  const entities = uniqueIds(array(proposal.entities, ENGINEERING_LIMITS.entities, '实体', false), '实体');
  const fields = new Map();
  for (const entity of entities.values()) {
    keys(entity, ['id', 'name', 'fields', 'constraints']); text(entity.name, '实体名称', 200); strings(entity.constraints, 30, '实体约束', false);
    const names = new Map(); array(entity.fields, ENGINEERING_LIMITS.fields, '实体字段').forEach(item => {
      keys(item, ['name', 'type', 'required', 'unique', 'references'], ['name', 'type', 'required']); field(item.name); need(!names.has(item.name), '实体字段名重复。'); names.set(item.name, item);
      need(types.has(item.type) && typeof item.required === 'boolean' && (item.unique === undefined || typeof item.unique === 'boolean'), '实体字段类型或约束无效。');
      if (item.references !== undefined) { keys(item.references, ['entityId', 'field']); id(item.references.entityId); field(item.references.field); }
    }); fields.set(entity.id, names);
  }
  for (const names of fields.values()) for (const item of names.values()) if (item.references) {
    const target = fields.get(item.references.entityId)?.get(item.references.field);
    need(target && target.type === item.type && target.unique === true, '字段引用必须指向存在、同类型且unique的字段。');
  }
  const requirements = new Set(context.spec.requirements.map(item => item.id)), roles = new Set(context.roleDefinitions.map(item => item.id));
  const routePaths = new Set();
  for (const route of uniqueIds(array(proposal.routes, ENGINEERING_LIMITS.routes, '接口', false), '接口').values()) {
    keys(route, ['id', 'method', 'path', 'roles', 'request', 'response', 'errors', 'requirementIds']);
    need(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(route.method), '工程HTTP方法无效。');
    const signature = `${route.method} ${relativePath(route.path)}`; need(!routePaths.has(signature), '工程接口路径重复。'); routePaths.add(signature);
    strings(route.roles, ENGINEERING_LIMITS.roles, '接口角色', false).forEach(role => need(roles.has(role), '接口角色必须引用原规格的ROLE编号。'));
    text(route.request, '接口请求'); text(route.response, '接口响应'); knownRequirements(route.requirementIds, requirements);
    const statuses = new Set(); array(route.errors, 20, '接口错误', false).forEach(item => { keys(item, ['status', 'reason']); need(Number.isInteger(item.status) && item.status >= 400 && item.status <= 599 && !statuses.has(item.status), '接口错误状态必须为唯一400至599状态。'); statuses.add(item.status); text(item.reason, '接口错误原因'); });
  }
  const viewPaths = new Set(), testIds = new Set();
  for (const view of uniqueIds(array(proposal.views, ENGINEERING_LIMITS.views, '页面'), '页面').values()) {
    keys(view, ['id', 'path', 'title', 'requirementIds', 'selectors']); const signature = relativePath(view.path); need(!viewPaths.has(signature), '页面路径重复。'); viewPaths.add(signature);
    text(view.title, '页面标题', 200); knownRequirements(view.requirementIds, requirements);
    array(view.selectors, ENGINEERING_LIMITS.selectors, '页面选择器').forEach(selector => { keys(selector, ['testId', 'role']); need(typeof selector.testId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(selector.testId) && !forbidden.has(selector.testId) && !testIds.has(selector.testId), '页面testId无效或重复。'); testIds.add(selector.testId); need(ariaRoles.has(selector.role), '页面可访问性角色无效。'); });
  }
  const tasks = uniqueIds(array(proposal.tasks, ENGINEERING_LIMITS.tasks, '开发任务'), '开发任务'), covered = new Set(), filesByFold = new Map(), writers = new Map();
  for (const task of tasks.values()) {
    keys(task, ['id', 'title', 'description', 'requirementIds', 'dependsOn', 'writePaths', 'inputs', 'outputs', 'acceptance']);
    text(task.title, '任务标题', 200); text(task.description, '任务说明', 5000); knownRequirements(task.requirementIds, requirements); task.requirementIds.forEach(value => covered.add(value));
    strings(task.dependsOn, ENGINEERING_LIMITS.tasks, '任务依赖', false).forEach(id); strings(task.inputs, 30, '任务输入'); strings(task.outputs, 30, '任务输出'); strings(task.acceptance, 30, '任务验收');
    array(task.writePaths, ENGINEERING_LIMITS.files, '任务可写文件', false);
    let normalized;
    try { normalized = validateProjectFiles(task.writePaths.map(path => ({ path, content: '' }))); } catch { throw error('任务可写文件必须是允许的精确相对文件，不能越界、重复或使用保留路径。'); }
    task.writePaths = normalized.map(item => item.path);
    for (const file of task.writePaths) {
      const folded = file.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
      need(!filesByFold.has(folded) || filesByFold.get(folded) === file, '全图可写文件不能大小写混淆。'); filesByFold.set(folded, file);
      if (!writers.has(file)) writers.set(file, []); writers.get(file).push(task.id);
    }
  }
  need([...requirements].every(id => covered.has(id)), '开发任务没有结构覆盖全部规格需求。');
  try { validateProjectFiles([...filesByFold.values()].map(path => ({ path, content: '' }))); } catch { throw error('全图可写文件超过上限或存在文件/父目录冲突。'); }
  const visiting = new Set(), ancestors = new Map();
  function visit(id) {
    if (ancestors.has(id)) return ancestors.get(id); need(!visiting.has(id), '开发任务依赖存在循环。'); need(tasks.has(id), '开发任务引用未知依赖。'); visiting.add(id);
    const result = new Set(); for (const dependency of tasks.get(id).dependsOn) { result.add(dependency); for (const ancestor of visit(dependency)) result.add(ancestor); }
    visiting.delete(id); ancestors.set(id, result); return result;
  }
  for (const id of tasks.keys()) visit(id);
  for (const ids of writers.values()) for (let first = 0; first < ids.length; first++) for (let second = first + 1; second < ids.length; second++) need(ancestors.get(ids[first]).has(ids[second]) || ancestors.get(ids[second]).has(ids[first]), '共享文件的任务必须处于明确串行依赖链，不能并行多写。');
  const result = { version: 1, binding: context.binding, specHash: context.specHash, requirements: context.spec.requirements,
    roleDefinitions: context.roleDefinitions, platform: context.platform, proposal, policyHash: engineeringPlanPolicy.hash, coverage: 'structural_only' };
  return freeze({ ...result, hash: hash(result) });
}
