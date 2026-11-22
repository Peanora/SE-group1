import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { createEngineeringModel } from '../lib/engineering-model.mjs';
import * as planner from '../lib/planner.mjs';
import { ProjectStore } from '../lib/store.mjs';
import { describeExecutionSubject } from '../lib/team-access.mjs';
import { verificationModelPolicy } from '../lib/verification-model.mjs';
import { createVerificationPlanningService } from '../lib/verification-planning-service.mjs';
import { source, spec, proposal as engineeringDraft } from './helpers/engineering-role-case.mjs';

const config = { baseUrl: 'https://automatic-delivery.invalid/v1', model: 'automatic-delivery-fixture', apiKey: 'fixture-automatic-delivery-key' };
const consent = { mode: 'model', automaticDelivery: { modelUsageConfirmed: true } };
const question = '资源列表默认先显示哪一项？';
const answer = '资源列表优先显示编号最小的一项。';
const usage = { inputTokens: 7, outputTokens: 11 };
const modelResponse = value => new Response(JSON.stringify({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
  usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens },
}));
const definition = {
  version: 1, id: 'resources', name: '资源联合验收', sessions: [],
  steps: [{ id: 'read', type: 'request', dependsOn: [], requirementIds: ['R-001'], request: {
    id: 'read', method: 'GET', path: '/api/resources', assertions: [{ id: 'status', op: 'status', value: 200 }],
  } }],
  browser: { version: 1, sessions: ['visitor'], steps: [
    { id: 'open', session: 'visitor', requirementIds: ['R-001'], op: 'goto', path: '/' },
    { id: 'see', session: 'visitor', requirementIds: ['R-001'], op: 'visible', testId: 'resource-row', value: true },
  ] },
};

async function waitFor(read, matches, label) {
  const deadline = Date.now() + 8000;
  let result;
  do {
    result = await read();
    if (matches(result)) return result;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`等待${label}超时：${JSON.stringify(result)}`);
}

