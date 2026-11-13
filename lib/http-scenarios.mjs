import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { startWebRuntime } from './web-runtime.mjs';
import { filterWebResponseHeaders } from './web-protocol.mjs';
import { assertCompiledManifest, compiledManifestDefinition, canonicalJSON, HTTP_LIMITS, readJsonPath, resolveScenarioPath, resolveScenarioValue } from './verification-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const requireThat = (condition, message) => { if (!condition) fail('invalid_scenario', message); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function directoryChain(directory) {
  const absolute = path.resolve(directory), anchor = path.parse(absolute).root; let current = anchor;
  for (const part of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let info;
    try { info = await lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(current, { mode: 0o700 }); info = await lstat(current); }
    requireThat(info.isDirectory() && !info.isSymbolicLink() && samePath(await realpath(current), current), '输出目录及父链不允许链接。');
  }
}
function executionBinding(binding) {
  requireThat(binding && typeof binding === 'object', '缺少执行绑定。');
  for (const key of ['taskId', 'attemptId']) requireThat(typeof binding[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(binding[key]), '任务或尝试编号无效。');
  requireThat(typeof binding.candidateCommit === 'string' && /^[a-f0-9]{40}$/u.test(binding.candidateCommit), '候选提交无效。');
  return Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision', 'taskId', 'attemptId', 'candidateCommit'].map(key => [key, binding[key]]));
}

/** Production entry has no caller-supplied transport, factory, command, headers or SQL. */
export async function runHttpScenarios({ manifest, files, rootDir, binding, signal, executable = process.env.EXECUTION_SANDBOX_EXE, timeoutMs, onEvent = () => {} } = {}) {
  const result = { status: 'error', binding: null, sourceHash: null, manifestHash: null, policyHash: null, checks: [], processes: [], workspace: null, terminationConfirmed: false, error: null, coverage: 'structural_only' };
  let checked, runtime, timer, timedOut = false, uncertain = false, halted = false, timeBudget, started = Date.now();
  const controller = new AbortController(), validSignal = signal instanceof AbortSignal;
  const variables = Object.create(null), jars = new Map(), completed = new Map(), observations = new Map();
  const emit = event => { try { if (typeof onEvent === 'function') onEvent(event); } catch { /* Observers cannot grant a pass. */ } };
  const baseBinding = () => Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, binding?.[key]]));
  const guard = () => {
    if (uncertain) fail('reconciliation_required', '旧进程停止尚未确认，禁止继续。');
    if (controller.signal.aborted) fail(timedOut ? 'timed_out' : 'cancelled', timedOut ? '验收预算已耗尽。' : '验收已取消。');
    if (halted) fail('halted', '应用传输失败，后续检查未执行。');
    assertCompiledManifest(manifest, baseBinding());
  };
  const abort = () => controller.abort();
  const record = (id, passed, actual) => {
    if (!observations.has(id)) { observations.set(id, { passed, actual }); emit({ phase: 'check', id, passed, actual }); }
  };
  const remember = process => { if (process?.pid && !result.processes.some(item => item.pid === process.pid && item.startedAt === process.startedAt)) result.processes.push(process); };
  const stopped = process => process?.terminationConfirmed === true && process.status === 'stopped' && process.exitCode === 0 && process.stopAcknowledged === true && process.sourceUnchanged === true;
  const sourceUnchanged = async () => requireThat(hash(JSON.stringify(await readProjectFiles(result.workspace))) === result.sourceHash, '候选源码与绑定版本不一致。');
  const stop = async () => {
    if (!runtime) return;
    const current = runtime; runtime = null; let process;
    try { process = await current.stop(); } catch (error) { uncertain = true; throw error; }
    remember(process); uncertain ||= process.terminationConfirmed !== true;
    if (!stopped(process)) halted = true;
    requireThat(stopped(process), '应用未正常停止、停止未知或源码已变化。');
  };
  const launch = async () => {
    guard(); await sourceUnchanged(); guard();
    const remaining = Math.max(1, timeBudget - (Date.now() - started));
    try {
      runtime = await startWebRuntime({ workspace: result.workspace, executable, signal: controller.signal, timeoutMs: remaining, requestTimeoutMs: Math.min(checked.limits.requestTimeoutMs, remaining), maxOutputBytes: 4 * 1024 * 1024, onEvent: event => emit({ phase: 'runtime', ...event }) });
    } catch (error) { remember(error.result); uncertain ||= error.reconciliationRequired === true || error.result?.terminationConfirmed === false; throw error; }
  };
  const waitResponse = async request => {
    guard(); let requestTimer, rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = () => reject(Object.assign(new Error('验收请求已停止。'), { code: timedOut ? 'timed_out' : 'cancelled' })); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
    try {
      requestTimer = setTimeout(() => { timedOut = true; controller.abort(); }, checked.limits.requestTimeoutMs);
      return await Promise.race([Promise.resolve().then(() => { guard(); return runtime.request(request); }), interrupted]);
    } finally { clearTimeout(requestTimer); controller.signal.removeEventListener('abort', rejectAbort); }
  };
  function cookieJar(session) { if (!jars.has(session)) jars.set(session, new Map()); return jars.get(session); }
  function outgoingCookies(session, route) {
    const pathname = route.split('?')[0], values = [];
    for (const [name, cookie] of cookieJar(session)) {
      if (cookie.expires <= Date.now()) { cookieJar(session).delete(name); continue; }
      if (!cookie.secure && (pathname === cookie.path || pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/'))) values.push(`${name}=${cookie.value}`);
    }
    const value = values.join('; '); requireThat(Buffer.byteLength(value) <= 8192, '会话Cookie超过限制。'); return value;
  }
  function incomingCookies(session, route, headers) {
    const jar = cookieJar(session);
    for (const line of headers['set-cookie'] ?? []) {
      const parts = line.split(';').map(value => value.trim()), index = parts[0].indexOf('=');
      const name = parts[0].slice(0, index), value = parts[0].slice(index + 1);
      requireThat(index > 0 && name.startsWith('app_') && /;\s*httponly(?:;|$)/iu.test(line) && !/[\s,\\]/u.test(value) && value.length <= 2048, '仅允许有界app_ HttpOnly Cookie。');
      const attributes = new Map(parts.slice(1).map(item => { const split = item.indexOf('='); return [item.slice(0, split < 0 ? item.length : split).toLowerCase(), split < 0 ? '' : item.slice(split + 1)]; }));
      const maxAge = attributes.get('max-age'), expires = attributes.get('expires');
      if (!value || maxAge === '0' || (expires && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= Date.now())) { jar.delete(name); continue; }
      const cookiePath = attributes.get('path') ?? (route.split('?')[0].slice(0, route.split('?')[0].lastIndexOf('/') + 1) || '/');
      requireThat(cookiePath.startsWith('/') && !cookiePath.startsWith('//') && !attributes.has('domain'), 'Cookie作用域无效。');
      jar.set(name, { value, path: cookiePath, secure: attributes.has('secure'), expires: maxAge && /^-?\d+$/u.test(maxAge) ? Date.now() + Number(maxAge) * 1000 : expires && Number.isFinite(Date.parse(expires)) ? Date.parse(expires) : Infinity });
      requireThat(jar.size <= 32, 'Cookie数量超过限制。');
    }
  }
  async function executeRequest(request, stepId) {
    let response, json, jsonValid = false, text;
    try {
      guard(); requireThat(runtime, '没有活动的应用进程。');
      const route = resolveScenarioPath(request.path, variables), body = Object.hasOwn(request, 'body') ? JSON.stringify(resolveScenarioValue(request.body, variables)) : '';
      requireThat(Buffer.byteLength(body) <= HTTP_LIMITS.bodyBytes, '变量展开后的正文超限。');
      const cookie = outgoingCookies(request.session, route);
      response = await waitResponse({ method: request.method, path: route, headers: { accept: '*/*', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body });
      guard(); requireThat(Number.isInteger(response?.status) && response.status >= 200 && response.status <= 599 && (typeof response.body === 'string' || Buffer.isBuffer(response.body)), '应用响应无效。');
      const bytes = Buffer.from(response.body); requireThat(bytes.length <= HTTP_LIMITS.responseBytes, '应用响应超过64KiB。');
      const headers = filterWebResponseHeaders(response.headers ?? {}); incomingCookies(request.session, route, headers);
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('response_error', '响应不是有效UTF-8。'); }
      if (/^application\/json(?:;|$)/iu.test(headers['content-type'] ?? '')) { try { json = JSON.parse(text); jsonValid = true; } catch { /* JSON-dependent assertions fail below. */ } }
    } catch (error) {
      halted = true;
      for (const assertion of request.assertions) record(assertion.id, false, '请求未完成、响应无效或预算已耗尽');
      return { passed: false, status: null };
    }
    let passed = true;
    for (const assertion of request.assertions) {
      let ok = false;
      try {
        guard();
        if (assertion.op === 'status') ok = response.status === assertion.value;
        else if (assertion.op === 'statusIn') ok = assertion.value.includes(response.status);
        else if (assertion.op === 'textIncludes') ok = text.includes(assertion.value);
        else {
          const selected = jsonValid ? readJsonPath(json, assertion.path) : { found: false };
          if (assertion.op === 'jsonExists') ok = selected.found;
          else if (assertion.op === 'jsonLength') ok = selected.found && (Array.isArray(selected.value) || typeof selected.value === 'string') && selected.value.length === assertion.value;
          else ok = selected.found && canonicalJSON(selected.value) === canonicalJSON(resolveScenarioValue(assertion.value, variables));
        }
      } catch { ok = false; }
      passed &&= ok; record(assertion.id, ok, ['status', 'statusIn'].includes(assertion.op) ? `HTTP ${response.status}` : ok ? '符合固定断言' : '响应未满足固定断言');
    }
    if (request.captures?.length) {
      const pending = [];
      for (const capture of request.captures) {
        let ok = passed, value;
        try {
          const selected = jsonValid ? readJsonPath(json, capture.path) : { found: false }; value = selected.value;
          ok &&= selected.found && (value === null || ['string', 'number', 'boolean'].includes(typeof value)) && Buffer.byteLength(JSON.stringify(value)) <= HTTP_LIMITS.captureBytes;
        } catch { ok = false; }
        record(`CAP_${stepId}_${capture.name}`, ok, ok ? '已捕获有界JSON标量' : '变量未捕获');
        if (ok) pending.push([capture.name, value]); else passed = false;
      }
      if (passed) for (const [name, value] of pending) variables[name] = value;
    }
    return { passed, status: response.status };
  }
  const idsForStep = step => checked.checks.filter(item => item.stepId === step.id).map(item => item.id);
  try {
    checked = compiledManifestDefinition(manifest);
    result.manifestHash = checked.manifestHash; result.policyHash = checked.policyHash;
    assertCompiledManifest(manifest, baseBinding()); result.binding = executionBinding(binding);
    requireThat(signal === undefined || validSignal, '取消信号无效。');
    timeBudget = timeoutMs ?? checked.limits.timeoutMs;
    requireThat(Number.isInteger(timeBudget) && timeBudget >= 1 && timeBudget <= checked.limits.timeoutMs && timeBudget <= HTTP_LIMITS.timeoutMs, '总运行预算无效。');
    if (validSignal) signal.addEventListener('abort', abort, { once: true }); if (validSignal && signal.aborted) abort();
    started = Date.now(); timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeBudget); guard();
    const normalized = validateProjectFiles(files); result.sourceHash = hash(JSON.stringify(normalized)); result.binding = { ...result.binding, sourceHash: result.sourceHash, manifestHash: checked.manifestHash };
    requireThat(typeof rootDir === 'string' && path.isAbsolute(rootDir) && path.resolve(rootDir) !== path.parse(rootDir).root, '必须提供可信绝对输出目录。');
    await directoryChain(rootDir); guard(); result.workspace = await mkdtemp(path.join(path.resolve(rootDir), 'http-scenarios-'));
    requireThat((await applyProjectFiles({ workspace: result.workspace, files: normalized })).sourceHash === result.sourceHash, '独立源码快照不一致。'); record('SYS_SNAPSHOT', true, '独立源码已绑定');
    await launch(); guard(); record('SYS_START', true, '受控应用已启动');
    for (const step of checked.steps) {
      let passed = false;
      try {
        guard(); requireThat(step.dependsOn.every(id => completed.get(id) === true), '前置步骤未通过。');
        if (step.type === 'request') passed = (await executeRequest(step.request, step.id)).passed;
        else if (step.type === 'concurrent') {
          const responses = await Promise.allSettled(step.requests.map(request => executeRequest(request, step.id)));
          const values = responses.map(value => value.status === 'fulfilled' ? value.value : { passed: false, status: null });
          const statuses = values.map(value => value.status).sort((a, b) => a - b);
          const groupPassed = values.every(value => value.status !== null) && canonicalJSON(statuses) === canonicalJSON(step.expectedStatuses);
          record(`GROUP_${step.id}`, groupPassed, groupPassed ? '并发状态多重集符合批准清单' : '并发状态多重集不符'); passed = groupPassed && values.every(value => value.passed);
        } else {
          await stop(); guard(); await sourceUnchanged(); await launch(); guard(); passed = true; record(`RESTART_${step.id}`, true, '旧进程确认停止后重启同一工作区数据库');
        }
      } catch { /* Fixed checks are completed as false below. */ }
      for (const checkId of idsForStep(step)) if (!observations.has(checkId)) record(checkId, false, '该断言未执行或前置步骤失败');
      completed.set(step.id, passed);
    }
  } catch { result.error = '验收清单、执行绑定或受控应用启动无效。'; }
  finally {
    try { await stop(); } catch { result.error ??= '应用停止或源码检查失败。'; }
    if (checked) {
      try { guard(); await sourceUnchanged(); requireThat(result.processes.length > 0 && result.processes.every(stopped), '进程或源码结论不完整。'); record('SYS_FINAL', true, '源码未变化且全部进程正常确认停止'); }
      catch { record('SYS_FINAL', false, '源码、批准或停止结论未满足'); }
      result.checks = checked.checks.map(item => ({ ...item, passed: observations.get(item.id)?.passed === true, expected: item.name, actual: observations.get(item.id)?.actual ?? '未执行，未获得通过结论' }));
    }
    clearTimeout(timer); if (validSignal) signal.removeEventListener('abort', abort);
    result.terminationConfirmed = result.processes.length > 0 && !uncertain && result.processes.every(item => item.terminationConfirmed === true);
    result.status = uncertain || result.processes.some(item => item.terminationConfirmed !== true) ? 'reconciliation_required' : timedOut ? 'timed_out' : validSignal && signal.aborted ? 'cancelled' : result.checks.length > 0 && result.checks.every(item => item.passed) && !result.error ? 'passed' : observations.get('SYS_START')?.passed ? 'failed' : 'error';
    if (result.status !== 'passed') result.error ??= '批准清单未全部通过；结构覆盖不等于业务语义覆盖。';
  }
  return result;
}
