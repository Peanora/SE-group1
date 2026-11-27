import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { ProjectStore } from '../lib/store.mjs';
import { assertSpecApproval, contentRevision } from '../lib/planning-review.mjs';
import { OfflineSpecificationRoles, currentMeeting, assertSpecificationMeeting, startSpecificationMeeting } from '../lib/specification-meeting.mjs';
import { reservationMeetingPlanner, reservationMeetingSource } from '../examples/specification-meeting.mjs';

async function until(predicate) { for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(5); } assert.fail('等待规格停点超时'); }
export async function meetingFixture(t, options = {}) {
  const { sourceContent = reservationMeetingSource, ...appOptions } = options;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spec-meeting-'));
  const app = await createApp({ dataDir: directory, planner: reservationMeetingPlanner, stepDelayMs: 0, ...appOptions });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const project = await app.store.create({ name: '预约规格评审', source: { filename: 'reservation.md', content: sourceContent } });
  const run = await app.orchestrator.createRun(project.id);
  await until(() => run.status === 'awaiting_spec' && !app.orchestrator.state(run).driving && !app.orchestrator.state(run).active.size);
  const action = body => app.orchestrator.action(project.id, run.id, body);
  const start = scenario => action({ action: 'start_spec_meeting', revision: run.specRevision, scenario });
  const advance = () => action({ action: 'advance_spec_meeting', revision: run.specRevision, roundId: currentMeeting(run).id });
  const drive = async () => { for (let step = 0; step < 18 && currentMeeting(run).status === 'in_progress'; step++) await advance(); };
  const answer = async () => {
    const issue = (await app.orchestrator.describeRun(project, run)).planningIssue;
    return action({ action: 'answer_planning_issue', issueId: issue.id, continue: true,
      answers: Object.fromEntries(currentMeeting(run).issues.filter(i => i.blocking).map(i => [i.id, i.options[0]])) });
  };
  return { directory, app, project, run, action, start, advance, drive, answer };
}

test('同一异议保留各席选项和影响，后出现的阻塞不能被首个非阻塞意见掩盖', async t => {
  const roles = new OfflineSpecificationRoles();
  const f = await meetingFixture(t, { specificationMeetingExecutor: {
    async propose(request) {
      const proposal = await roles.propose(request);
      const requirementIds = request.spec.requirements.map(item => item.id);
      proposal.issues = ['interaction', 'data'].includes(request.seat) ? [{ topic: 'shared-issue',
        question: '失败后的界面反馈方式如何统一？', requirementIds: request.seat === 'data' ? requirementIds.reverse() : requirementIds,
        options: request.seat === 'data' ? ['显示字段反馈', '展示可恢复提示'] : ['显示字段反馈', '跳转详情提示'],
        impact: request.seat === 'data' ? '需要保留原记录' : '需要明确可见结果', blocking: request.seat === 'data' }] : [];
      return proposal;
    },
    review: request => roles.review(request),
  } });
  await f.start('reservation');
  await f.drive();
  const round = currentMeeting(f.run);
  assert.equal(round.status, 'awaiting_decision');
  assert.equal(round.issues.length, 1);
  const [issue] = round.issues;
  assert.equal(issue.blocking, true);
  assert.deepEqual(issue.roles, ['interaction', 'data']);
  assert.deepEqual(issue.options, ['显示字段反馈', '跳转详情提示', '展示可恢复提示']);
  assert.match(issue.impact, /需要明确可见结果\n需要保留原记录/u);
});

