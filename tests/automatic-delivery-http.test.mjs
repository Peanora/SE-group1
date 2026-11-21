import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

async function fixture(t, { clarify = false, verificationDefinition = definition } = {}) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'automatic-delivery-http-'));
  const store = await new ProjectStore(directory).init();
  const calls = { spec: 0, engineering: 0, verification: 0, start: 0 };
  const executions = new Map();
  let app, verification;
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
  verification = await createVerificationPlanningService({ rootDir: path.join(directory, 'verification-planning'),
    getPlanning, getPlanningSync: getPlanning, config,
    dependencies: { createModel: () => async input => {
      calls.verification++;
      assert.equal(input.binding.specRevision.length, 64);
      await input.onReceipt({ model: config.model, finishReason: 'stop', usage, content: JSON.stringify(verificationDefinition) });
      return { proposal: verificationDefinition, model: config.model, usage, policyHash: verificationModelPolicy.hash, coverage: 'structural_only' };
    } },
  });
  const contractRevision = 'c'.repeat(64);
  const plannedExecutionService = {
    list: async identity => {
      const { proposals } = await verification.list(identity);
      const supportedProposalIds = proposals.filter(item => item.current && item.approved && item.proposal.browser).map(item => item.id);
      const row = executions.get(identity.runId);
      return { capabilities: { canStart: !!supportedProposalIds.length && !row?.active, contractRevision, supportedProposalIds },
        executions: row ? [structuredClone(row)] : [] };
    },
    start: async ({ projectId, runId, proposalId, revision, contractRevision: selected }, { subject }) => {
      assert.equal(selected, contractRevision);
      assert.equal(describeExecutionSubject(subject).kind, 'local');
      const { run } = getPlanning(projectId, runId);
      assert.equal(run.status, 'succeeded');
      assert.equal(run.approvals.plan.revision, run.planRevision);
      assert.equal(run.approvals.spec.revision, run.specRevision);
      const { proposals } = await verification.list({ projectId, runId });
      assert.ok(proposals.some(item => item.id === proposalId && item.revision === revision && item.approved));
      assert.equal(executions.has(runId), false);
      calls.start++;
      const execution = { id: randomUUID(), proposalId, revision, current: true, active: true, status: 'generating',
        binding: { planRevision: run.planRevision, specRevision: run.specRevision }, workflow: { stage: 'coding' }, actions: { canDownload: false } };
      executions.set(runId, execution);
      return { execution: structuredClone(execution) };
    },
    withProjectCheckpoint: async (_id, work) => work(),
    shutdown: async () => {},
  };
  app = await createApp({ store, executionService: null, sourceChangeService: null, verificationPlanningService: verification,
    plannedExecutionService, stepDelayMs: 0, agentEnvironment: {
      LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model, LLM_API_KEY: config.apiKey,
    }, planner: { ...planner, getModelConfig: () => ({ configured: true, model: config.model }),
      analyzeWithModel: (text, name, options) => {
        calls.spec++;
        const draft = clarify && calls.spec === 1 ? { ...spec, requirements: [], questions: [question], clarificationRequired: true } : spec;
        if (clarify && calls.spec === 2) assert.ok(text.includes(answer));
        return planner.analyzeWithModel(text, name, { ...options, config, fetchImpl: async () => modelResponse(draft) });
      },
      createEngineeringModel: () => createEngineeringModel({ config, fetchImpl: async () => {
        calls.engineering++;
        return modelResponse(engineeringDraft);
      } }),
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(route, body, headers) {
    const response = await fetch(origin + route, body === undefined ? { headers } : {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const created = await request('/api/projects', { name: '资源项目', filename: 'r.md', content: source });
  assert.equal(created.status, 201);
  const runsRoute = `/api/projects/${created.body.project.id}/runs`;
  return { request, runsRoute, calls, executions, async start(input = consent) {
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
