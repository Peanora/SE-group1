import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createApp, loadEnv } from '../server.mjs';
import { ProjectStore } from '../lib/store.mjs';
import * as planner from '../lib/planner.mjs';
import { createEngineeringModel } from '../lib/engineering-model.mjs';
import { createVerificationPlanningService } from '../lib/verification-planning-service.mjs';
import { verificationModelPolicy } from '../lib/verification-model.mjs';
import { createPlannedExecutionService } from '../lib/planned-execution-service.mjs';
import { startPlannedWebExecution } from '../lib/planned-web-executor.mjs';
import { plannedNotes } from '../examples/planned-notes.mjs';
import { createWindowsSandbox } from '../lib/windows-sandbox.mjs';

// Planning/definition are explicit operator-fixed public fixtures. Only --model
// uses the configured real coding and Review adapters. No user data is opened.
const mode = process.argv[2];
if (process.argv.length !== 3 || !['--fixture', '--model'].includes(mode)) {
  console.error('使用 --fixture（真实隔离诊断，不封存通过，费用0）或 --model（真实编码/Review，最多3+3调用及10分钟）；规格、工程和测试定义均为明示固定夹具。'); process.exitCode = 2;
} else {
  await loadEnv();
  const output = path.resolve(import.meta.dirname, '../output/recovery-checks'); await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'notes-')), dataDir = path.join(root, 'data'), serviceRoot = path.join(dataDir, 'planned-executions');
  const synthetic = { baseUrl: 'https://operator-fixture.invalid/v1', model: 'operator-fixed-planning-not-paid', apiKey: '' };
  const operatorPassword = randomBytes(32).toString('base64url'); let teamCookie = '';
  const controller = new AbortController(), guard = () => { if (controller.signal.aborted) throw Object.assign(new Error('基准已停止。'), { name: 'AbortError' }); };
  const envelope = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
  const rawSpec = { ...structuredClone(plannedNotes.spec), acceptanceScenarios: [...plannedNotes.task.acceptanceScenarios,
    'GET与HEAD /favicon.ico返回无正文204，普通浏览器自动图标请求不能产生console错误。'] };
  const source = `${plannedNotes.requirements}\n\n${rawSpec.acceptanceScenarios.join('\n')}`;
  function proposal(spec) {
    const ids = spec.requirements.map(item => item.id), route = (id, method, path, request, response, requirementIds, errors = []) => ({ id, method, path, roles: [], request, response, requirementIds, errors });
    return { version: 1, title: spec.title, summary: spec.summary,
      entities: [{ id: 'notes', name: '便笺', fields: [{ name: 'id', type: 'integer', required: true, unique: true }, { name: 'name', type: 'string', required: true, unique: true }], constraints: ['名称trim后1至100字符且唯一，真实SQLite持久化'] }],
      routes: [route('notes_list', 'GET', '/api/notes', '无正文', '200 {notes:[{id,name}]}，id整数，初始[]', [ids[0], ids[3]]),
        route('notes_create', 'POST', '/api/notes', 'JSON {name:string}', '201 {note:{id,name}}', [ids[1], ids[2]], [{ status: 400, reason: '空白、超长或非法正文' }, { status: 409, reason: '去首尾空格后重复' }]),
        route('home', 'GET', '/', '无正文', '返回public/index.html原生网页并引用同源/app.js和/styles.css', ids),
        route('script', 'GET', '/app.js', '无正文', '返回public/app.js，JavaScript正确MIME', ids), route('style', 'GET', '/styles.css', '无正文', '返回public/styles.css，CSS正确MIME', ids),
        route('icon', 'GET', '/favicon.ico', '无正文', '204无正文，HEAD也204', [ids[0]])],
      views: [{ id: 'home', path: '/', title: '便笺管理', requirementIds: ids, selectors: [{ testId: 'note-name', role: 'textbox' }, { testId: 'note-create', role: 'button' }, { testId: 'note-list', role: 'list' }, { testId: 'note-count', role: 'status' }, { testId: 'note-error', role: 'status' }] }],
      tasks: [{ ...structuredClone(plannedNotes.task.tasks[0]), requirementIds: ids, acceptance: rawSpec.acceptanceScenarios }],
    };
  }
  const fixturePlanner = { ...planner, getModelConfig: () => ({ configured: true, model: synthetic.model }),
    analyzeWithModel: (text, name, options) => planner.analyzeWithModel(text, name, { ...options, config: synthetic, fetchImpl: async () => envelope(rawSpec) }),
    createEngineeringModel: () => input => createEngineeringModel({ config: synthetic, fetchImpl: async () => envelope(proposal(input.spec)) })(input),
  };
  const definitionFor = requirements => {
    const definition = structuredClone(plannedNotes.definition), mapping = new Map(plannedNotes.spec.requirements.map((item, index) => [item.id, requirements[index].id]));
    for (const step of [...definition.steps, ...definition.browser.steps]) step.requirementIds = step.requirementIds.map(id => mapping.get(id));
    definition.steps.push({ id: 'icon', type: 'request', dependsOn: ['saved'], requirementIds: [requirements[0].id], request: { id: 'icon_http', method: 'GET', path: '/favicon.ico', assertions: [{ id: 'icon_status', op: 'status', value: 204 }] } });
    return definition;
  };
  const fixture = body => async ({ onReceipt }) => { await onReceipt({ model: 'trusted-notes-fixture', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 }, content: JSON.stringify(body) }); return body; };
  async function open() {
    guard();
    const store = await new ProjectStore(dataDir).init();
    const verification = await createVerificationPlanningService({ rootDir: path.join(dataDir, 'verification-planning'), getPlanning: (pid, rid) => store.getPersistedRun(pid, rid), getPlanningSync: (pid, rid) => store.getPersistedRun(pid, rid), config: synthetic,
      dependencies: { createModel: () => async input => { const proposal = definitionFor(input.requirements), usage = { inputTokens: 0, outputTokens: 0 }; await input.onReceipt({ model: synthetic.model, finishReason: 'stop', usage, content: JSON.stringify(proposal) }); return { proposal, model: synthetic.model, usage, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' }; } } });
    const options = { store, teamEnabled: true, stepDelayMs: 0, planner: fixturePlanner, verificationPlanningService: verification, plannedExecutionTimeoutMs: 600000 };
    if (mode === '--fixture') {
      const files = structuredClone(plannedNotes.files); files[0].content = files[0].content.replace("const p=new URL(req.path,'http://local').pathname;", "const p=new URL(req.path,'http://local').pathname;if(p==='/favicon.ico'&&['GET','HEAD'].includes(req.method))return {status:204,body:''};");
      options.plannedExecutionService = await createPlannedExecutionService({ rootDir: serviceRoot, verificationService: verification, getPlanningSync: (pid, rid) => store.getPersistedRun(pid, rid), withCheckpoint: (_pid, work) => work(), config: synthetic, timeoutMs: 600000,
        dependencies: { createProvider: () => fixture({ files }), createReviewer: () => fixture({ summary: '可信夹具诊断，不构成模型Review', issues: [], resolutions: [] }),
          startExecution: input => startPlannedWebExecution({ ...input, providerKind: 'trusted_fixture', reviewerKind: 'diagnostic', maxCalls: 1, maxReviewCalls: 1 }) } });
    }
    const app = await createApp(options);
    try {
    guard(); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); guard();
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    app.api = async (url, body) => { const response = await fetch(origin + url, { headers: { ...(teamCookie ? { Cookie: teamCookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || '基准请求失败'); const cookie = response.headers.get('set-cookie'); if (cookie) teamCookie = cookie.split(';')[0]; return data; };
    const session = await app.api('/api/team/session');
    if (session.setupRequired) await app.api('/api/team/setup', { name: 'benchmark_operator', password: operatorPassword });
    else assert.equal(session.user?.role, 'owner', '重启必须保留本基准负责人身份，不能绕过账号门禁');
    guard(); app.origin = origin; return app;
    } catch (error) { await app.close(); throw error; }
  }
  const until = async read => { const end = Date.now() + 660000; for (;;) { guard(); const value = await read(); if (value) return value; assert.ok(Date.now() < end, '基准等待超过总预算'); await new Promise(resolve => setTimeout(resolve, 200)); } };
  const budget = () => { const db = new DatabaseSync(path.join(serviceRoot, 'planned.sqlite'), { readOnly: true }); try { return db.prepare('SELECT * FROM budgets').all(); } finally { db.close(); } };
  let app = await open(), closing = false; const stop = () => { if (!closing) { closing = true; controller.abort(); void app.close(); } }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const keyPath = path.join(serviceRoot, '.accepted-checkpoint.key'), keyHash = createHash('sha256').update(await readFile(keyPath)).digest('hex');
    const probeWorkspace = await mkdtemp(path.join(serviceRoot, 'key-boundary-')); await mkdir(path.join(probeWorkspace, '.platform/tmp'), { recursive: true });
    const runnerFile = path.join(probeWorkspace, '.platform/runner.cjs');
    await writeFile(runnerFile, `const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const data=JSON.parse(input);let readDenied=false,writeDenied=false;try{fs.readFileSync(data.key)}catch{readDenied=true}try{fs.writeFileSync(data.key,'controlled-temporary-boundary-probe')}catch{writeDenied=true}fs.writeFileSync('.platform/tmp/allowed.txt','inside');process.stdout.write(JSON.stringify({readDenied,writeDenied,inside:fs.readFileSync('.platform/tmp/allowed.txt','utf8')==='inside'}))});`, { flag: 'wx' });
    const sandbox = createWindowsSandbox({ executable: process.env.EXECUTION_SANDBOX_EXE }); await sandbox.preflight({ workspace: probeWorkspace, signal: controller.signal });
    const boundary = await sandbox.run({ workspace: probeWorkspace, runnerFile, input: JSON.stringify({ key: keyPath }), timeoutMs: 15000, signal: controller.signal });
    assert.equal(boundary.terminationConfirmed, true); assert.equal(boundary.exitCode, 0); assert.deepEqual(JSON.parse(boundary.stdout), { readDenied: true, writeDenied: true, inside: true });
    assert.equal(createHash('sha256').update(await readFile(keyPath)).digest('hex'), keyHash); await writeFile(path.join(root, 'key-boundary.json'), JSON.stringify({ ...JSON.parse(boundary.stdout), pid: boundary.pid, terminationConfirmed: true, keyUnchanged: true, keyBytesExposed: false }, null, 2), { flag: 'wx' });
    const project = (await app.api('/api/projects', { name: '检查点恢复公开便笺基准', filename: 'notes.md', content: source })).project;
    const run = (await app.api(`/api/projects/${project.id}/runs`, { mode: 'model' })).run, base = `/api/projects/${project.id}/runs/${run.id}`;
    const current = async state => { const data = (await app.api(base)).run; if (data.status === 'failed') throw new Error('固定规划夹具未通过；未开始编码'); return data.status === state ? data : null; };
    const spec = await until(() => current('awaiting_spec')); await app.api(base + '/action', { action: 'approve_spec', revision: spec.specRevision, feedback: '操作人确认公开固定基准规格；规划传输为明示夹具。' });
    const plan = await until(() => current('awaiting_review')); await app.api(base + '/action', { action: 'approve_plan', revision: plan.planRevision, specRevision: plan.specRevision, feedback: '操作人确认固定工程契约、范围和验收。' }); await until(() => current('succeeded'));
    const vpath = base + '/verification-plans', dpath = base + '/development-executions';
    const generated = (await app.api(vpath + '/propose', { contractRevision: (await app.api(vpath)).capabilities.contractRevision })).proposal;
    const proposed = await until(async () => (await app.api(vpath)).proposals.find(item => item.id === generated.id && item.status === 'draft'));
    await app.api(`${vpath}/${proposed.id}/approve`, { revision: proposed.revision, feedback: '操作人认可公开固定的HTTP与浏览器定义，编码前冻结。' });
    const capability = (await app.api(dpath)).capabilities; assert.equal(capability.canStart, true, capability.reason);
    const started = (await app.api(dpath + '/start', { proposalId: proposed.id, revision: proposed.revision, contractRevision: capability.contractRevision })).execution;
    const ended = await until(async () => (await app.api(dpath)).executions.find(item => item.id === started.id && !item.active));
    const summary = { id: randomUUID(), planningAndDefinition: 'explicit_operator_fixtures_not_real_PM', fixture: mode === '--fixture', status: ended.status, taskAccepted: ended.accepted,
      totalModelCalls: ended.totalModelCalls, usage: ended.usage, candidateCommit: ended.candidateCommit, checkpoints: [], newCallsDuringRecovery: 0, root };
    if (mode === '--fixture') { assert.equal(ended.status, 'diagnostic_passed', ended.error); assert.equal(ended.accepted, false); assert.equal(ended.checkpoint.sealed, false); assert.equal(ended.totalModelCalls, 0); }
    else {
      assert.equal(ended.accepted, true, ended.error); assert.equal(ended.checkpoint.sealed, true); const before = JSON.stringify(budget());
      for (let generation = 1; generation <= 2; generation++) {
        await app.close(); app = await open(); const recovered = (await app.api(dpath)).executions.find(item => item.id === started.id);
        assert.equal(recovered.accepted, true, recovered.checkpoint.message); assert.equal(recovered.checkpoint.restored, true); assert.equal(JSON.stringify(budget()), before);
        const response = await fetch(app.origin + `${dpath}/${started.id}/download`, { headers: { Cookie: teamCookie } }); assert.equal(response.status, 200); const buffer = Buffer.from(await response.arrayBuffer());
        await writeFile(path.join(root, `restored-${generation}.zip`), buffer, { flag: 'wx' }); summary.checkpoints.push({ generation, accepted: true, restored: true, budgetUnchanged: true, archiveBytes: buffer.length });
      }
    }
    await writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' }); console.log(JSON.stringify(summary, null, 2));
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await app.close(); }
}