test('权限/数据关联异议→查看问题→裁决新版本→全席同版复核→规格和清单联合确认才规划', async t => {
  const f = await meetingFixture(t); await f.start('reservation'); const initial = f.run.specRevision;
  await f.drive(); const old = currentMeeting(f.run);
  assert.equal(old.status, 'awaiting_decision'); assert.equal(old.issues.length, 2);
  assert.deepEqual(new Set(old.issues.flatMap(i => i.roles)), new Set(['data', 'access']));
  assert.equal(new Set(old.issues.map(i => i.topic)).size, 1);
  assert.ok(old.issues.every(i => i.requirementIds.includes('R-CANCEL')));
  await assert.rejects(f.action({ action: 'approve_spec', revision: initial }), /不能绕过/);
  const issue = (await f.app.orchestrator.describeRun(f.project, f.run)).planningIssue;
  assert.equal(issue.kind, 'specification_meeting'); assert.equal(issue.autoExplain, false);
  await assert.rejects(f.action({ action: 'explain_planning_issue', issueId: issue.id }), /不请求付费/);
  await assert.rejects(f.action({ action: 'answer_planning_issue', issueId: issue.id, continue: true, answers: {} }), /全部阻塞/);
  await f.answer(); assert.notEqual(f.run.specRevision, initial); assert.equal(f.run.specReview.rounds.length, 2);
  assert.equal(currentMeeting(f.run).nodes[0].status, 'pending'); assert.equal(f.run.approvals.spec, null);
  assert.equal(f.run.stages.find(s => s.id === 'architecture').status, 'pending');
  await f.drive(); const round = currentMeeting(f.run);
  assert.equal(round.status, 'awaiting_confirmation'); assert.ok(round.nodes.every(n => n.status === 'passed' && n.selfTest.passed));
  assert.equal(round.checklist.length, 6); assert.ok(round.checklist.every(row => row.rules.length === 2 && row.rules.every(r => r.executed === false)));
  assert.ok(round.proposals.every(proposal => proposal.status === 'passed' && proposal.artifactRevision === proposal.selfTest.artifactRevision
    && proposal.reviews.length === 2 && proposal.reviews.every(review => review.role !== proposal.seat
      && review.proposalSeat === proposal.seat && review.artifactRevision === proposal.artifactRevision)));
  assert.deepEqual(round.featureReviews.map(feature => feature.id), ['review:R-CANCEL', 'review:R-UNIQUE']);
  assert.ok(round.featureReviews.every(feature => feature.definitionOnly && !feature.executed
    && feature.checks.some(check => check.kind === 'behavior') && feature.checks.some(check => check.kind === 'format')));
  assert.equal(round.nodes.find(node => node.id === 'confirmation').artifact.featureReviewRevision, contentRevision(round.featureReviews));
  assert.equal(round.nodes.find(node => node.id === 'specification').artifact.proposalEvidence.length, round.proposals.length);
  assert.ok(round.nodes.find(n => n.id === 'specification').reviews.some(r => r.role === 'data'));
  assert.ok(round.nodes.find(n => n.id === 'specification').reviews.some(r => r.role === 'access'));
  assert.ok(round.coverage.every(row => row.owner !== row.reviewer && row.observable.length && row.specialists.includes('reliability')));
  assertSpecificationMeeting(f.run); assert.throws(() => assertSpecApproval(f.run), /联合确认/);
  await assert.rejects(f.action({ action: 'approve_spec', revision: f.run.specRevision, meetingRevision: old.bundleRevision ?? 'old' }), /确认包版本/);
  const store = await new ProjectStore(f.directory).init(); assert.equal(currentMeeting(store.get(f.project.id).runs[0]).bundleRevision, round.bundleRevision);
  await f.action({ action: 'approve_spec', revision: f.run.specRevision, meetingRevision: round.bundleRevision, feedback: '核对本版规格、会议决议及六阶段清单' });
  await until(() => f.run.status === 'awaiting_review'); assertSpecApproval(f.run);
  assert.equal(currentMeeting(f.run).confirmation.bundleRevision, round.bundleRevision);
  assert.ok(f.run.artifacts.some(a => a.name === 'spec-review-minutes.json' && a.content.includes('human_confirmation_of_offline_review')));
  assert.ok(f.run.artifacts.some(a => a.name === 'stage-review-checklist.json' && a.content.includes('definitionOnly')));
  assert.equal(f.run.revisionHistory.spec[0].revision, initial);
  await new Promise(resolve => f.app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${f.app.server.address().port}/api/projects/${f.project.id}/runs/${f.run.id}`;
  const evidence = await (await fetch(`${base}/artifacts/reviewed-design-specification.json`)).json();
  assert.equal(evidence.bundleRevision, round.bundleRevision);
  assert.equal(evidence.confirmation.specRevision, round.binding.specRevision);
  assert.equal(evidence.artifactRevision, contentRevision(evidence.specification));
  assert.equal(evidence.specification.proposalEvidence.length, round.proposals.length);
  const checklist = await (await fetch(`${base}/artifacts/stage-review-checklist.json`)).json();
  assert.equal(checklist.bundleRevision, evidence.bundleRevision);
  assert.deepEqual(checklist.featureReviews, round.featureReviews);
  await f.action({ action: 'approve_plan', revision: f.run.planRevision, specRevision: f.run.specRevision });
  await until(() => f.run.status === 'succeeded');
  const zip = await fetch(`${base}/download`);
  assert.equal(zip.status, 200);
  const archived = Buffer.from(await zip.arrayBuffer());
  assert.ok(archived.includes(Buffer.from('reviewed-design-specification.json')) && archived.includes(Buffer.from('stage-review-checklist.json')));
});

test('各专业提案锁定各自产物，忽略陈旧回执并续审缺席席位，格式规则只采纳已放行的所属业务提案', async t => {
  const base = new OfflineSpecificationRoles();
  const proposedSeats = [];
  let malformed = true, stale = true;
  const executor = {
    propose: async request => {
      proposedSeats.push(request.seat);
      const proposal = await base.propose(request);
      if (request.seat === 'business:R-UNIQUE') {
        proposal.rules[0].formatAcceptance = malformed ? ['x'.repeat(1201)] : ['拒绝须返回明确错误提示，结果保留最终占用状态。'];
      }
      if (request.seat === 'interaction') proposal.rules[0].formatAcceptance = ['非所属业务提案的格式建议保留在评审证据。'];
      return proposal;
    },
    review: async request => {
      const review = await base.review(request);
      if (stale && request.proposalSeat === 'business:R-CANCEL' && request.role === 'independent') review.artifactRevision = '1'.repeat(64);
      return review;
    },
  };
  const f = await meetingFixture(t, { specificationMeetingExecutor: executor });
  await f.start('reservation'); await f.advance(); await f.advance();
  const stopped = currentMeeting(f.run);
  assert.equal(stopped.status, 'waiting');
  assert.equal(stopped.nodes[2].status, 'pending');
  assert.ok(!stopped.proposals.some(proposal => proposal.seat === 'business:R-UNIQUE'));
  assert.equal(stopped.proposals.find(proposal => proposal.seat === 'business:R-CANCEL').status, 'waiting');
  assert.ok(stopped.nodes[1].attempts[0].ignored.some(item => item.proposalSeat === 'business:R-CANCEL'));
  const afterFirst = proposedSeats.length;
  malformed = false; stale = false; await f.advance();
  assert.equal(currentMeeting(f.run).nodes[1].status, 'passed');
  assert.deepEqual(proposedSeats.slice(afterFirst), ['business:R-UNIQUE'], '同版本其他已冻结提案不会重新生成');
  await f.drive(); await f.answer(); await f.drive();
  const finished = currentMeeting(f.run);
  const fromProposal = finished.featureReviews.find(feature => feature.requirementId === 'R-UNIQUE').checks.find(check => check.kind === 'format');
  assert.equal(fromProposal.definitionSource, 'reviewed_business_proposal');
  assert.equal(fromProposal.expected, '拒绝须返回明确错误提示，结果保留最终占用状态。');
  assert.equal(fromProposal.proposalRevision, finished.proposals.find(proposal => proposal.seat === 'business:R-UNIQUE').artifactRevision);
  const pending = finished.featureReviews.find(feature => feature.requirementId === 'R-CANCEL').checks.find(check => check.kind === 'format');
  assert.equal(pending.definitionStatus, 'pending');
  assertSpecificationMeeting(f.run);
});

test('提案被独立 Review 退回时保持下游等待，修订后由同席位逐条关闭，模型轮不能降级为离线', async t => {
  const base = new OfflineSpecificationRoles();
  const condition = '失败时保持原记录';
  const executor = {
    propose: request => base.propose(request),
    review: async request => {
      const result = await base.review(request);
      if (request.proposalSeat !== 'business:R-UNIQUE' || request.role !== 'independent') return result;
      const satisfied = request.artifact.proposal.rules[0].observable.some(text => text.includes(condition));
      return { ...result, passed: satisfied, findings: satisfied ? [] : [{
        location: 'R-UNIQUE.acceptance', impact: '失败后未明确原记录状态', condition, blocking: true,
      }], resolutions: request.obligations.map(item => ({ id: item.id, resolved: satisfied, evidence: '已核对此席当前版本可观察结果与原条件。' })) };
    },
  };
  const f = await meetingFixture(t, { specificationMeetingExecutor: executor });
  await f.start('reservation'); await f.drive();
  const previous = currentMeeting(f.run), proposal = previous.proposals.find(item => item.seat === 'business:R-UNIQUE');
  assert.equal(proposal.selfTest.passed, true);
  assert.equal(proposal.status, 'rejected');
  assert.equal(previous.nodes[1].blocking[0].proposalSeat, proposal.seat);
  assert.equal(previous.nodes[2].status, 'pending');
  await assert.rejects(f.advance(), /实际修订/);
  const spec = structuredClone(f.run.spec); spec.requirements.find(r => r.id === 'R-UNIQUE').acceptance.push(condition);
  await f.action({ action: 'revise_spec', revision: f.run.specRevision, spec });
  await f.start('reservation'); await f.drive(); await f.answer(); await f.drive();
  const reviewed = currentMeeting(f.run);
  assertSpecificationMeeting(f.run);
  const resolved = reviewed.proposals.find(item => item.seat === proposal.seat).reviews.find(item => item.role === 'independent');
  assert.ok(reviewed.obligations.length && reviewed.obligations.every(item => resolved.resolutions.some(result => result.id === item.id && result.resolved)));

  const model = await meetingFixture(t);
  startSpecificationMeeting(model.run, { revision: model.run.specRevision, scenario: 'model_review' });
  const edited = structuredClone(model.run.spec); edited.title += ' 修订';
  await model.action({ action: 'revise_spec', revision: model.run.specRevision, spec: edited });
  await assert.rejects(model.start('reservation'), /须继续模型评审/);
});

test('自测通过但Review退回，下游保持等待；实际修订后新版本重审', async t => {
  const f = await meetingFixture(t); await f.start('reject_review'); await f.drive(); await f.answer(); await f.drive();
  const rejected = currentMeeting(f.run), node = rejected.nodes.find(n => n.id === 'specification');
  assert.equal(node.selfTest.passed, true); assert.equal(node.status, 'rejected'); assert.equal(rejected.status, 'blocked');
  assert.match(node.blocking[0].condition, /失败时保持原记录/);
  await assert.rejects(f.advance(), /实际修订/);
  await assert.rejects(f.start('reservation'), /不能原样重开/);
  await assert.rejects(f.action({ action: 'approve_spec', revision: f.run.specRevision, meetingRevision: 'fake' }), /尚未通过/);
  const spec = structuredClone(f.run.spec); spec.requirements[0].acceptance.push('失败时保持原记录，并给出反馈。');
  await f.action({ action: 'revise_spec', revision: f.run.specRevision, spec });
  assert.throws(() => assertSpecificationMeeting(f.run), /版本已变化/);
  await f.start('reject_review'); await f.drive();
  assert.equal(currentMeeting(f.run).status, 'awaiting_confirmation'); assert.equal(rejected.nodes[3].status, 'rejected');
  assert.equal(f.run.stages.find(s => s.id === 'architecture').attempt, 0);
});

test('旧版本Review迟到被保留但不计入放行，重试只接受当前版本', async t => {
  const f = await meetingFixture(t); await f.start('late_review'); await f.drive(); await f.answer(); await f.drive();
  const round = currentMeeting(f.run), node = round.nodes[3];
  assert.equal(round.status, 'waiting'); assert.equal(node.status, 'awaiting_review'); assert.equal(round.nodes[4].status, 'pending');
  assert.ok(node.attempts[0].ignored.length); assert.equal(node.attempts[0].reviewReceipts.at(-1).binding.specRevision, '0'.repeat(64));
  await assert.rejects(f.action({ action: 'approve_spec', revision: f.run.specRevision, meetingRevision: 'fake' }), /尚未通过/);
  await f.advance(); await f.drive(); assert.equal(currentMeeting(f.run).status, 'awaiting_confirmation');
  assert.equal(currentMeeting(f.run).nodes[3].attempts.length, 2); assert.ok(currentMeeting(f.run).nodes[3].reviews.every(review => review.binding.specRevision === f.run.specRevision));
});

test('缺席和超时保持等待，不能伪造Review完成；覆盖和联合清单篡改撤销放行', async t => {
  const base = new OfflineSpecificationRoles(); let missing = true;
  const executor = { propose: request => request.seat === 'data' && missing ? null : base.propose(request), review: request => base.review(request) };
  const f = await meetingFixture(t, { specificationMeetingExecutor: executor, specificationMeetingTimeoutMs: 20 });
  await f.start('reservation'); await f.advance(); await f.advance();
  assert.equal(currentMeeting(f.run).status, 'waiting'); assert.equal(currentMeeting(f.run).nodes[2].status, 'pending');
  missing = false; await f.advance(); await f.drive(); await f.answer(); await f.drive();
  const round = currentMeeting(f.run); assertSpecificationMeeting(f.run);
  const featureReviews = structuredClone(round.featureReviews);
  round.featureReviews[0].checks[0].expected = '擅改验收定义';
  assert.throws(() => assertSpecificationMeeting(f.run), /产物已变化/);
  round.featureReviews = featureReviews;
  round.checklist[0].rules = []; assert.throws(() => assertSpecificationMeeting(f.run), /产物已变化/);
  const timeout = await meetingFixture(t, { specificationMeetingExecutor: { ...executor, review: () => new Promise(() => {}) }, specificationMeetingTimeoutMs: 10 });
  await timeout.start('reservation'); await timeout.advance(); assert.equal(currentMeeting(timeout.run).status, 'waiting');
  assert.match(currentMeeting(timeout.run).nodes[0].attempts[0].reason, /超时/);
  await assert.rejects(timeout.action({ action: 'advance_spec_meeting', revision: timeout.run.specRevision, roundId: currentMeeting(timeout.run).id, passed: true }), /客户端/);
});

test('不含提案分席 Review 字段的历史轮次仍可核对原联合包并读回', async t => {
  const base = new OfflineSpecificationRoles();
  const f = await meetingFixture(t, { specificationMeetingExecutor: {
    propose: async request => ({ ...await base.propose(request), issues: [], sourceResolutions: [] }),
    review: request => base.review(request),
  } });
  await f.start('reservation');
  delete currentMeeting(f.run).reviewProtocol;
  await f.drive();
  const round = currentMeeting(f.run);
  assert.equal(round.status, 'awaiting_confirmation');
  assert.ok(round.proposals.every(proposal => !Object.hasOwn(proposal, 'reviews')));
  assert.equal(round.featureReviews, undefined);
  const bundle = round.bundleRevision;
  await f.action({ action: 'approve_spec', revision: f.run.specRevision, meetingRevision: bundle });
  await until(() => f.run.status === 'awaiting_review');
  const stored = await new ProjectStore(f.directory).init();
  const saved = stored.get(f.project.id).runs[0];
  assert.equal(currentMeeting(saved).bundleRevision, bundle);
  assertSpecApproval(saved);
});

test('保存失败不放行；服务重开保留会议与人工问题', async t => {
  const f = await meetingFixture(t); const save = f.app.store.save.bind(f.app.store);
  f.app.store.save = async () => { throw new Error('模拟磁盘失败'); };
  await assert.rejects(f.start('reservation'), /保存失败/); assert.equal(f.run.specReview, undefined);
  f.app.store.save = save; await f.start('reservation'); await f.drive();
  await f.app.close();
  const reopened = await createApp({ dataDir: f.directory, planner: reservationMeetingPlanner, stepDelayMs: 0 });
  try {
    const run = reopened.store.getRun(f.project.id, f.run.id).run;
    assert.equal(currentMeeting(run).status, 'awaiting_decision');
    assert.equal((await reopened.orchestrator.describeRun(reopened.store.get(f.project.id), run)).planningIssue.qa.length, 2);
  } finally { await reopened.close(); }
});

test('原文明确规则可裁决，但必须生成新规格并重新经过全席Review', async t => {
  const f = await meetingFixture(t, { sourceContent: `${reservationMeetingSource}\n取消后原时段立即重新可预约。仅预约本人及管理员可取消。` });
  const initial = f.run.specRevision; await f.start('reservation'); await f.drive();
  assert.equal(currentMeeting(f.run).status, 'awaiting_confirmation');
  assert.notEqual(f.run.specRevision, initial); assert.equal(f.run.specReview.rounds.length, 2);
  assert.equal(f.run.clarificationHistory?.length ?? 0, 0);
  assert.equal(f.run.spec.meetingDecisions.length, 2);
  assert.ok(f.run.spec.meetingDecisions.every(d => d.basis === '原文或已确认答复'));
  assert.ok(currentMeeting(f.run).nodes.every(n => n.reviews.every(r => r.binding.specRevision === f.run.specRevision)));
  assertSpecificationMeeting(f.run);
});

test('切换场景和无关修订不能遗忘旧阻塞，原复核条件满足后才关闭', async t => {
  const f = await meetingFixture(t); await f.start('reject_review'); await f.drive(); await f.answer(); await f.drive();
  let spec = structuredClone(f.run.spec); spec.title += ' 修订标题';
  await f.action({ action: 'revise_spec', revision: f.run.specRevision, spec });
  await f.start('reservation'); await f.drive();
  assert.equal(currentMeeting(f.run).status, 'blocked');
  assert.ok(currentMeeting(f.run).obligations.length > 0);
  assert.match(currentMeeting(f.run).nodes[3].blocking[0].condition, /失败时保持原记录/);
  spec = structuredClone(f.run.spec); spec.requirements[0].acceptance.push('失败时保持原记录');
  await f.action({ action: 'revise_spec', revision: f.run.specRevision, spec });
  await f.start('reservation'); await f.drive();
  assertSpecificationMeeting(f.run);
  const round = currentMeeting(f.run), review = round.nodes[3].reviews.find(r => r.role === 'independent');
  assert.ok(round.obligations.every(o => review.resolutions.some(r => r.id === o.id && r.resolved)));
});

test('在途Review锁拒绝并发操作；答复版本变化使已有Review作废', async t => {
  const base = new OfflineSpecificationRoles(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await meetingFixture(t, { specificationMeetingExecutor: {
    propose: request => base.propose(request), review: async request => { entered(); await gate; return base.review(request); },
  } });
  await f.start('reservation'); const advancing = f.advance(); await started;
  await assert.rejects(f.start('reservation'), /正在|处理中|忙/);
  release(); await advancing; assert.equal(currentMeeting(f.run).nodes[0].status, 'passed');
  f.run.clarificationHistory = [{ answers: [{ answer: '新的已确认答复' }] }];
  await assert.rejects(f.advance(), /版本已变化/);
});