async function fixture(t, { clarify = false, verificationDefinition = definition, allowDevelopment = true, teamEnabled = false, slowPlanningIntent, specFixture = spec, engineeringFixture = engineeringDraft, firstVerificationAllowance } = {}) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'automatic-delivery-http-'));
  let store;
  const calls = { spec: 0, engineering: 0, verification: 0, start: 0 };
  const executions = new Map();
  const checkpoints = new Map();
  let app, verification, verificationAllowance = firstVerificationAllowance;
  t.after(async () => {
    try { if (app) await app.close(); else await verification?.shutdown(); }
    finally {
      const target = await realpath(directory);
      assert.equal(path.dirname(target), temporaryRoot);
      assert.ok(path.basename(target).startsWith('automatic-delivery-http-'));
      await rm(target, { recursive: true, force: true });
    }
  });
  const getPlanning = (...args) => store.getPersistedRun(...args);
  function openVerification() { return createVerificationPlanningService({ rootDir: path.join(directory, 'verification-planning'),
    getPlanning, getPlanningSync: getPlanning, config, ...(verificationAllowance ? { maxAttempts: verificationAllowance } : {}),
    dependencies: { createModel: () => async input => {
      calls.verification++;
      assert.equal(input.binding.specRevision.length, 64);
      const proposal = typeof verificationDefinition === 'function' ? verificationDefinition(calls.verification, input) : verificationDefinition;
      await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(proposal) });
      return { proposal, model: config.model, usage, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' };
    } },
  }); }
  const contractRevision = 'c'.repeat(64);
  const plannedExecutionService = {
    list: async identity => {
      const { proposals } = await verification.list(identity);
      const supportedProposalIds = proposals.filter(item => item.current && item.approved && item.proposal.browser).map(item => item.id);
      const row = executions.get(identity.runId);
      const rows = Array.isArray(row) ? row : row ? [row] : [];
      return { capabilities: { canStart: allowDevelopment && !!supportedProposalIds.length && !rows.some(item => item.active), contractRevision, supportedProposalIds },
        executions: structuredClone(rows) };
    },
    start: async ({ projectId, runId, proposalId, revision, contractRevision: selected }, { subject }) => {
      assert.equal(selected, contractRevision);
      assert.equal(describeExecutionSubject(subject).kind, teamEnabled ? 'team' : 'local');
      const { run } = getPlanning(projectId, runId);
      assert.equal(run.status, 'succeeded');
      assert.equal(run.approvals.plan.revision, run.planRevision);
      assert.equal(run.approvals.spec.revision, run.specRevision);
      const { proposals } = await verification.list({ projectId, runId });
      assert.ok(proposals.some(item => item.id === proposalId && item.revision === revision && item.approved));
      assert.equal(executions.has(runId), false);
      calls.start++;
      const execution = { id: randomUUID(), projectId, runId, proposalId, revision, current: true, active: true, status: 'generating',
        binding: { projectId, runId, sourceRevision: run.sourceRevision, sourceGeneration: run.sourceGeneration,
          planRevision: run.planRevision, specRevision: run.specRevision }, workflow: { stage: 'coding' }, actions: { canDownload: false } };
      executions.set(runId, execution);
      return { execution: structuredClone(execution) };
    },
    withProjectCheckpoint: async (_id, work) => work(),
    shutdown: async () => {},
  };
  let origin;
  async function open(environment = {}) {
    store = await new ProjectStore(directory).init();
    const save = store.save.bind(store);
    let delayedIntent = false;
    store.save = project => {
      const run = project.runs.at(-1), state = run?.automaticDelivery;
      for (const key of [state?.pendingDispatch?.kind, state?.status === 'needs_clarification' ? 'clarification' : null,
        run?.stages.find(item => item.id === 'spec')?.status === 'running' ? `spec-${run.specificationHistory?.at(-1)?.requestState ?? 'starting'}` : null]) {
        if (key && !checkpoints.has(key)) checkpoints.set(key, structuredClone(project));
      }
      if (firstVerificationAllowance && state?.status === 'running' && state.stage === 'verification' && state.proposalId
        && !state.pendingDispatch && !checkpoints.has('first-verification-stage')) {
        checkpoints.set('first-verification-stage', structuredClone(project));
      }
      if (slowPlanningIntent && !delayedIntent && run?.[`${slowPlanningIntent}History`]?.at(-1)?.requestState === 'dispatch_intent') {
        delayedIntent = true;
        return delay(200).then(() => save(project));
      }
      return save(project);
    };
    verification = await openVerification();
    app = await createApp({ store, executionService: null, sourceChangeService: null, verificationPlanningService: verification, teamEnabled,
    ...(slowPlanningIntent ? { [`${slowPlanningIntent}TimeoutMs`]: 40 } : {}),
    plannedExecutionService, stepDelayMs: 0, agentEnvironment: {
      LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model, LLM_API_KEY: config.apiKey, ...environment,
    }, planner: { ...planner, getModelConfig: () => ({ configured: true, model: config.model }),
      analyzeWithModel: (text, name, options) => {
        calls.spec++;
        const draft = clarify && calls.spec === 1 ? { ...spec, requirements: [], questions: [question], clarificationRequired: true } : specFixture;
        if (clarify && calls.spec === 2) assert.ok(text.includes(answer));
        return planner.analyzeWithModel(text, name, { ...options, config, fetchImpl: async () => modelResponse(draft) });
      },
      createEngineeringModel: () => createEngineeringModel({ config, fetchImpl: async () => {
        calls.engineering++;
        return modelResponse(engineeringFixture);
      } }),
    },
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
  }
  await open();
  let defaultCookie;
  async function request(route, body, headers, method = 'POST') {
    const authHeaders = { ...(defaultCookie ? { cookie: defaultCookie } : {}), ...headers };
    const response = await fetch(origin + route, body === undefined ? { headers: authHeaders } : {
      method, headers: { 'content-type': 'application/json', ...authHeaders }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  let teamOwnerId;
  if (teamEnabled) {
    const owner = await request('/api/team/setup', { name: 'owner', password: 'fixture-owner-password' });
    assert.equal(owner.status, 201, JSON.stringify(owner.body));
    defaultCookie = owner.cookie;
    teamOwnerId = owner.body.user.id;
  }
  const created = await request('/api/projects', { name: '资源项目', filename: 'r.md', content: source });
  assert.equal(created.status, 201);
  const runsRoute = `/api/projects/${created.body.project.id}/runs`;
  return { request, runsRoute, calls, executions, checkpoints, teamOwnerId, useCookie: cookie => { defaultCookie = cookie; }, async restart({ checkpoint, environment, afterClose } = {}) {
    await app.close();
    app = null;
    if (checkpoint) {
      const snapshot = checkpoints.get(checkpoint);
      assert.ok(snapshot, `缺少 ${checkpoint} 停点`);
      await writeFile(path.join(directory, `${snapshot.id}.json`), JSON.stringify(snapshot), 'utf8');
    }
    if (afterClose) await afterClose(directory);
    verificationAllowance = undefined;
    await open(environment);
    allowDevelopment = true;
  }, async start(input = consent) {
    const creation = await request(runsRoute, input);
    assert.equal(creation.status, 201, JSON.stringify(creation.body));
    const { id } = creation.body.run, route = `${runsRoute}/${id}`;
    return { id, route, async status() {
      const response = await request(`${route}/automatic-delivery`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    } };
  } };
}

for (const stage of ['specification', 'engineering']) {
  test(`${stage} timeout while dispatch intent is saving remains a known unsent request`, async t => {
    const f = await fixture(t, { slowPlanningIntent: stage });
    const delivery = await f.start();
    await waitFor(delivery.status, state => state.status === 'failed', '派发前时限耗尽');
    const { body: { run } } = await f.request(delivery.route);
    const attempt = run[`${stage}History`].at(-1);
    assert.equal(attempt.code, 'model_timeout');
    assert.equal(attempt.requestState, 'not_started');
    assert.deepEqual(attempt.transport, { version: 1, dispatched: false, responseComplete: false });
    assert.deepEqual(f.calls, { spec: stage === 'specification' ? 0 : 1, engineering: 0, verification: 0, start: 0 });
  });
}

test('reopening the workbench keeps clarification on the original run and original authorization', async t => {
  const f = await fixture(t, { clarify: true });
  const delivery = await f.start();
  await waitFor(delivery.status, state => state.status === 'needs_clarification', '初次澄清');
  await f.restart();
  await waitFor(delivery.status, state => state.status === 'needs_clarification', '重启后澄清');
  assert.deepEqual(f.calls, { spec: 1, engineering: 0, verification: 0, start: 0 });
  const view = await f.request(delivery.route);
  const { id: issueId, qa } = view.body.run.planningIssue;
  const result = await f.request(`${delivery.route}/action`, { action: 'answer_planning_issue', issueId, continue: true, answers: { [qa[0].id]: answer } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.run.id, delivery.id);
  await waitFor(delivery.status, state => !!state.executionId, '同运行继续开发');
  assert.deepEqual(f.calls, { spec: 2, engineering: 1, verification: 1, start: 1 });
});

test('reopening after a complete specification receipt revalidates it without another specification request', async t => {
  const f = await fixture(t, { allowDevelopment: false });
  const delivery = await f.start();
  await waitFor(delivery.status, state => state.status === 'failed', '夹具完成前置流程');
  assert.ok(f.checkpoints.has('spec-settled'));
  await f.restart({ checkpoint: 'spec-settled' });
  const observed = await waitFor(async () => (await f.request(delivery.route)).body.run, state => state.specificationRevalidations?.length === 1, '重验规格回执');
  assert.equal(observed.id, delivery.id);
  assert.equal(observed.specificationCalls, 1);
  assert.equal(f.calls.spec, 1);
});

test('a planning dispatch with no durable outcome keeps usage unconfirmed after restart', async t => {
  const f = await fixture(t, { clarify: true });
  const delivery = await f.start();
  await waitFor(delivery.status, state => state.status === 'needs_clarification', '规格调用落盘');
  await f.restart({ checkpoint: 'spec-dispatch_intent' });
  const state = await waitFor(delivery.status, value => value.status === 'interrupted', '规划请求待核对');
  assert.equal(state.usageUncertain, true);
  assert.match(state.message, /用量.*未知/u);
  assert.deepEqual(f.calls, { spec: 1, engineering: 0, verification: 0, start: 0 });
});

test('restart does not reuse automatic spending authorization when the effective model configuration changes', async t => {
  const f = await fixture(t, { clarify: true });
  const delivery = await f.start();
  await waitFor(delivery.status, state => state.status === 'needs_clarification', '原配置等待澄清');
  await f.restart({ environment: { LLM_API_KEY: 'different-fixture-key' } });
  const stopped = await waitFor(delivery.status, state => state.status === 'interrupted', '原用量授权失效');
  assert.match(stopped.message, /授权.*设置/u);
  const { body } = await f.request(delivery.route);
  assert.doesNotMatch(JSON.stringify(body), /settingsFingerprint|fixture-automatic-delivery-key|different-fixture-key/u);
  assert.deepEqual(f.calls, { spec: 1, engineering: 0, verification: 0, start: 0 });
});

test('team authorization is recovered privately and can no longer resume after the original owner is revoked', async t => {
  const f = await fixture(t, { clarify: true, teamEnabled: true });
  const delivery = await f.start();
  await waitFor(delivery.status, state => state.status === 'needs_clarification', '团队首次澄清');
  await f.restart();
  await waitFor(delivery.status, state => state.status === 'needs_clarification', '原团队授权继续');
  const original = await f.request(delivery.route);
  assert.doesNotMatch(JSON.stringify(original.body.run.automaticDelivery), /rootDir|authorityId|memberId|taskflow_session|settingsFingerprint/u);
  const another = { name: 'second', password: 'fixture-second-password' };
  assert.equal((await f.request('/api/team/members', { ...another, role: 'owner' })).status, 201);
  const other = await f.request('/api/team/login', another);
  assert.equal(other.status, 200);
  f.useCookie(other.cookie);
  const revoked = await f.request(`/api/team/members/${f.teamOwnerId}`, { role: 'observer', active: false }, {}, 'PATCH');
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  await f.restart();
  await waitFor(delivery.status, state => state.status === 'interrupted', '原团队授权撤销');
  assert.deepEqual(f.calls, { spec: 1, engineering: 0, verification: 0, start: 0 });
});

test('restart finds a saved verification proposal even when the automatic state did not receive its ID', async t => {
  const f = await fixture(t, { allowDevelopment: false });
  const delivery = await f.start();
  const blocked = await waitFor(delivery.status, state => state.status === 'failed', '夹具保存验收清单');
  assert.ok(blocked.proposalId);
  await f.restart({ checkpoint: 'verification' });
  const resumed = await waitFor(delivery.status, state => !!state.executionId, '恢复清单后启动开发');
  assert.equal(resumed.proposalId, blocked.proposalId);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 1, start: 1 });
  assert.equal(Object.hasOwn(resumed, 'pendingDispatch'), false);
});

test('restart identifies an existing verification request with unknown use and never replaces it', async t => {
  const f = await fixture(t, { allowDevelopment: false });
  const delivery = await f.start();
  const blocked = await waitFor(delivery.status, state => state.status === 'failed', '夹具保存验收清单');
  await f.restart({ checkpoint: 'verification', environment: { LLM_API_KEY: 'different-fixture-key' }, afterClose: directory => {
    const db = new DatabaseSync(path.join(directory, 'verification-planning', 'verification.sqlite'));
    try { db.prepare("UPDATE proposals SET status='generating',active=1,dispatched=1,receipt_state='not_received',receipt_hash=NULL,receipt_bytes=NULL,input_tokens=NULL,output_tokens=NULL WHERE id=?").run(blocked.proposalId); }
    finally { db.close(); }
  } });
  const stopped = await waitFor(delivery.status, state => state.status === 'interrupted', '验收请求待核对');
  assert.equal(stopped.proposalId, blocked.proposalId);
  assert.equal(stopped.usageUncertain, true);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 1, start: 0 });
});

test('restart adopts only one development execution for the frozen plan and definition', async t => {
  const f = await fixture(t);
  const delivery = await f.start();
  const launched = await waitFor(delivery.status, state => !!state.executionId, '已启动开发');
  await f.restart({ checkpoint: 'development' });
  const resumed = await waitFor(delivery.status, state => !!state.executionId, '重新认领原开发');
  assert.equal(resumed.executionId, launched.executionId);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 1, start: 1 });
});

