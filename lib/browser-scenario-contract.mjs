import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fail = () => { throw Object.assign(new Error('浏览器声明式清单结构、路径或预算无效。'), { code: 'invalid_browser_scenario' }); };
const need = value => { if (!value) fail(); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = value => { need(typeof value === 'string' && ID.test(value) && !reserved.has(value)); return value; };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/** No accessors, inherited capabilities, toJSON, sparse arrays or mutable caller data. */
export function copyBrowserScenarioData(raw, maxBytes = 256 * 1024, limits = {}) {
  need(limits && Object.getPrototypeOf(limits) === Object.prototype && Reflect.ownKeys(limits).every(key => key === 'maxNodes'));
  const limit = Object.getOwnPropertyDescriptor(limits, 'maxNodes');
  need(!limit || limit.enumerable && Object.hasOwn(limit, 'value'));
  const maxNodes = limit ? limit.value : 25000;
  need(Number.isSafeInteger(maxNodes) && maxNodes >= 25000 && maxNodes <= 250000);
  let nodes = 0, bytes = 0; const ancestors = new Set();
  const walk = (value, depth) => {
    need(++nodes <= maxNodes && depth <= 24);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); need(value.isWellFormed() && bytes <= maxBytes); return value; }
    if (typeof value === 'number') { need(Number.isFinite(value)); return value; }
    const array = Array.isArray(value);
    need(value && typeof value === 'object' && Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype) && !ancestors.has(value));
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    need(keys.length <= 25000 && keys.every(key => typeof key === 'string' && (array && key === 'length' || !reserved.has(key) && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value'))));
    if (array) need(value.length <= 2000 && keys.length === value.length + 1 && keys.every(key => key === 'length' || /^(?:0|[1-9][0-9]*)$/u.test(key) && +key < value.length));
    ancestors.add(value); const result = array ? [] : {};
    for (const key of keys) { if (array && key === 'length') continue; bytes += Buffer.byteLength(key); need(bytes <= maxBytes); result[key] = walk(descriptors[key].value, depth + 1); }
    ancestors.delete(value); return result;
  };
  const value = walk(raw, 0); need(Buffer.byteLength(JSON.stringify(value)) <= maxBytes); return value;
}
function fields(value, required, optional = []) {
  need(value && typeof value === 'object' && !Array.isArray(value));
  need(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)));
}
function applicationPath(value) {
  need(typeof value === 'string' && value.length >= 1 && value.length <= 2048 && value.startsWith('/') && !value.startsWith('//') && !/[\\%:#\s\x00-\x1f\x7f]/u.test(value));
  need(!value.split(/[/?&=]/u).some(part => part === '.' || part === '..'));
  const url = new URL(value, 'http://browser.invalid'); need(url.origin === 'http://browser.invalid' && url.pathname + url.search === value);
}
export function normalizeBrowserScenario(raw, requirements) {
  const body = copyBrowserScenarioData(raw), known = copyBrowserScenarioData(requirements, 16384);
  need(Array.isArray(known) && known.length >= 1 && known.length <= 100 && new Set(known).size === known.length); known.forEach(identifier);
  fields(body, ['version', 'sessions', 'steps'], ['limits']); need(body.version === 1);
  need(Array.isArray(body.sessions) && body.sessions.length >= 1 && body.sessions.length <= 4 && new Set(body.sessions).size === body.sessions.length); body.sessions.forEach(identifier);
  need(Array.isArray(body.steps) && body.steps.length >= 1 && body.steps.length <= 60);
  const ids = new Set(), started = new Set(), used = new Set(); let assertions = 0;
  for (const step of body.steps) {
    need(step && ['goto', 'fill', 'click', 'visible', 'text', 'value', 'count', 'createWithDelayedLoad'].includes(step.op));
    const race = step.op === 'createWithDelayedLoad';
    const required = ['id', 'session', 'requirementIds', 'op', ...(race ? ['path', 'loadPath', 'inputTestId', 'submitTestId', 'listTestId', 'countTestId', 'value', 'expectedCount'] : [...(step.op === 'goto' ? ['path'] : ['testId']), ...(['goto', 'click'].includes(step.op) ? [] : ['value'])])];
    fields(step, required); identifier(step.id); need(step.id !== 'GUARD' && !ids.has(step.id)); ids.add(step.id); need(body.sessions.includes(step.session));
    used.add(step.session); if (!race && !started.has(step.session)) { need(step.op === 'goto'); started.add(step.session); }
    need(Array.isArray(step.requirementIds) && step.requirementIds.length >= 1 && step.requirementIds.length <= 100 && new Set(step.requirementIds).size === step.requirementIds.length && step.requirementIds.every(value => known.includes(value)));
    if (step.op === 'goto' || race) applicationPath(step.path); else identifier(step.testId);
    if (race) {
      applicationPath(step.loadPath); const selectors = ['inputTestId', 'submitTestId', 'listTestId', 'countTestId'].map(key => identifier(step[key])); need(new Set(selectors).size === selectors.length);
      need(typeof step.value === 'string' && step.value.length > 0 && step.value.length <= 4096 && step.value === step.value.trim() && !/[\x00-\x1f\x7f]/u.test(step.value));
      need(Number.isSafeInteger(step.expectedCount) && step.expectedCount >= 1 && step.expectedCount <= 1000); assertions++;
    }
    if (step.op === 'visible') need(typeof step.value === 'boolean');
    if (step.op === 'count') need(Number.isSafeInteger(step.value) && step.value >= 0 && step.value <= 1000);
    if (['fill', 'text', 'value'].includes(step.op)) need(typeof step.value === 'string' && step.value.length <= 4096 && (step.op !== 'text' || !!step.value.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(step.value));
    if (['visible', 'text', 'value', 'count'].includes(step.op)) assertions++;
  }
  need(assertions > 0 && used.size === body.sessions.length);
  const limits = body.limits === undefined ? {} : body.limits; fields(limits, [], ['timeoutMs', 'actionTimeoutMs']);
  body.limits = { timeoutMs: limits.timeoutMs === undefined ? 60000 : limits.timeoutMs, actionTimeoutMs: limits.actionTimeoutMs === undefined ? 5000 : limits.actionTimeoutMs };
  need(Number.isSafeInteger(body.limits.timeoutMs) && body.limits.timeoutMs >= 1 && body.limits.timeoutMs <= 120000);
  need(Number.isSafeInteger(body.limits.actionTimeoutMs) && body.limits.actionTimeoutMs >= 1 && body.limits.actionTimeoutMs <= 10000);
  return freeze(body);
}
export function browserScenarioChecks(definition) {
  const body = copyBrowserScenarioData(definition), requirements = [...new Set(body.steps?.flatMap(step => step.requirementIds ?? []) ?? [])];
  const checked = normalizeBrowserScenario(body, requirements);
  return freeze([
    { id: 'BROWSER-SNAPSHOT', name: '独立源码快照与批准版本', expected: 'sourceHash与当前批准版本一致' },
    { id: 'BROWSER-ENGINE', name: '独立Edge引擎', expected: '新浏览器连接且版本可核对' },
    ...['DESKTOP', 'MOBILE'].flatMap(view => [...checked.steps.map(step => ({ id: `BROWSER-${view}-${step.id}`, name: `${view} / ${step.session} / ${step.op} / ${step.testId ?? step.path}`, expected: step.op === 'createWithDelayedLoad' ? { count: step.expectedCount, listIncludes: step.value, delayedGet: step.loadPath } : step.op === 'goto' ? step.path : step.op === 'click' ? '唯一可见控件可点击' : step.value })),
      { id: `BROWSER-${view}-GUARD`, name: `${view} / 网络、控制台与视口`, expected: '精确同源、无弹窗下载与错误、无横向溢出' }]),
    { id: 'BROWSER-FINAL', name: '源码、批准与全部进程停止', expected: '同版本、正常退出、源码未改、全部停止已确认' },
  ]);
}
export const browserScenarioPolicyHash = createHash('sha256').update(Buffer.concat([readFileSync(new URL(import.meta.url)), readFileSync(new URL('./browser-scenarios.mjs', import.meta.url)), readFileSync(new URL('./browser-create-race.mjs', import.meta.url))])).digest('hex');
