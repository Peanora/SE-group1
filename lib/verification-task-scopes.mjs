import { createHash } from 'node:crypto';
import { copyBrowserScenarioData } from './browser-scenario-contract.mjs';
import { validateTaskWriteConflicts } from './task-write-validation.mjs';

const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_contract' }); };
const need = (value, message) => { if (!value) fail(message); };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = (value, max = 64) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value) && !forbidden.has(value);
const sortedJSON = value => JSON.stringify(order(value));
const order = value => Array.isArray(value) ? value.map(order) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, order(value[key])])) : value;
const hash = value => createHash('sha256').update(sortedJSON(value)).digest('hex');
const snapshot = raw => { try { return copyBrowserScenarioData(raw); } catch { fail('逐任务验收只接受有界纯JSON数据。'); } };
function ids(value, label, { max = 100, nonempty = true, length = 64 } = {}) {
  need(Array.isArray(value) && (!nonempty || value.length > 0) && value.length <= max && new Set(value).size === value.length && value.every(item => identifier(item, length)), `${label}必须是唯一的有界编号数组。`);
  return value;
}

/** Data validation only: this module never grants approval or a compiled brand. */
export function inspectVerificationTasks(rawTasks, requirements) {
  const tasks = snapshot(rawTasks);
  need(Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 1000, '逐任务验收必须提供完整的当前任务集合。');
  const known = new Set(requirements), seen = new Set(), covered = new Set();
  for (const task of tasks) {
    need(task && typeof task === 'object' && !Array.isArray(task) && identifier(task.id, 128) && !seen.has(task.id), '开发任务编号无效或重复。'); seen.add(task.id);
    ids(task.requirementIds, '任务需求'); need(task.requirementIds.every(id => known.has(id)), '开发任务引用未知需求。'); task.requirementIds.forEach(id => covered.add(id));
    ids(task.dependsOn, '任务依赖', { max: 1000, nonempty: false, length: 128 });
    need(Array.isArray(task.writePaths) && task.writePaths.length > 0 && task.writePaths.length <= 60, '逐任务验收要求每个任务有精确的非空writePaths。');
  }
  need([...known].every(id => covered.has(id)), '当前任务集合没有覆盖全部批准需求。');
  try { validateTaskWriteConflicts(tasks); } catch { fail('开发任务的依赖或可写文件范围无效、冲突或无序。'); }
  return { tasks, taskSetHash: hash(tasks) };
}

/** Bind every task to independently selected observations in the approved parent. */
export function normalizeVerificationTaskScopes({ taskScopes, tasks, steps, browser, requirements }) {
  const data = snapshot(taskScopes), taskSet = inspectVerificationTasks(tasks, requirements);
  need(Array.isArray(data) && data.length === taskSet.tasks.length, '验收分组必须逐一匹配全部当前开发任务。');
  need(browser && Array.isArray(browser.steps), '逐任务验收必须包含联合HTTP与浏览器定义。');
  const http = new Map(steps.map(step => [step.id, step])), web = new Map(browser.steps.map(step => [step.id, step]));
  const scopes = new Map();
  for (const scope of data) {
    need(scope && typeof scope === 'object' && !Array.isArray(scope) && Object.keys(scope).length === 3 && ['taskId', 'httpStepIds', 'browserStepIds'].every(key => Object.hasOwn(scope, key)), '验收分组字段无效。');
    need(identifier(scope.taskId, 128) && !scopes.has(scope.taskId), '验收分组任务编号无效或重复。');
    ids(scope.httpStepIds, 'HTTP分组步骤', { max: 40 }); ids(scope.browserStepIds, '浏览器分组步骤', { max: 60 });
    need(scope.httpStepIds.every(id => http.has(id)) && scope.browserStepIds.every(id => web.has(id)), '验收分组引用未知步骤。');
    scopes.set(scope.taskId, scope);
  }
  const normalized = taskSet.tasks.map(task => {
    const scope = scopes.get(task.id); need(scope, '验收分组缺少当前任务或包含其它任务。');
    const httpCoverage = new Set(scope.httpStepIds.flatMap(id => ['request', 'concurrent'].includes(http.get(id).type) ? http.get(id).requirementIds : []));
    const browserCoverage = new Set(scope.browserStepIds.flatMap(id => ['visible', 'text', 'value', 'count', 'createWithDelayedLoad'].includes(web.get(id).op) ? web.get(id).requirementIds : []));
    need(task.requirementIds.every(id => httpCoverage.has(id) && browserCoverage.has(id)), '每任务的全部需求必须分别由直接选择的HTTP和浏览器断言覆盖，不能仅以准备步骤或依赖闭包代替。');
    return { taskId: task.id, httpStepIds: steps.filter(step => scope.httpStepIds.includes(step.id)).map(step => step.id), browserStepIds: browser.steps.filter(step => scope.browserStepIds.includes(step.id)).map(step => step.id) };
  });
  return { taskScopes: normalized, taskSetHash: taskSet.taskSetHash };
}

/** Derive only unchanged parent steps; the caller must separately own authority. */
export function deriveVerificationTaskScope({ manifest, taskId, tasks }) {
  need(identifier(taskId, 128), '派生任务编号无效。');
  const taskSet = inspectVerificationTasks(tasks, manifest.requirements);
  need(taskSet.taskSetHash === manifest.taskSetHash, '完整开发任务集合与批准版本不同。');
  const task = taskSet.tasks.find(item => item.id === taskId), scope = manifest.taskScopes?.find(item => item.taskId === taskId);
  need(task && scope, '批准清单没有该开发任务的验收分组。');
  const httpById = new Map(manifest.steps.map(step => [step.id, step])), selected = new Set();
  const include = id => { if (selected.has(id)) return; const step = httpById.get(id); need(step, '派生HTTP步骤失去父归属。'); selected.add(id); step.dependsOn.forEach(include); };
  scope.httpStepIds.forEach(include);
  const steps = manifest.steps.filter(step => selected.has(step.id));
  const lastBySession = new Map();
  manifest.browser.steps.forEach((step, index) => { if (scope.browserStepIds.includes(step.id) && step.op !== 'createWithDelayedLoad') lastBySession.set(step.session, index); });
  const browserSteps = manifest.browser.steps.filter((step, index) => step.op === 'createWithDelayedLoad' ? scope.browserStepIds.includes(step.id) : lastBySession.has(step.session) && index <= lastBySession.get(step.session));
  const usedSessions = new Set(browserSteps.map(step => step.session));
  const browser = { ...manifest.browser, sessions: manifest.browser.sessions.filter(session => usedSessions.has(session)), steps: browserSteps };
  const required = [...new Set([...steps, ...browserSteps].flatMap(step => step.requirementIds))].sort();
  return { steps, browser, requirements: required,
    checks: manifest.checks.filter(check => check.stepId === null || selected.has(check.stepId)),
    executionScope: { kind: 'task', parentHash: manifest.manifestHash, taskId, taskDefinitionHash: hash(task) } };
}
