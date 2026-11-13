import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const HTTP_LIMITS = Object.freeze({ steps: 40, requests: 80, assertions: 200, captures: 32, sessions: 8, bodyBytes: 16 * 1024, responseBytes: 64 * 1024, proposalBytes: 256 * 1024, captureBytes: 4096, timeoutMs: 120000, requestTimeoutMs: 5000 });
const hash = value => createHash('sha256').update(value).digest('hex');
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const approvals = new WeakMap(), manifests = new WeakMap();
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u, variable = /^[A-Za-z][A-Za-z0-9_]{0,31}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const reject = message => { throw Object.assign(new Error(message), { code: 'invalid_contract' }); };
const requireThat = (condition, message) => { if (!condition) reject(message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const canonicalJSON = value => JSON.stringify(order(value));
function order(value) {
  if (typeof value === 'number') requireThat(Number.isFinite(value), 'JSON数值必须有限。');
  return Array.isArray(value) ? value.map(order) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, order(value[key])])) : value;
}
const validVariable = value => typeof value === 'string' && variable.test(value) && !forbidden.has(value);
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function copyData(raw, maxBytes = HTTP_LIMITS.proposalBytes) {
  const seen = new Set(); let nodes = 0;
  function walk(value, depth) {
    requireThat(++nodes <= 20000 && depth <= 16, 'JSON资料结构超过限制。');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { requireThat(Number.isFinite(value), '数值必须有限。'); return value; }
    if (typeof value === 'string') { requireThat(value.isWellFormed() && Buffer.byteLength(value) <= maxBytes, '文本无效或超过限制。'); return value; }
    requireThat((Array.isArray(value) ? Object.getPrototypeOf(value) === Array.prototype : plain(value)) && !seen.has(value), '只允许无循环的纯JSON数据。');
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireThat(Object.getOwnPropertySymbols(value).length === 0 && Object.values(descriptors).every(item => 'value' in item), 'JSON数据不能包含getter、setter或符号。');
    let result;
    if (Array.isArray(value)) {
      requireThat(value.length <= 2000 && Object.keys(value).length === value.length && Object.keys(descriptors).every(key => key === 'length' || /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length), '数组必须连续、有界且没有附加属性。');
      result = Array.from({ length: value.length }, (_, index) => walk(descriptors[index].value, depth + 1));
    } else {
      requireThat(Object.keys(descriptors).every(key => !forbidden.has(key) && descriptors[key].enumerable), 'JSON字段名称不安全。');
      result = Object.fromEntries(Object.keys(descriptors).map(key => [key, walk(descriptors[key].value, depth + 1)]));
    }
    seen.delete(value); return result;
  }
  const result = walk(raw, 0);
  requireThat(Buffer.byteLength(JSON.stringify(result)) <= maxBytes, 'JSON资料总大小超过限制。'); return result;
}
function keys(object, allowed, required = []) { requireThat(plain(object) && Object.keys(object).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(object, key)), '契约对象包含未知字段或缺少必要字段。'); }
function id(value, label = '编号') { requireThat(typeof value === 'string' && identifier.test(value) && !forbidden.has(value), `${label}无效。`); return value; }
function integer(value, min, max, label) { requireThat(Number.isSafeInteger(value) && value >= min && value <= max, `${label}无效。`); return value; }
function list(raw, label, max = 100, nonempty = true) { requireThat(Array.isArray(raw) && (!nonempty || raw.length > 0) && raw.length <= max && new Set(raw).size === raw.length, `${label}必须是唯一编号数组。`); return raw.map(item => id(item, label)); }
export function normalizeVerificationBinding(raw) {
  const value = copyData(raw, 4096);
  keys(value, ['projectId', 'runId', 'specRevision', 'planRevision'], ['projectId', 'runId', 'specRevision', 'planRevision']);
  for (const key of ['projectId', 'runId']) requireThat(typeof value[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value[key]), '项目或运行编号无效。');
  for (const key of ['specRevision', 'planRevision']) requireThat(typeof value[key] === 'string' && HASH.test(value[key]), '规格或计划版本必须是SHA256。');
  return value;
}
export function parseJsonPath(path) {
  requireThat(typeof path === 'string' && path.startsWith('$') && path.length <= 256, 'JSONPath无效。');
  const tokens = []; let offset = 1;
  while (offset < path.length) {
    const match = path.slice(offset).match(/^(?:\.([A-Za-z_][A-Za-z0-9_-]*)|\[(0|[1-9][0-9]{0,3})\])/u);
    requireThat(match && !forbidden.has(match[1]) && (match[2] === undefined || Number(match[2]) <= 1000), 'JSONPath仅支持安全字段和有界数组下标。');
    tokens.push(match[1] ?? Number(match[2])); offset += match[0].length;
    requireThat(tokens.length <= 12, 'JSONPath过深。');
  }
  return tokens;
}
export function readJsonPath(value, path) {
  for (const token of parseJsonPath(path)) {
    if (!value || typeof value !== 'object') return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, token);
    if (!descriptor) return { found: false };
    requireThat('value' in descriptor, 'JSONPath不能读取getter。'); value = descriptor.value;
  }
  return { found: true, value };
}
function pathReferences(path) {
  requireThat(typeof path === 'string' && path.length <= 2048, '请求路径必须为有界文本。');
  const references = [...path.matchAll(/\$\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu)].map(match => match[1]);
  const literal = path.replace(/\$\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu, 'variable');
  requireThat(literal.startsWith('/') && !literal.startsWith('//') && !/[\\:%#$\s\x00-\x1f\x7f{}]/u.test(literal) && !literal.split(/[/?]/u).some(segment => segment === '.' || segment === '..'), '仅允许当前应用内无歧义的相对路径。');
  return references;
}
function valueReferences(value) {
  if (Array.isArray(value)) return value.flatMap(valueReferences);
  if (!plain(value)) return [];
  if (Object.hasOwn(value, '$var')) { keys(value, ['$var'], ['$var']); requireThat(validVariable(value.$var), '变量引用无效。'); return [value.$var]; }
  return Object.values(value).flatMap(valueReferences);
}
export function resolveScenarioValue(value, variables) {
  if (Array.isArray(value)) return value.map(item => resolveScenarioValue(item, variables));
  if (!plain(value)) return value;
  if (Object.hasOwn(value, '$var')) { requireThat(validVariable(value.$var), '变量引用无效。'); requireThat(Object.hasOwn(variables, value.$var), '所需捕获变量不可用。'); return variables[value.$var]; }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveScenarioValue(item, variables)]));
}
export function resolveScenarioPath(path, variables) {
  pathReferences(path);
  const resolved = path.replace(/\$\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu, (_, name) => {
    requireThat(Object.hasOwn(variables, name), '所需URL变量不可用。'); return encodeURIComponent(String(variables[name]));
  });
  requireThat(Buffer.byteLength(resolved) <= 4096 && !resolved.split(/[/?]/u).some(segment => segment === '.' || segment === '..'), '展开后的URL越界或超限。'); return resolved;
}
export const verificationPolicyHash = hash(Buffer.concat([readFileSync(new URL(import.meta.url)), readFileSync(new URL('./http-scenarios.mjs', import.meta.url))]));
function inspect({ proposal, requirements, binding }) {
  const data = copyData(proposal), version = normalizeVerificationBinding(binding);
  const required = list(copyData(requirements, 8192), '需求编号', 100).sort();
  keys(data, ['version', 'id', 'name', 'sessions', 'steps', 'limits'], ['version', 'id', 'name', 'sessions', 'steps']);
  requireThat(data.version === 1, '不支持的验收DSL版本。'); id(data.id); requireThat(typeof data.name === 'string' && data.name.trim() && data.name.length <= 200, '清单名称无效。');
  data.sessions = list(data.sessions, '会话编号', HTTP_LIMITS.sessions, false);
  requireThat(Array.isArray(data.steps) && data.steps.length > 0 && data.steps.length <= HTTP_LIMITS.steps, '步骤数超过限制或为空。');
  const limits = data.limits ?? {}; keys(limits, ['timeoutMs', 'requestTimeoutMs']);
  data.limits = { timeoutMs: integer(limits.timeoutMs ?? 60000, 1, HTTP_LIMITS.timeoutMs, '总时长'), requestTimeoutMs: integer(limits.requestTimeoutMs ?? 5000, 1, HTTP_LIMITS.requestTimeoutMs, '请求时长') };
  const steps = new Map(), covered = new Set(), checks = [], checkIds = new Set(), captures = new Map(), refs = [];
  let requestCount = 0;
  const check = (checkId, name, stepId) => { requireThat(typeof checkId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(checkId), '断言编号无效。'); requireThat(!checkIds.has(checkId), '断言编号重复。'); checkIds.add(checkId); checks.push({ id: checkId, name, stepId }); };
  for (const checkId of ['SYS_SNAPSHOT', 'SYS_START', 'SYS_FINAL']) checkIds.add(checkId);
  const request = (value, step, concurrent = false) => {
    keys(value, ['id', 'method', 'path', 'session', 'body', 'assertions', 'captures'], ['id', 'method', 'path', 'assertions']); id(value.id);
    requireThat(++requestCount <= HTTP_LIMITS.requests && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(value.method), '请求数量或方法无效。');
    if (value.session !== undefined) requireThat(data.sessions.includes(value.session), '请求引用未知会话。');
    if (Object.hasOwn(value, 'body')) requireThat(!['GET', 'HEAD'].includes(value.method) && Buffer.byteLength(JSON.stringify(value.body)) <= HTTP_LIMITS.bodyBytes, '请求正文不允许或超限。');
    const references = [...pathReferences(value.path), ...valueReferences(value.body)];
    requireThat(Array.isArray(value.assertions) && value.assertions.length > 0 && value.assertions.length <= 20, '请求必须有非空有界断言。');
    for (const assertion of value.assertions) {
      keys(assertion, ['id', 'op', 'path', 'value'], ['id', 'op']);
      requireThat(!/^(?:SYS_|CAP_|GROUP_|RESTART_)/u.test(assertion.id ?? ''), '断言编号使用了保留前缀。');
      if (assertion.op === 'status') { keys(assertion, ['id', 'op', 'value'], ['value']); integer(assertion.value, 200, 599, 'HTTP状态'); }
      else if (assertion.op === 'statusIn') { keys(assertion, ['id', 'op', 'value'], ['value']); requireThat(Array.isArray(assertion.value) && assertion.value.length > 0 && assertion.value.length <= 10 && new Set(assertion.value).size === assertion.value.length, 'HTTP状态集合无效。'); assertion.value.forEach(value => integer(value, 200, 599, 'HTTP状态')); }
      else if (['jsonEquals', 'jsonExists', 'jsonLength'].includes(assertion.op)) {
        parseJsonPath(assertion.path);
        if (assertion.op === 'jsonExists') { keys(assertion, ['id', 'op', 'path'], ['path']); }
        else { requireThat(Object.hasOwn(assertion, 'value'), 'JSON断言缺少期望值。'); if (assertion.op === 'jsonLength') integer(assertion.value, 0, 1000, 'JSON长度'); else references.push(...valueReferences(assertion.value)); }
      } else if (assertion.op === 'textIncludes') { keys(assertion, ['id', 'op', 'value'], ['value']); requireThat(typeof assertion.value === 'string' && assertion.value && assertion.value.length <= 1000, '文本断言无效。'); }
      else reject('未知断言操作。');
      check(assertion.id, `${value.id}: ${assertion.op}`, step.id);
    }
    const items = value.captures ?? [];
    requireThat(Array.isArray(items) && (!concurrent || items.length === 0), '并发请求不允许捕获变量。');
    for (const capture of items) {
      keys(capture, ['name', 'path'], ['name', 'path']); requireThat(validVariable(capture.name) && !captures.has(capture.name), '捕获变量无效或重复。'); parseJsonPath(capture.path);
      requireThat(captures.size < HTTP_LIMITS.captures, '捕获变量过多。'); captures.set(capture.name, step.id); check(`CAP_${step.id}_${capture.name}`, '捕获JSON变量', step.id);
    }
    refs.push({ stepId: step.id, references });
  };
  for (const step of data.steps) {
    keys(step, ['id', 'type', 'dependsOn', 'requirementIds', 'request', 'requests', 'expectedStatuses'], ['id', 'type', 'dependsOn', 'requirementIds']); id(step.id); requireThat(!steps.has(step.id), '步骤编号重复。'); steps.set(step.id, step);
    step.dependsOn = list(step.dependsOn, '依赖编号', HTTP_LIMITS.steps, false);
    step.requirementIds = list(step.requirementIds, '覆盖需求', 100); for (const requirement of step.requirementIds) { requireThat(required.includes(requirement), '覆盖了未知需求。'); covered.add(requirement); }
    if (step.type === 'request') { keys(step, ['id', 'type', 'dependsOn', 'requirementIds', 'request'], ['request']); request(step.request, step); }
    else if (step.type === 'concurrent') {
      keys(step, ['id', 'type', 'dependsOn', 'requirementIds', 'requests', 'expectedStatuses'], ['requests', 'expectedStatuses']);
      requireThat(Array.isArray(step.requests) && step.requests.length === 2 && step.requests.every(value => plain(value) && data.sessions.includes(value.session)) && step.requests[0].session !== step.requests[1].session && step.requests[0].id !== step.requests[1].id, '并发组必须为两个不同会话的请求。');
      requireThat(Array.isArray(step.expectedStatuses) && step.expectedStatuses.length === 2, '并发组需要两个预期状态。'); step.expectedStatuses.forEach(value => integer(value, 200, 599, '并发状态')); step.expectedStatuses.sort((a, b) => a - b);
      step.requests.forEach(value => request(value, step, true)); check(`GROUP_${step.id}`, '并发响应状态多重集', step.id);
    } else if (step.type === 'restart') { keys(step, ['id', 'type', 'dependsOn', 'requirementIds']); check(`RESTART_${step.id}`, '确认停止并重启同数据库', step.id); }
    else reject('未知步骤类型。');
  }
  requireThat(covered.size === required.length && required.every(value => covered.has(value)), '清单没有结构性覆盖全部需求。');
  requireThat(checks.length + 3 <= HTTP_LIMITS.assertions, '断言和捕获检查总数超限。');
  const visiting = new Set(), ancestors = new Map();
  const visit = step => {
    requireThat(!visiting.has(step.id), '步骤依赖存在循环。'); if (ancestors.has(step.id)) return ancestors.get(step.id);
    visiting.add(step.id); const found = new Set();
    for (const dependency of step.dependsOn) { requireThat(steps.has(dependency), '步骤引用未知依赖。'); found.add(dependency); for (const prior of visit(steps.get(dependency))) found.add(prior); }
    visiting.delete(step.id); ancestors.set(step.id, found); return found;
  };
  for (const [index, step] of data.steps.entries()) { visit(step); requireThat(step.dependsOn.every(value => data.steps.findIndex(item => item.id === value) < index), '顺序步骤不能依赖后继。'); }
  for (const { stepId, references } of refs) for (const name of references) requireThat(captures.has(name) && ancestors.get(stepId).has(captures.get(name)), '变量必须来自已依赖的前序捕获。');
  const body = { ...data, binding: version, requirements: required, policyHash: verificationPolicyHash };
  const manifestHash = hash(canonicalJSON(body));
  return { ...body, manifestHash, checks: [{ id: 'SYS_SNAPSHOT', name: '独立源码快照', stepId: null }, { id: 'SYS_START', name: '受控应用启动', stepId: null }, ...checks, { id: 'SYS_FINAL', name: '源码版本及全部停止确认', stepId: null }] };
}
function currentApproval(approval) {
  const record = approvals.get(approval);
  requireThat(record && !record.revoked && record.state.current === approval, '批准不是当前可信控制器记录。'); return record;
}
/** Pure structural inspection only. This definition has no approval or manifest brand. */
export function inspectVerificationProposal(input) { return inspect(input); }
export function createVerificationControl() {
  const states = new Map();
  return Object.freeze({
    approve(input) {
      const manifest = inspect(input), key = canonicalJSON(manifest.binding), state = states.get(key) ?? { started: false, current: null };
      requireThat(!state.started, '编码开始后不能替换该版本的验收清单。');
      const existing = state.current && approvals.get(state.current);
      if (existing && !existing.revoked && state.current.manifestHash === manifest.manifestHash) return state.current;
      const feedback = input.feedback ?? ''; requireThat(typeof feedback === 'string' && feedback.length <= 5000, '批准依据必须是有界文本。');
      const approval = freeze({ id: randomUUID(), phase: 'before_coding', approvedAt: new Date().toISOString(), ...manifest.binding, manifestHash: manifest.manifestHash, feedback });
      state.current = approval; states.set(key, state); approvals.set(approval, { state, revoked: false }); return approval;
    },
    beginCoding(approval) { const record = currentApproval(approval); requireThat(states.get(canonicalJSON(normalizeVerificationBinding({ projectId: approval.projectId, runId: approval.runId, specRevision: approval.specRevision, planRevision: approval.planRevision }))) === record.state, '批准不属于该控制器。'); record.state.started = true; return { manifestHash: approval.manifestHash, phase: 'coding' }; },
    revoke(approval) { const record = currentApproval(approval); requireThat([...states.values()].includes(record.state), '批准不属于该控制器。'); record.revoked = true; },
  });
}
export function compileManifest(input) {
  const record = currentApproval(input.approval), data = inspect(input);
  requireThat(input.approval.manifestHash === data.manifestHash, '批准哈希或规格/计划版本已变化。');
  const result = freeze(data); manifests.set(result, { approval: input.approval, record }); return result;
}
export function assertCompiledManifest(manifest, binding) {
  const entry = manifests.get(manifest); requireThat(entry, '必须使用可信compileManifest生成的清单。');
  const record = currentApproval(entry.approval);
  requireThat(record.state.started, '可信控制器尚未进入编码阶段。');
  requireThat(canonicalJSON(normalizeVerificationBinding(binding)) === canonicalJSON(manifest.binding), '执行与批准清单的规格/计划版本不同。'); return manifest;
}
export function compiledManifestDefinition(manifest) {
  requireThat(manifests.has(manifest), '清单不是可信compileManifest产物。'); return manifest;
}
