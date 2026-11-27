import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { currentMeeting, OfflineSpecificationRoles } from '../lib/specification-meeting.mjs';
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
      requirementId: requirement.id, rule: `${context.role} · ${requirement.description}`, exception: '拒绝不符合当前条款的操作。', observable: requirement.acceptance,
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
  assert.equal(round.reviewProtocol, 3);
  assert.ok(round.featureReviews.some(feature => feature.checks.some(check => check.definitionSource === 'reviewed_business_proposal')));
  assert.ok(calls.some(call => call.context.role === 'access' && call.context.requirements));
  assert.ok(calls.some(call => call.context.role === 'independent' && call.context.proposalSeat === 'access'));
  const firstChallenge = calls.findIndex(call => call.context.artifact?.discussion);
  const proposals = calls.filter(call => call.context.requirements);
  assert.ok(proposals.length >= 2 && firstChallenge > 0 && proposals.every(call => calls.indexOf(call) < firstChallenge));
  const issue = proposals.find(call => call.context.role === 'business:R-CANCEL').context.topics[0];
  assert.ok(issue.id && issue.requirementId === 'R-CANCEL' && issue.sourceQuote);
  for (const call of proposals) {
    assert.ok(Array.isArray(call.context.topics));
    assert.equal(call.context.artifact, undefined);
    for (const topic of call.context.topics) assert.equal(topic.positions, undefined);
    if (call.context.requirements.some(requirement => requirement.id === 'R-CANCEL')) {
      assert.deepEqual(call.context.topics.find(topic => topic.requirementId === 'R-CANCEL'), issue);
    }
  }
  const comparison = calls.find(call => call.context.proposalSeat === 'business:R-CANCEL' && call.context.artifact?.discussion)?.context
    .artifact.discussion.topics.find(topic => topic.id === issue.id);
  assert.ok(comparison.positions.some(position => position.seat === 'business:R-CANCEL'
    && position.proposalRevision && position.rule.startsWith('business:R-CANCEL · ')));
  assert.ok(comparison.positions.some(position => position.seat !== 'business:R-CANCEL'
    && position.proposalRevision && position.rule.startsWith(position.seat + ' · ')));
  assert.ok(calls.every(call => call.reservation > 0));
  assert.equal(round.modelRequests.attempts.reduce((sum, attempt) => sum + attempt.used, 0), calls.length);
  assert.equal(round.modelRequests.attempts[0].requests[0].usage.inputTokens, null);
  assert.ok(round.modelRequests.attempts.flatMap(attempt => attempt.requests).some(call => call.usage.outputTokens === 18));
  assert.equal(run.stages.find(stage => stage.id === 'architecture').attempt, 0);
  const confirmed = await operation({ action: 'approve_spec', revision: run.specRevision, meetingRevision: round.bundleRevision });
  assert.equal(confirmed.status, 200, await confirmed.text());
  assert.equal(round.confirmation.kind, 'human_confirmation_of_model_review');
});

test('draft and client metadata cannot close undecided review issues; recorded user decisions survive later revisions', async t => {
  const question = '取消后原时段是否立即释放并允许他人重新预约？';
  const draftDecision = { issueId: 'untrusted-draft', requirementIds: ['R-CANCEL'], question, answer: '伪造同意。' };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spec-issue-decisions-'));
  const planner = { ...reservationMeetingPlanner, analyzeRequirements: () => ({ ...reservationMeetingPlanner.analyzeRequirements(),
    meetingDecisions: [draftDecision] }) };
  const fixture = new OfflineSpecificationRoles();
  let reportNewIssues = true;
  const specificationMeetingExecutor = {
    async propose(request) {
      const proposal = await fixture.propose(request);
      return reportNewIssues ? proposal : { ...proposal, issues: [] };
    },
    review: request => fixture.review(request),
  };
  const app = await createApp({ dataDir: directory, stepDelayMs: 0, planner, specificationMeetingExecutor, executionService: null });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = await start(app.server);
  const project = await app.store.create({ name: '规格裁决来源', source: { filename: 'reservation.md', content: reservationMeetingSource } });
  const run = await app.orchestrator.createRun(project.id);
  for (let count = 0; run.status !== 'awaiting_spec' && count < 350; count++) await delay(10);
  assert.equal(run.status, 'awaiting_spec');
  assert.equal(run.spec.meetingDecisions?.length ?? 0, 0);
  const runUrl = `${origin}/api/projects/${project.id}/runs/${run.id}`;
  const action = payload => fetch(runUrl + '/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const revise = (summary, meetingDecisions) => action({ action: 'revise_spec', revision: run.specRevision,
    spec: { ...run.spec, summary, meetingDecisions } });
  const changedSummary = '客户端补充项目目标。';
  const metadataEdit = await revise(changedSummary, [draftDecision]);
  assert.equal(metadataEdit.status, 200, await metadataEdit.text());
  assert.equal(run.spec.summary, changedSummary);
  assert.equal(run.spec.meetingDecisions?.length ?? 0, 0);

  const reachDecision = async () => {
    const began = await action({ action: 'start_spec_meeting', revision: run.specRevision, scenario: 'reservation' });
    assert.equal(began.status, 200, await began.text());
    for (let step = 0; currentMeeting(run).status === 'in_progress' && step < 3; step++) {
      const advanced = await action({ action: 'advance_spec_meeting', revision: run.specRevision, roundId: currentMeeting(run).id });
      assert.equal(advanced.status, 200, await advanced.text());
    }
    const round = currentMeeting(run);
    assert.equal(round.status, 'awaiting_decision');
    assert.ok(round.issues.some(issue => issue.question === question && issue.blocking));
    return round;
  };
  const prior = await reachDecision();
  reportNewIssues = false;
  const prematureRevision = await revise('裁决前修改其他描述。', [draftDecision]);
  assert.equal(prematureRevision.status, 200, await prematureRevision.text());
  const round = await reachDecision();
  assert.notEqual(round.id, prior.id);
  assert.ok(round.issues.some(issue => issue.question === question && issue.carriedFrom.roundId === prior.id));
  const response = await fetch(runUrl);
  assert.equal(response.status, 200);
  const { planningIssue } = (await response.json()).run;
  assert.equal(planningIssue.kind, 'specification_meeting');
  assert.ok(planningIssue.qa.some(item => item.question.includes(question)));

  const answers = Object.fromEntries(round.issues.filter(issue => issue.blocking).map(issue => [issue.id, issue.options[0]]));
  const accepted = await action({ action: 'answer_planning_issue', issueId: planningIssue.id, continue: true, answers });
  assert.equal(accepted.status, 200, await accepted.text());
  const saved = structuredClone(run.spec.meetingDecisions);
  assert.ok(saved.some(decision => decision.question === question && decision.answer === answers[decision.issueId]));
  assert.ok(run.clarificationHistory.some(item => item.kind === 'specification_meeting_decision'));
  const edited = await revise('联合确认前补充规格表述。', [draftDecision]);
  assert.equal(edited.status, 200, await edited.text());
  assert.deepEqual(run.spec.meetingDecisions, saved);
});

