import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertCompiledManifest, isTaskCompiledManifest } from './verification-contract.mjs';
import { isPlannedWebTaskAccepted } from './planned-web-executor.mjs';
import { inspectPlannedSource, assertPlannedSource } from './planned-source.mjs';
import { assertPlannedTaskSeed, createTaskRunDirectory } from './planned-task-base.mjs';
import { readProjectFiles, validateProjectFiles } from './project-files.mjs';
import { verifyWebShell } from './web-delivery.mjs';
import { minimalEnv, runProcess } from './managed-process.mjs';
import { copyBrowserScenarioData } from './browser-scenario-contract.mjs';

const mergedSources = new WeakMap(), keys = ['projectId', 'runId', 'specRevision', 'planRevision'];
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sourceHash = value => digest(validateProjectFiles(value));
const need = value => { if (!value) throw new Error('并行任务的基础、独立验收、可写范围或实际Git合并无法完整核对。'); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/** Code provenance only; this capability never grants task or software acceptance. */
export function assertPlannedMergedSource(handle, binding, writablePaths) {
  const source = mergedSources.get(handle); need(source && keys.every(key => source.provenance[key] === binding?.[key]));
  const allowed = new Set(writablePaths); need(source.files.every(file => allowed.has(file.path))); return source;
}

export function resolvePlannedTaskBase(handle, binding, writablePaths) {
  try { return assertPlannedSource(handle, binding, writablePaths); } catch {}
  try { return assertPlannedTaskSeed(handle, binding); } catch {}
  return assertPlannedMergedSource(handle, binding, writablePaths);
}

/** Integrator owns all Git writes. Every input is an original accepted task, on one exact common base. */
export async function mergePlannedTaskCandidates({ rootDir, sourceRootDir, binding, manifest, task, base, candidates, signal, timeoutMs = 60000, assertCurrent } = {}) {
  need(typeof assertCurrent === 'function' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000 && (signal === undefined || signal instanceof AbortSignal));
  const identity = Object.fromEntries(keys.map(key => [key, binding?.[key]])), confirmed = copyBrowserScenarioData(task, 96000);
  const allowed = [...new Set(confirmed.tasks.flatMap(item => item.writePaths ?? item.suggestedFiles))];
  validateProjectFiles(allowed.map(path => ({ path, content: '' })));
  need(Array.isArray(candidates) && candidates.length >= 1 && candidates.length <= 2);
  const inputs = candidates.map(item => ({ record: item.record, manifest: item.manifest }));
  need(new Set(inputs.map(item => item.record?.taskId)).size === inputs.length);
  const controller = new AbortController(), abort = () => controller.abort(), deadline = Date.now() + timeoutMs, timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  let workspace, directory;
  const current = () => {
    need(!controller.signal.aborted && Date.now() < deadline); assertCompiledManifest(manifest, identity); need(!isTaskCompiledManifest(manifest));
    const live = assertCurrent(structuredClone(identity)); need(live !== false && (!live || typeof live.then !== 'function'));
  };
  const commands = [];
  const git = async args => {
    current(); const result = await runProcess('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], {
      cwd: workspace, signal: controller.signal, timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())), maxOutputBytes: 2 * 1024 * 1024,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' },
    }); commands.push({ args, ...result });
    if (result.terminationConfirmed !== true) throw Object.assign(new Error('集成Git进程停止尚未确认。'), { reconciliationRequired: true, result, workspace });
    current(); need(result.exitCode === 0 && !result.stopReason && !result.truncated); return result.stdout;
  };
  try {
    current(); need(digest(JSON.stringify(canonical(confirmed.tasks))) === manifest.taskSetHash);
    const parent = resolvePlannedTaskBase(base, identity, allowed), usedPaths = new Set(), expected = new Map(parent.files.map(file => [file.path, file.content]));
    const sources = [], findings = new Map((parent.previousIssues ?? []).map(item => [item.id, item])), byId = new Map(confirmed.tasks.map(item => [item.id, item]));
    for (const input of inputs) {
      current(); const record = input.record, definition = input.manifest, item = byId.get(record?.taskId);
      need(item && isTaskCompiledManifest(definition) && definition.executionScope.parentHash === manifest.manifestHash
        && record.baseCommit === parent.provenance.sourceCommit && isPlannedWebTaskAccepted(record, definition) && keys.every(key => record[key] === identity[key]));
      const writable = new Set(item.writePaths ?? item.suggestedFiles);
      need(record.taskExecution?.taskId === item.id && digest([...writable].sort()) === digest([...record.writablePaths].sort()));
      for (const name of writable) { need(!usedPaths.has(name)); usedPaths.add(name); }
      const inspected = await inspectPlannedSource({ rootDir: sourceRootDir, reportPath: record.reportPath, expectedRecord: record, binding: identity, writablePaths: allowed, signal: controller.signal, timeoutMs: Math.max(1, Math.min(60000, deadline - Date.now())) });
      const source = assertPlannedSource(inspected, identity, allowed), actual = new Map(source.files.map(file => [file.path, file.content]));
      for (const file of parent.files) need(actual.has(file.path) && (writable.has(file.path) || actual.get(file.path) === file.content));
      for (const file of source.files) {
        if (file.content === parent.files.find(prior => prior.path === file.path)?.content) continue;
        need(writable.has(file.path)); expected.set(file.path, file.content);
      }
      for (const issue of source.previousIssues ?? []) { if (findings.has(issue.id)) need(digest(findings.get(issue.id)) === digest(issue)); else findings.set(issue.id, issue); }
      sources.push({ taskId: item.id, writablePaths: [...writable], provenance: source.provenance });
    }
    const selectedIds = new Set(sources.map(source => source.taskId));
    const independent = (id, visited = new Set()) => { if (visited.has(id)) return; visited.add(id); for (const dependency of byId.get(id).dependsOn) { need(!selectedIds.has(dependency)); independent(dependency, visited); } };
    sources.forEach(source => independent(source.taskId));
    need(findings.size <= 20); current();
    directory = await createTaskRunDirectory(rootDir); workspace = path.join(directory, 'workspace');
    // Git alone creates the destination, so cloning never reuses another worker's directory.
    const parentWorkspace = path.dirname(workspace); workspace = parentWorkspace;
    await git(['clone', '--no-local', '--no-hardlinks', '--', parent.provenance.sourceWorkspace, 'workspace']); workspace = path.join(parentWorkspace, 'workspace');
    need((await git(['rev-parse', 'HEAD'])).trim() === parent.provenance.sourceCommit && sourceHash(await readProjectFiles(workspace)) === parent.provenance.sourceHash);
    const shellHash = (await verifyWebShell({ workspace })).hash;
    for (const source of sources) {
      await git(['fetch', '--no-tags', '--', source.provenance.sourceWorkspace, source.provenance.sourceCommit]);
      need((await git(['rev-parse', 'FETCH_HEAD'])).trim() === source.provenance.sourceCommit);
      await git(['merge-base', '--is-ancestor', parent.provenance.sourceCommit, source.provenance.sourceCommit]);
      await git(['-c', 'user.name=Taskflow', '-c', 'user.email=taskflow@localhost', 'merge', '--no-ff', '--no-edit', '-m', `integrate: accepted task ${source.taskId}`, source.provenance.sourceCommit]);
    }
    const commit = (await git(['rev-parse', 'HEAD'])).trim(), files = await readProjectFiles(workspace);
    need(sourceHash(files) === sourceHash([...expected].map(([path, content]) => ({ path, content }))) && (await verifyWebShell({ workspace })).hash === shellHash
      && !(await git(['status', '--porcelain', '--untracked-files=all'])).trim());
    current(); const record = { version: 1, profileId: 'planned-task-merge-v1', id: randomUUID(), ...identity, manifestHash: manifest.manifestHash, taskSetHash: manifest.taskSetHash,
      workspace, base: parent.provenance, sources, candidateCommit: commit, sourceHash: sourceHash(files), shellHash, gitCommands: commands, createdAt: new Date().toISOString(),
      taskAccepted: false, notice: '这里只复用已核对代码并记录实际合并；不继承任务、测试、Review或软件验收通过。' };
    const filename = path.join(directory, 'merge-source.json'), bytes = JSON.stringify(record, null, 2), temp = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await rename(temp, filename); current(); need((await readFile(filename)).equals(Buffer.from(bytes)));
    const handle = Object.freeze({ kind: 'owned_planned_task_merge', id: randomUUID() });
    mergedSources.set(handle, freeze({ files, provenance: { ...identity, sourceExecutionId: record.id, sourceRunId: identity.runId, sourceCommit: commit, sourceHash: record.sourceHash,
      sourceWorkspace: workspace, sourceReportPath: filename, sourceReportHash: digest(bytes), sourceKind: 'task_merge',
      sourceModelReceiptHashes: [...new Set([...(parent.provenance.sourceModelReceiptHashes ?? []), ...sources.flatMap(source => source.provenance.sourceModelReceiptHashes)])] },
      previousIssues: [...findings.values()], previousFailures: {} }));
    return handle;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