for (const conflict of ['missing', 'ambiguous', 'stale']) {
  test(`development intent with ${conflict} evidence is interrupted without a second dispatch`, async t => {
    const f = await fixture(t);
    const delivery = await f.start();
    await waitFor(delivery.status, state => !!state.executionId, '已启动开发');
    await f.restart({ checkpoint: 'development', afterClose: () => {
      const row = f.executions.get(delivery.id);
      if (conflict === 'missing') f.executions.delete(delivery.id);
      if (conflict === 'ambiguous') f.executions.set(delivery.id, [row, { ...row, id: randomUUID() }]);
      if (conflict === 'stale') row.binding.planRevision = '0'.repeat(64);
    } });
    const stopped = await waitFor(delivery.status, state => state.status === 'interrupted', '开发派发待核对');
    assert.equal(stopped.executionId, undefined);
    assert.equal(stopped.usageUncertain, true);
    assert.equal(stopped.retryVerification, undefined);
    assert.equal(f.calls.start, 1);
  });
}

test('automatic delivery requires local model consent and leaves manual approvals in place', async t => {
  const f = await fixture(t);
  for (const input of [
    { mode: 'local', automaticDelivery: { modelUsageConfirmed: true } },
    { mode: 'model', automaticDelivery: { modelUsageConfirmed: false } },
    { mode: 'model', automaticDelivery: { modelUsageConfirmed: true, transferApproval: true } },
  ]) assert.equal((await f.request(f.runsRoute, input)).status, 400);
  assert.equal((await f.request(f.runsRoute, consent, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.deepEqual(f.calls, { spec: 0, engineering: 0, verification: 0, start: 0 });

  const manual = await f.start({ mode: 'model' });
  assert.equal((await manual.status()).enabled, false);
  const { body: { run } } = await waitFor(() => f.request(manual.route), result => result.body.run?.status === 'awaiting_spec', '手动确认规格');
  assert.equal(run.approvals.spec, null);
  assert.deepEqual(f.calls, { spec: 1, engineering: 0, verification: 0, start: 0 });
});

test('submitting clarification resumes the same automatic run and a blocked candidate never completes delivery', async t => {
  const f = await fixture(t, { clarify: true });
  const delivery = await f.start();
  const blocked = await waitFor(delivery.status, state => state.status === 'needs_clarification', '业务澄清');
  assert.equal(blocked.enabled, true);
  assert.equal(blocked.stage, 'spec');
  assert.deepEqual(f.calls, { spec: 1, engineering: 0, verification: 0, start: 0 });

  const { body: { run } } = await f.request(delivery.route);
  assert.equal(run.approvals.spec, null);
  assert.equal((await f.request(f.runsRoute, consent)).status, 409);
  assert.equal((await f.request(`${delivery.route}/action`, { action: 'approve_spec', revision: run.specRevision })).status, 409);
  const { id: issueId, qa } = run.planningIssue;
  assert.deepEqual(qa.map(item => item.question), [question]);
  const answered = await f.request(`${delivery.route}/action`, {
    action: 'answer_planning_issue', issueId, continue: true, answers: { [qa[0].id]: answer },
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.run.id, delivery.id);

  const coding = await waitFor(delivery.status, state => state.stage === 'coding' && state.executionId, '自动编码');
  assert.equal(coding.status, 'running');
  const execution = f.executions.get(delivery.id);
  assert.equal(coding.executionId, execution.id);
  assert.deepEqual(f.calls, { spec: 2, engineering: 1, verification: 1, start: 1 });
  execution.status = 'validating';
  execution.workflow.stage = 'testing';
  await waitFor(delivery.status, state => state.stage === 'testing' && state.status === 'running', '自动测试');
  execution.workflow.stage = 'review';
  execution.workflow.reviewPending = true;
  await waitFor(delivery.status, state => state.stage === 'testing' && state.status === 'running' && /审查/u.test(state.message), '自动审查');
  Object.assign(execution, { status: 'failed', active: false, error: '候选仍有阻塞审查问题。' });
  execution.workflow.reviewPending = false;
  const failed = await waitFor(delivery.status, state => state.status === 'failed', '拒绝交付');
  assert.equal(failed.executionId, execution.id);
  assert.notEqual(failed.downloadAvailable, true);
  assert.equal(f.calls.start, 1);
});

test('automatic delivery completes only after the bound execution exposes its source download', async t => {
  const f = await fixture(t);
  const delivery = await f.start();
  await waitFor(delivery.status, state => state.stage === 'coding' && state.executionId, '自动编码');
  const execution = f.executions.get(delivery.id);
  execution.status = 'restoring_delivery';
  execution.accepted = true;
  execution.workflow.stage = 'review';
  const restoring = await waitFor(delivery.status, state => state.stage === 'testing', '等待源码下载许可');
  assert.equal(restoring.status, 'running');
  assert.equal(restoring.downloadAvailable, false);
  Object.assign(execution, { status: 'accepted', active: false });
  execution.actions.canDownload = true;
  const completed = await waitFor(delivery.status, state => state.status === 'completed', '同版本交付');
  assert.equal(completed.executionId, execution.id);
  assert.equal(completed.downloadAvailable, true);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 1, start: 1 });
});

test('automatic delivery exhausts a bounded set of incomplete verification proposals without launching code', async t => {
  const { browser, ...httpOnly } = definition;
  const f = await fixture(t, { verificationDefinition: httpOnly });
  const delivery = await f.start();
  const failed = await waitFor(delivery.status, state => state.status === 'failed', '独立验收清单失败');
  assert.equal(failed.stage, 'verification');
  assert.equal(failed.downloadAvailable, false);
  assert.equal(failed.executionId, undefined);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 3, start: 0 });
  const { body: { proposals } } = await f.request(`${delivery.route}/verification-plans`);
  assert.equal(proposals.length, 3);
  assert.ok(proposals.every(item => item.status === 'draft' && !item.approved));
});

