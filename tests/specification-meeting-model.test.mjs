import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { currentMeeting } from '../lib/specification-meeting.mjs';
import { createSpecificationMeetingModels } from '../lib/specification-meeting-model.mjs';
import { reservationMeetingPlanner, reservationMeetingSource } from '../examples/specification-meeting.mjs';

const stop = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const start = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const upstreamEnvelope = (content, usage) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage });

test('configured roles use independent requests and persist admission and exact-version conclusions before joint approval', { timeout: 60000 }, async t => {
  const calls = [];
  let persisted;
  let leaveUsageUnknown = true;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const context = JSON.parse(body.messages[1].content);
    calls.push({ context, model: body.model, reservation: await persisted?.() });
    const isProposal = Array.isArray(context.requirements);
    const reply = isProposal ? { rules: context.requirements.map(requirement => ({
      requirementId: requirement.id, rule: requirement.description, exception: '拒绝不符合当前条款的操作。', observable: requirement.acceptance,
      formatAcceptance: ['界面反馈可关联对应条款。'],
    })), issues: [], reservations: [] } : { evidence: '对应版本逐项核对已给定条款及可观察条件。', findings: [], resolutions: [] };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(upstreamEnvelope(reply, leaveUsageUnknown ? {} : { prompt_tokens: 52, completion_tokens: 18 })));
    leaveUsageUnknown = false;
  });
  const upstreamOrigin = await start(upstream);
  t.after(() => stop(upstream));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spec-roles-model-'));
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner: reservationMeetingPlanner,
    agentEnvironment: { LLM_BASE_URL: upstreamOrigin, LLM_MODEL: 'spec-local-test' }, executionService: null });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = await start(app.server);
  const project = await app.store.create({ name: '模型规格评审', source: { filename: 'reservation.md', content: reservationMeetingSource } });
  const run = await app.orchestrator.createRun(project.id);
  for (let count = 0; run.status !== 'awaiting_spec' && count < 350; count++) await delay(10);
  assert.equal(run.status, 'awaiting_spec');
  const health = await (await fetch(origin + '/api/health')).json();
  assert.equal(health.specificationMeeting.modelReview.available, true);
  const operation = payload => fetch(`${origin}/api/projects/${project.id}/runs/${run.id}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const begun = await operation({ action: 'start_spec_meeting', scenario: 'model_review', revision: run.specRevision });
  assert.equal(begun.status, 200, await begun.text());
  assert.equal(currentMeeting(run).kind, 'model_review');
  assert.equal(calls.length, 0);
  const bypass = await operation({ action: 'approve_spec', revision: run.specRevision });
  assert.equal(bypass.status, 409);
  persisted = async () => currentMeeting((await app.store.getPersistedRun(project.id, run.id)).run).modelRequests.attempts.at(-1).reserved;
  for (let index = 0; index < 6; index++) {
    const advanced = await operation({ action: 'advance_spec_meeting', roundId: currentMeeting(run).id, revision: run.specRevision });
    assert.equal(advanced.status, 200, await advanced.text());
  }
  const round = currentMeeting(run);
  assert.equal(round.status, 'awaiting_confirmation');
  assert.ok(round.featureReviews.some(feature => feature.checks.some(check => check.definitionSource === 'reviewed_business_proposal')));
  assert.ok(calls.some(call => call.context.role === 'access' && call.context.requirements));
  assert.ok(calls.some(call => call.context.role === 'independent' && call.context.proposalSeat === 'access'));
  assert.ok(calls.every(call => call.reservation > 0));
  assert.equal(round.modelRequests.attempts.reduce((sum, attempt) => sum + attempt.used, 0), calls.length);
  assert.equal(round.modelRequests.attempts[0].requests[0].usage.inputTokens, null);
  assert.ok(round.modelRequests.attempts.flatMap(attempt => attempt.requests).some(call => call.usage.outputTokens === 18));
  assert.equal(run.stages.find(stage => stage.id === 'architecture').attempt, 0);
  const confirmed = await operation({ action: 'approve_spec', revision: run.specRevision, meetingRevision: round.bundleRevision });
  assert.equal(confirmed.status, 200, await confirmed.text());
  assert.equal(round.confirmation.kind, 'human_confirmation_of_model_review');
});

test('model messages cannot forge platform binding or smuggle provider credentials into review evidence', async () => {
  const key = 'test-credential-should-never-appear';
  const request = { nodeId: 'baseline', role: 'independent', artifactRevision: 'known-revision', binding: { specRevision: 'known-spec' },
    artifact: {}, obligations: [{ id: 'prior-finding' }] };
  const resolve = () => ({ baseUrl: 'http://127.0.0.1:9999', model: 'role-test', apiKey: key });
  const reply = { role: 'another', artifactRevision: 'spoofed', binding: {}, passed: true,
    evidence: '当前修订仍缺证明。', findings: [], resolutions: [{ id: 'prior-finding', resolved: false, evidence: '缺少规则。' }] };
  const fetchImpl = async () => new Response(JSON.stringify(upstreamEnvelope(reply)));
  const models = createSpecificationMeetingModels({ resolve, fetchImpl });
  const result = await models.review(request);
  assert.equal(result.role, request.role);
  assert.equal(result.artifactRevision, request.artifactRevision);
  assert.deepEqual(result.binding, request.binding);
  assert.equal(result.passed, false);
  reply.evidence = key;
  await assert.rejects(models.review(request), error => error.message.includes('凭据') && !error.message.includes(key));
});
