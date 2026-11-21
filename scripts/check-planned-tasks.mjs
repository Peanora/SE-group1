import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as planner from '../lib/planner.mjs';
import { validateEngineeringPlan } from '../lib/engineering-plan.mjs';
import { engineeringTasks, assertEngineeringAlignment } from '../lib/engineering-planner.mjs';
import { contentRevision, planningRevision } from '../lib/planning-review.mjs';
import { createVerificationControl, compileManifest, compileTaskManifest } from '../lib/verification-contract.mjs';
import { plannedNotesTags } from '../examples/planned-notes-tags.mjs';
import { plannedNotesTagsRegression } from '../examples/planned-notes-tags-regression.mjs';
import { minimalEnv, runProcess } from '../lib/managed-process.mjs';

// This command has one paid mode. Planning/engineering/definition are explicitly
// operator fixtures in both modes; --preflight never opens a service or .env.
const fixtureConfig = { baseUrl: 'https://operator-fixture.invalid/v1', model: 'operator-fixed-planning-not-paid', apiKey: '' };
const envelope = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
const projectTask = task => Object.fromEntries(['id', 'title', 'description', 'requirementIds', 'dependsOn', 'inputs', 'outputs', 'acceptance', 'writePaths'].map(key => [key, structuredClone(task[key])]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function preflightPlannedTasks({ loadRace = false } = {}) {
  const benchmark = loadRace ? plannedNotesTagsRegression : plannedNotesTags;
  let operatorFixtureRequests = 0;
  const spec = await planner.analyzeWithModel(benchmark.requirements, benchmark.spec.title, { config: fixtureConfig,
    fetchImpl: async () => { operatorFixtureRequests++; return envelope(benchmark.spec); } });
  const specRevision = contentRevision(spec), binding = { projectId: 'notes-tags-preflight', runId: 'four-task-preflight', specRevision };
  const engineeringPlan = validateEngineeringPlan({ spec, binding, proposal: benchmark.engineeringFor(spec) }), tasks = engineeringTasks(engineeringPlan);
  const run = { id: binding.runId, projectId: binding.projectId, spec, specRevision, engineeringPlan, tasks, artifacts: [{ name: 'architecture.md', content: '公开固定四任务工程契约，仅供免费结构预检。' }] };
  assertEngineeringAlignment(run);
  const task = { title: spec.title, summary: spec.summary, goals: spec.goals, roles: spec.roles, constraints: spec.constraints, acceptanceScenarios: spec.acceptanceScenarios,
    tasks: tasks.map(projectTask), engineeringContract: { entities: engineeringPlan.proposal.entities, routes: engineeringPlan.proposal.routes, views: engineeringPlan.proposal.views, roleDefinitions: engineeringPlan.roleDefinitions } };
  const planRevision = planningRevision(run), definition = benchmark.definitionFor(spec.requirements), fullBinding = { ...binding, planRevision };
  const control = createVerificationControl(), input = { proposal: definition, requirements: spec.requirements.map(r => r.id), binding: fullBinding, tasks: task.tasks };
  const approval = control.approve({ ...input, feedback: '公开操作人固定定义，免费预检，不代表业务或模型质量验收。' }), manifest = compileManifest({ ...input, approval }); control.beginCoding(approval);
  const children = task.tasks.map(item => ({ taskId: item.id, manifest: compileTaskManifest({ manifest, taskId: item.id, tasks: task.tasks }) }));
  assert.equal(task.tasks.length, 4); assert.equal(definition.browser.sessions.length, 4); assert.ok(definition.browser.steps.length < 60);
  return { status: 'preflight_passed', planningAndDefinition: 'explicit_operator_fixtures_not_real_PM', coverage: 'structural_only', taskAccepted: false,
    actualModelCalls: 0, operatorFixtureRequests, spec, engineeringPlan, task, binding: fullBinding, definition, manifest, children };
}

async function runModelBenchmark({ loadRace = false } = {}) {
  const benchmark = loadRace ? plannedNotesTagsRegression : plannedNotesTags;
  const { createApp, loadEnv } = await import('../server.mjs');
  const { ProjectStore } = await import('../lib/store.mjs');
  const { createEngineeringModel } = await import('../lib/engineering-model.mjs');
  const { createVerificationPlanningService } = await import('../lib/verification-planning-service.mjs');
  const { verificationModelPolicy } = await import('../lib/verification-model.mjs');
  const { createWindowsSandbox } = await import('../lib/windows-sandbox.mjs');
  // Explicit --model authorization is required before loading private config.
  await loadEnv(); await preflightPlannedTasks({ loadRace });
  const output = path.resolve(import.meta.dirname, loadRace ? '../output/nt' : '../output/task-checks'); await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'notes-tags-')), dataDir = path.join(root, 'data'), serviceRoot = path.join(dataDir, 'planned-executions');
  const controller = new AbortController(), operatorName = `operator_${randomBytes(8).toString('hex')}`, operatorPassword = randomBytes(32).toString('base64url');
  let teamCookie = '', app, closing = false, stage = 'opening'; const started = Date.now(), deadline = started + 1320000;
  const totalTimer = setTimeout(() => controller.abort(), deadline - started);
  const summary = { id: randomUUID(), root, planningAndDefinition: 'explicit_operator_fixtures_not_real_PM', status: 'preparing', taskAccepted: false,
    publicBudget: { taskLimit: 4, maxCalls: 3, maxReviewCalls: 3, attemptModelCalls: 24, maxConcurrency: 2, timeoutMs: 1200000 },
    totalModelCalls: null, usage: { inputTokens: null, outputTokens: null }, monetaryCost: null, checkpoints: [], newCallsDuringRecovery: null };
  const guard = () => { if (controller.signal.aborted || Date.now() >= deadline) throw Object.assign(new Error('公开基准已取消或超过有界等待时间。'), { name: 'AbortError' }); };
  const fixturePlanner = { ...planner, getModelConfig: () => ({ configured: true, model: fixtureConfig.model }),
    analyzeWithModel: (text, name, options) => planner.analyzeWithModel(text, name, { ...options, config: fixtureConfig, fetchImpl: async () => envelope(benchmark.spec) }),
    createEngineeringModel: () => input => createEngineeringModel({ config: fixtureConfig, fetchImpl: async () => envelope(benchmark.engineeringFor(input.spec)) })(input) };
  async function open() {
    guard(); const store = await new ProjectStore(dataDir).init();
    const verification = await createVerificationPlanningService({ rootDir: path.join(dataDir, 'verification-planning'), getPlanning: (pid, rid) => store.getPersistedRun(pid, rid), getPlanningSync: (pid, rid) => store.getPersistedRun(pid, rid), config: fixtureConfig,
      dependencies: { createModel: () => async input => { const proposal = benchmark.definitionFor(input.requirements), usage = { inputTokens: 0, outputTokens: 0 };
        await input.onReceipt({ model: fixtureConfig.model, finishReason: 'stop', usage, content: JSON.stringify(proposal) }); return { proposal, model: fixtureConfig.model, usage, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' }; } } });
    // No coding/Review providers, execution kinds or core functions are replaced.
    const instance = await createApp({ store, teamEnabled: true, stepDelayMs: 0, planner: fixturePlanner, verificationPlanningService: verification, plannedExecutionTimeoutMs: 1200000 });
    try {
      await new Promise((resolve, reject) => { instance.server.once('error', reject); instance.server.listen(0, '127.0.0.1', resolve); }); guard();
      instance.origin = `http://127.0.0.1:${instance.server.address().port}`;
      instance.api = async (url, body) => { guard(); const response = await fetch(instance.origin + url, { signal: controller.signal,
        headers: { ...(teamCookie ? { Cookie: teamCookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
        const value = await response.json(); if (!response.ok) throw new Error(value.error || '公开基准API请求被拒绝'); const cookie = response.headers.get('set-cookie'); if (cookie) teamCookie = cookie.split(';')[0]; return value; };
      const session = await instance.api('/api/team/session');
      if (session.setupRequired) await instance.api('/api/team/setup', { name: operatorName, password: operatorPassword }); else assert.equal(session.user?.role, 'owner', '本基准重启后必须保留负责人会话');
      return instance;
    } catch (error) { await instance.close(); throw error; }
  }
  const until = async read => { for (;;) { guard(); const value = await read(); if (value) return value; await sleep(250); } };
  function serviceRows() { const db = new DatabaseSync(path.join(serviceRoot, 'planned.sqlite'), { readOnly: true }); try { return { budgets: db.prepare('SELECT * FROM budgets ORDER BY project_id,run_id').all(), executions: db.prepare('SELECT id,status,active,record FROM executions ORDER BY id').all() }; } finally { db.close(); } }
  async function git(workspace, args) {
    guard(); const result = await runProcess('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', ...args], { cwd: workspace, signal: controller.signal, timeoutMs: 15000, maxOutputBytes: 1024 * 1024,
      env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform', 'gitconfig'), GIT_TERMINAL_PROMPT: '0' } });
    if (result.terminationConfirmed !== true) { summary.reconciliation = { workspace, pid: result.pid, terminationConfirmed: false }; throw new Error('基准Git进程停止待核对'); }
    assert.equal(result.exitCode, 0); assert.equal(result.truncated, false); return result.stdout.trim();
  }
  const stop = () => { if (!closing) { closing = true; controller.abort(); if (app) void app.close().catch(() => {}); } }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    app = await open(); stage = 'key_boundary';
    const keyPath = path.join(serviceRoot, '.accepted-checkpoint.key'), keyHash = digest(await readFile(keyPath));
    const probeWorkspace = await mkdtemp(path.join(serviceRoot, 'key-boundary-')); await mkdir(path.join(probeWorkspace, '.platform/tmp'), { recursive: true });
    const runnerFile = path.join(probeWorkspace, '.platform/runner.cjs');
    await writeFile(runnerFile, `const fs=require('node:fs');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);let readDenied=false,writeDenied=false;try{fs.readFileSync(p.key)}catch{readDenied=true}try{fs.writeFileSync(p.key,'controlled-boundary-probe')}catch{writeDenied=true}fs.writeFileSync('.platform/tmp/inside.txt','inside');process.stdout.write(JSON.stringify({readDenied,writeDenied,inside:true}))});`, { flag: 'wx' });
    const sandbox = createWindowsSandbox({ executable: process.env.EXECUTION_SANDBOX_EXE }); await sandbox.preflight({ workspace: probeWorkspace, signal: controller.signal });
    const boundary = await sandbox.run({ workspace: probeWorkspace, runnerFile, input: JSON.stringify({ key: keyPath }), timeoutMs: 15000, signal: controller.signal });
    summary.keyBoundary = { pid: boundary.pid, terminationConfirmed: boundary.terminationConfirmed, exitCode: boundary.exitCode, keyBytesExposed: false };
    assert.equal(boundary.terminationConfirmed, true); assert.equal(boundary.exitCode, 0); assert.deepEqual(JSON.parse(boundary.stdout), { readDenied: true, writeDenied: true, inside: true }); assert.equal(digest(await readFile(keyPath)), keyHash);
    Object.assign(summary.keyBoundary, { readDenied: true, writeDenied: true, keyUnchanged: true });
    stage = 'planning'; const project = (await app.api('/api/projects', { name: benchmark.spec.title, filename: 'notes-tags.md', content: benchmark.requirements })).project;
    const initialRun = (await app.api(`/api/projects/${project.id}/runs`, { mode: 'model' })).run, base = `/api/projects/${project.id}/runs/${initialRun.id}`;
    Object.assign(summary, { projectId: project.id, runId: initialRun.id });
    const current = async state => { const run = (await app.api(base)).run; assert.notEqual(run.status, 'failed', '操作人规划夹具失败，尚未编码'); return run.status === state ? run : null; };
    const spec = await until(() => current('awaiting_spec')); await app.api(base + '/action', { action: 'approve_spec', revision: spec.specRevision, feedback: '操作人确认公开固定四任务规格；不是实际PM模型评估。' });
    const plan = await until(() => current('awaiting_review')); await app.api(base + '/action', { action: 'approve_plan', revision: plan.planRevision, specRevision: plan.specRevision, feedback: '操作人确认共享db/懒加载/四任务独占范围及固定验收。' }); await until(() => current('succeeded'));
    stage = 'definition'; const vpath = base + '/verification-plans', dpath = base + '/development-executions';
    const generated = (await app.api(vpath + '/propose', { contractRevision: (await app.api(vpath)).capabilities.contractRevision })).proposal;
    const proposed = await until(async () => { const row = (await app.api(vpath)).proposals.find(item => item.id === generated.id); if (['failed', 'stale', 'reconciliation_required'].includes(row?.status)) throw new Error('固定联合定义未通过，拒绝编码'); return row?.status === 'draft' ? row : null; });
    await app.api(`${vpath}/${proposed.id}/approve`, { revision: proposed.revision, feedback: '操作人编码前认可固定HTTP+4会话浏览器定义，不随模型输出修改。' });
    const capability = (await app.api(dpath)).capabilities; assert.equal(capability.canStart, true, capability.reason);
    for (const [key, value] of Object.entries(summary.publicBudget)) assert.equal(capability.budget[key], value, `预算边界改变:${key}`);
    stage = 'real_task_execution';
    const execution = (await app.api(dpath + '/start', { proposalId: proposed.id, revision: proposed.revision, contractRevision: capability.contractRevision })).execution;
    summary.executionId = execution.id;
    const ended = await until(async () => (await app.api(dpath)).executions.find(row => row.id === execution.id && (!row.active || row.status === 'reconciliation_required')));
    Object.assign(summary, { status: ended.status, backendStatus: ended.status, taskAccepted: ended.accepted, totalModelCalls: ended.totalModelCalls, usage: ended.usage, candidateCommit: ended.candidateCommit,
      maxConcurrentTasks: ended.maxConcurrentTasks, taskStates: ended.tasks, modelCalls: ended.modelCalls, failure: ended.error, finalChecks: ended.checks, executionRecordFile: 'execution-record.json' });
    const persisted = serviceRows(), raw = JSON.parse(persisted.executions.find(row => row.id === execution.id).record);
    await writeFile(path.join(root, 'execution-record.json'), JSON.stringify(raw, null, 2), { flag: 'wx' });
    if (raw.profileId === 'planned-task-run-v1' && typeof raw.reportPath === 'string') {
      const taskDb = new DatabaseSync(path.join(path.dirname(raw.reportPath), 'tasks.sqlite'), { readOnly: true });
      try { summary.ledger = { transaction: raw.transaction, attempts: taskDb.prepare('SELECT task_id,status,termination_state,candidate_commit FROM attempts ORDER BY created_at,id').all(), reservations: taskDb.prepare('SELECT * FROM reservations ORDER BY attempt_id').all(), settlements: taskDb.prepare('SELECT * FROM settlements ORDER BY id').all() }; } finally { taskDb.close(); }
    }
    assert.equal(ended.accepted, true, '真实任务图未完整通过；原失败保留，不自动重试'); assert.equal(ended.checkpoint.sealed, true); assert.equal(raw.profileId, 'planned-task-run-v1'); assert.equal(raw.terminationConfirmed, true);
    assert.equal(raw.tasks.length, 4); assert.ok(raw.tasks.every(item => item.status === 'completed')); assert.equal(raw.maxConcurrentTasks, 2); assert.ok(raw.totalModelCalls <= 24);
    const notes = raw.tasks.find(t => t.id === 'NOTES').record, tags = raw.tasks.find(t => t.id === 'TAGS').record;
    summary.parallel = { sameBase: notes.baseCommit === tags.baseCommit, differentClones: notes.workspace !== tags.workspace, baseCommit: notes.baseCommit,
      codingIntervals: raw.modelCalls.filter(c => c.role === 'coding' && ['NOTES', 'TAGS'].includes(c.taskId)).map(c => ({ taskId: c.taskId, attempt: c.attempt, startedAt: c.startedAt, finishedAt: c.finishedAt })) };
    const intervals = summary.parallel.codingIntervals, overlap = intervals.filter(x => x.taskId === 'NOTES').some(a => intervals.filter(x => x.taskId === 'TAGS').some(b => Number.isFinite(Date.parse(a.finishedAt)) && Number.isFinite(Date.parse(b.finishedAt)) && Date.parse(a.startedAt) < Date.parse(b.finishedAt) && Date.parse(b.startedAt) < Date.parse(a.finishedAt)));
    summary.parallel.actualCodingOverlap = overlap; assert.equal(summary.parallel.sameBase, true); assert.equal(summary.parallel.differentClones, true); assert.equal(overlap, true, '尚无实际编码调用时间重叠证据');
    stage = 'merge_and_final_evidence'; summary.merges = [];
    for (const merge of raw.merges) { const report = JSON.parse(await readFile(merge.sourceReportPath, 'utf8')), commits = [];
      let cursor = report.candidateCommit; for (const source of [...report.sources].reverse()) { const parents = (await git(report.workspace, ['rev-list', '--parents', '-n', '1', cursor])).split(' '); assert.equal(parents.length, 3); assert.equal(parents[2], source.provenance.sourceCommit); commits.unshift({ commit: cursor, parents: parents.slice(1) }); cursor = parents[1]; }
      assert.equal(cursor, report.base.sourceCommit); summary.merges.push({ batchId: merge.batchId, taskIds: merge.taskIds, baseCommit: cursor, candidateCommit: report.candidateCommit, commits }); }
    assert.ok(summary.merges.some(m => m.taskIds.includes('NOTES') && m.taskIds.includes('TAGS')));
    const final = raw.integration, acceptance = final.versions.at(-1).acceptance; assert.equal(final.taskId, 'FINAL'); assert.equal(final.manifestHash, raw.manifestHash);
    for (const report of [final.versions.at(-1).selfCheck, acceptance.test, acceptance.browser]) { assert.equal(report.status, 'passed'); assert.equal(report.terminationConfirmed, true); assert.ok(report.checks.length > 0 && report.checks.every(check => check.passed === true)); }
    assert.equal(acceptance.review.status, 'completed'); assert.equal(acceptance.review.openBlockingIssues, 0);
    const applicationDb = new DatabaseSync(path.join(acceptance.test.workspace, '.platform/tmp/app.sqlite'), { readOnly: true });
    try { summary.sameSQLiteFile = { notes: applicationDb.prepare('SELECT id,name FROM notes ORDER BY id').all(), tags: applicationDb.prepare('SELECT id,name FROM tags ORDER BY id').all() }; } finally { applicationDb.close(); }
    assert.deepEqual(summary.sameSQLiteFile.notes.map(x => x.name), ['接口便笺']); assert.deepEqual(summary.sameSQLiteFile.tags.map(x => x.name), ['接口标签']);
    stage = 'two_restarts'; const before = JSON.stringify(serviceRows().budgets), callsBefore = raw.totalModelCalls;
    for (let generation = 1; generation <= 2; generation++) {
      await app.close(); app = await open();
      const recoveryDeadline = Date.now() + 60_000;
      const recovered = await until(async () => {
        const current = (await app.api(dpath)).executions.find(row => row.id === execution.id);
        assert.equal(current?.status, 'accepted', '重开后原图应保留已验收历史记录。');
        assert.equal(current.active, false, '重开后原图不应重新派发。');
        if (current.accepted === true && current.checkpoint.restored === true) return current;
        assert.ok(Date.now() < recoveryDeadline, '未在60秒内核对到同版本恢复，保留原现场。');
        return null;
      });
      assert.equal(recovered.candidateCommit, raw.candidateCommit);
      assert.equal(recovered.actions.canDownload, true);
      assert.equal(JSON.stringify(serviceRows().budgets), before); assert.equal(recovered.totalModelCalls, callsBefore);
      const response = await fetch(app.origin + `${dpath}/${execution.id}/download`, { signal: controller.signal, headers: { Cookie: teamCookie } }); assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer()); await writeFile(path.join(root, `restored-${generation}.zip`), bytes, { flag: 'wx' });
      summary.checkpoints.push({ generation, accepted: true, restoredHistoricalDelivery: true, budgetUnchanged: true, modelCalls: recovered.totalModelCalls, archiveBytes: bytes.length, archiveSHA256: digest(bytes) });
    }
    assert.equal(summary.checkpoints[1].archiveSHA256, summary.checkpoints[0].archiveSHA256, '两次重开下载的同版本ZIP应一致。');
    summary.newCallsDuringRecovery = 0; summary.status = 'accepted'; summary.taskAccepted = true; stage = 'complete';
  } catch (error) {
    controller.abort(); summary.status = summary.backendStatus === 'reconciliation_required' || summary.reconciliation ? 'reconciliation_required' : 'failed'; summary.taskAccepted = false; summary.failureStage = stage;
    summary.reason = error instanceof assert.AssertionError ? error.message.split('\n')[0].slice(0, 240) : '本次基准未获得完整证据；请检查本地保留的执行记录，不会自动重试付费。'; process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { if (app) await app.close(); } catch { summary.status = 'reconciliation_required'; summary.taskAccepted = false; summary.closeConfirmed = false; process.exitCode = 1; }
    clearTimeout(totalTimer);
    if (summary.executionId) {
      try {
        const persisted = serviceRows(), row = persisted.executions.find(item => item.id === summary.executionId), finalRecord = JSON.parse(row.record);
        summary.finalService = { status: row.status, active: row.active, budgets: persisted.budgets };
        if (row.active || row.status === 'reconciliation_required') { summary.status = 'reconciliation_required'; summary.taskAccepted = false; process.exitCode = 1; }
        if (Number.isSafeInteger(finalRecord.totalModelCalls)) summary.totalModelCalls = finalRecord.totalModelCalls;
        if (finalRecord.usage) summary.usage = finalRecord.usage;
        await writeFile(path.join(root, 'execution-final-record.json'), JSON.stringify(finalRecord, null, 2), { flag: 'wx' });
      } catch { summary.finalPersistenceChecked = false; summary.taskAccepted = false; summary.status = 'reconciliation_required'; process.exitCode = 1; }
    }
    summary.elapsedMs = Date.now() - started; await writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ status: summary.status, taskAccepted: summary.taskAccepted, totalModelCalls: summary.totalModelCalls, usage: summary.usage, monetaryCost: null, failureStage: summary.failureStage, root }, null, 2));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2], loadRace = process.argv[3] === '--load-race';
  if (!(process.argv.length === 3 || process.argv.length === 4 && loadRace) || !['--preflight', '--model'].includes(mode)) { console.error('使用 --preflight（免费结构/批准/派生清单预检）或 --model（真实编码+Review，四任务最多24调用/20分钟）；可追加 --load-race 使用事先认可的延迟加载回归，规划、工程和定义始终是明示操作人夹具。'); process.exitCode = 2; }
  else if (mode === '--preflight') {
    const value = await preflightPlannedTasks({ loadRace }), output = path.resolve(import.meta.dirname, '../output/task-checks'); await mkdir(output, { recursive: true }); const root = await mkdtemp(path.join(output, 'preflight-'));
    await writeFile(path.join(root, 'preflight.json'), JSON.stringify(value, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ status: value.status, coverage: value.coverage, taskAccepted: false, actualModelCalls: 0, taskIds: value.task.tasks.map(t => t.id), manifestHash: value.manifest.manifestHash, root }, null, 2));
  } else await runModelBenchmark({ loadRace });
}