test('owner-confirmed verification rework retains the same plan and starts development only with a complete joint definition', async t => {
  const navigationOnly = { ...definition, browser: { ...definition.browser, steps: [definition.browser.steps[0]] } };
  const f = await fixture(t, { verificationDefinition: (attempt, input) => {
    if (attempt < 4) return navigationOnly;
    assert.ok(input.retryFeedback, 'the new proposal receives the prior validation problem');
    return definition;
  } });
  const delivery = await f.start();
  const failed = await waitFor(delivery.status, state => state.status === 'failed' && state.retryVerification, '缺少浏览器断言');
  assert.equal(failed.retryVerification.maxAttempts, 3);
  const { body: { run: old } } = await f.request(delivery.route);
  const route = `${delivery.route}/automatic-delivery/retry-verification`;
  const payload = { modelUsageConfirmed: true, planRevision: old.planRevision, updatedAt: failed.updatedAt };
  assert.equal((await f.request(route, { ...payload, modelUsageConfirmed: false })).status, 400);
  assert.equal((await f.request(route, { ...payload, planRevision: '0'.repeat(64) })).status, 409);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 3, start: 0 });
  const retried = await f.request(route, payload);
  assert.equal(retried.status, 202, JSON.stringify(retried.body));
  assert.equal((await f.request(route, payload)).status, 409);
  await waitFor(delivery.status, state => state.executionId, '返工后自动编码');
  const { body: { run: next } } = await f.request(delivery.route);
  assert.deepEqual(next.approvals, old.approvals);
  assert.equal(next.id, old.id);
  const { body: { proposals } } = await f.request(`${delivery.route}/verification-plans`);
  assert.equal(proposals.length, 4);
  assert.ok(proposals.slice(0, 3).every(item => !item.approved));
  assert.equal(proposals.at(-1).approved, true);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 4, start: 1 });
});