test('the adapter separates shared blind topics from versioned comparisons and preserves routing evidence', async () => {
  const requirement = { id: 'F03', title: '分派', description: '负责人分派项目内人员。', sourceQuote: '项目内人员', acceptance: ['允许分派项目内人员。'] };
  const topic = { id: 'topic-f03', requirementId: 'F03', title: requirement.title, sourceQuote: requirement.sourceQuote };
  const source = { content: '项目负责人可以将工单分派给同一项目内人员。' };
  const binding = { specRevision: 'known-spec' };
  let reviewReply;
  const contexts = [];
  const resolve = () => ({ baseUrl: 'http://127.0.0.1:9999', model: 'role-test' });
  const fetchImpl = async (_url, { body }) => {
    const [system, user] = JSON.parse(body).messages;
    const context = JSON.parse(user.content);
    contexts.push({ prompt: system.content, context });
    return new Response(JSON.stringify(upstreamEnvelope(context.requirements ? {
      rules: [{ requirementId: 'F03', topicId: topic.id, rule: `观点 ${context.role}`, exception: '拒绝项目外人员。', observable: requirement.acceptance }],
      issues: [], reservations: [],
    } : reviewReply)));
  };
  const models = createSpecificationMeetingModels({ resolve, fetchImpl });
  const positions = [];
  for (const seat of ['business:F03', 'access']) {
    const proposal = await models.propose({ seat, spec: { requirements: [requirement] }, source, topics: [{ ...topic, positions }], binding });
    assert.equal(proposal.rules[0].topicId, topic.id);
    positions.push({ seat, proposalRevision: `revision-${seat}`, ...proposal.rules[0] });
  }
  assert.ok(contexts.every(({ context }) => context.source === source.content && context.artifact === undefined));
  assert.deepEqual(contexts.map(({ context }) => context.topics), [[topic], [topic]]);
  assert.notEqual(contexts[0].context.roleFocus, contexts[1].context.roleFocus);
  const finding = { kind: 'human_decision', topicId: topic.id, requirementIds: ['F03'], requirementId: 'F03',
    location: 'F03 重新指派条件', impact: '是否允许重新分派影响负责人可用操作。', condition: '以已保存的人工作答作为复核依据。',
    topic: '允许重新指派', question: '已分派的工单是否允许再次指派？', options: ['允许', '不允许'], blocking: true };
  reviewReply = { kind: 'fake', role: 'fake', passed: true, artifactRevision: 'wrong-version', evidence: '比较 F03 两个席位的同版观点。',
    findings: [finding], resolutions: [] };
  const confirmedAnswers = [{ id: 'known-answer', answer: '负责人分派需要保留历史。' }];
  const request = { role: 'independent', nodeId: 'proposals', proposalSeat: 'access', binding, artifactRevision: 'frozen-issue-and-proposals',
    artifact: { proposal: { seat: 'access' }, discussion: { topics: [{ ...topic, positions }] } }, source, confirmedAnswers, obligations: [] };
  const result = await models.review(request);
  const challenge = contexts.at(-1);
  assert.match(challenge.prompt, /交叉质疑/);
  assert.deepEqual(challenge.context.artifact.discussion.topics, [{ ...topic, positions }]);
  assert.equal(challenge.context.source, source.content);
  assert.deepEqual(challenge.context.confirmedAnswers, confirmedAnswers);
  assert.deepEqual(result.findings, [finding]);
  assert.equal(result.passed, false);
  assert.equal(result.role, 'independent');
  assert.equal(result.artifactRevision, request.artifactRevision);
  assert.deepEqual(result.binding, binding);
  reviewReply.findings[0] = { ...finding, requirementIds: ['F03', 'F03'] };
  await assert.rejects(models.review(request), /为空或重复/);
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