test('a saved joint definition can continue after both batches without a seventh test model call', async t => {
  const { browser, ...httpOnly } = definition;
  const f = await fixture(t, { verificationDefinition: httpOnly });
  const delivery = await f.start();
  const first = await waitFor(delivery.status, state => state.status === 'failed' && state.retryVerification, '第一轮清单失败');
  const { body: { run } } = await f.request(delivery.route);
  const action = `${delivery.route}/automatic-delivery/retry-verification`;
  const resume = updatedAt => f.request(action, { planRevision: run.planRevision, updatedAt, modelUsageConfirmed: true });
  assert.equal((await resume(first.updatedAt)).status, 202);
  const exhausted = await waitFor(delivery.status, state => state.status === 'failed' && !state.retryVerification, '清单返工预算耗尽');
  assert.equal((await resume(exhausted.updatedAt)).status, 409);
  const definitions = `${delivery.route}/verification-plans`;
  const { body: { capabilities } } = await f.request(definitions);
  const saved = await f.request(`${definitions}/import`, { contractRevision: capabilities.contractRevision,
    proposal: definition, feedback: '已补上同一页面的实际结果断言。' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal((await delivery.status()).retryVerification.maxAttempts, 0);
  assert.equal((await resume(exhausted.updatedAt)).status, 202);
  const coding = await waitFor(delivery.status, state => state.executionId, '使用保存的清单编码');
  assert.equal(coding.proposalId, saved.body.proposal.id);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 6, start: 1 });
});

test('automatic delivery resumes a settled partial HTTP draft and completes all stages without importing or editing it', async t => {
  const requirementIds = Array.from({ length: 16 }, (_, index) => 'R-' + String(index + 1).padStart(3, '0'));
  const largeSpec = { ...structuredClone(spec), requirements: requirementIds.map((id, index) => ({
    ...spec.requirements[0], id, title: '资源规则 ' + (index + 1),
  })) };
  const largeEngineering = structuredClone(engineeringDraft);
  for (const group of ['routes', 'views', 'tasks']) largeEngineering[group][0].requirementIds = requirementIds;
  const httpStage = { ...structuredClone(definition), steps: [{ ...structuredClone(definition.steps[0]),
    requirementIds: requirementIds.slice(0, -1) }] };
  delete httpStage.browser;
  const additions = { sessions: [], steps: [{
    ...structuredClone(definition.steps[0]), id: 'later-read', dependsOn: ['read'],
    requirementIds: [requirementIds.at(-1)], request: { ...definition.steps[0].request, id: 'later-request' },
  }] };
  const browser = { ...definition.browser, steps: definition.browser.steps.map(step => ({ ...step, requirementIds })) };
  const f = await fixture(t, { specFixture: largeSpec, engineeringFixture: largeEngineering, firstVerificationAllowance: 1,
    verificationDefinition: (call, input) => {
      assert.equal(input.generationStage, ['http', 'http-supplement', 'browser'][call - 1]);
      if (call === 2) assert.deepEqual(input.previousHttp.steps, httpStage.steps);
      return [httpStage, additions, browser][call - 1];
    },
  });
  const started = await f.start();
  await waitFor(started.status, state => state.status === 'failed', '夹具提交第一阶段');
  const settled = (await f.request(started.route + '/verification-plans')).body.proposals;
  assert.equal(settled.length, 1);
  assert.equal(settled[0].generationStage, 'http');
  assert.equal(settled[0].nextGenerationStage, 'http-supplement');
  assert.deepEqual(settled[0].missingHttpRequirementIds, [requirementIds.at(-1)]);
  assert.equal(settled[0].receiptState, 'saved');
  assert.equal(settled[0].actions.canApprove, false);
  assert.equal(f.calls.start, 0);
  await f.restart({ checkpoint: 'first-verification-stage' });
  await waitFor(started.status, state => !!state.executionId, '恢复并完成同运行三阶段');
  const rows = (await f.request(started.route + '/verification-plans')).body.proposals;
  assert.equal(rows[0].id, settled[0].id);
  assert.equal(rows[0].revision, settled[0].revision);
  assert.deepEqual(rows.map(row => [row.generationStage, row.origin, row.receiptState, row.status]),
    [['http', 'model', 'saved', 'draft'], ['http-supplement', 'model', 'saved', 'draft'], ['browser', 'model', 'saved', 'approved']]);
  assert.deepEqual(rows[2].proposal.steps, rows[1].proposal.steps);
  assert.equal(rows[2].history.some(entry => ['imported', 'revised'].includes(entry.status)), false);
  assert.deepEqual(f.calls, { spec: 1, engineering: 1, verification: 3, start: 1 });
});
