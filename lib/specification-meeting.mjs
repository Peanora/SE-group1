import { randomUUID } from 'node:crypto';
import { HttpError } from './documents.mjs';
import { contentRevision } from './planning-review.mjs';

const need = (condition, message, status = 409) => { if (!condition) throw new HttpError(status, message); };
const now = () => new Date().toISOString();
export const MEETING_NODES = [
  { id: 'baseline', title: '确认需求基线', owner: 'product' },
  { id: 'proposals', title: '形成专业提案', owner: 'facilitator' },
  { id: 'decisions', title: '讨论并决策', owner: 'facilitator' },
  { id: 'specification', title: '汇编设计规格', owner: 'author' },
  { id: 'checklist', title: '确定阶段 Review 要求', owner: 'acceptance' },
  { id: 'confirmation', title: '提交用户确认', owner: 'author' },
];
export const MEETING_ROLES = { facilitator: '会议主持', product: '产品需求', author: '规格主笔', acceptance: '验收设计', independent: '独立 Review',
  interaction: '交互席', data: '数据席', access: '权限席', interface: '接口席', reliability: '可靠性席' };
export const DELIVERY_STAGES = [
  { id: 'architecture', title: '架构设计', owner: 'architect', condition: '每条关键需求定位承载模块、接口责任和失败行为', evidence: '同版本架构、模块/需求映射和独立Review' },
  { id: 'tasks', title: '任务拆解', owner: 'pm', condition: '每条规格有任务承接，任务具备输入、产物、依赖和验收', evidence: '任务图、需求覆盖及写入冲突检查' },
  { id: 'acceptance', title: '验收设计', owner: 'tester', condition: '关键规则有可执行断言，覆盖适用的正常、异常、权限及边界', evidence: '已批准的测试定义、可观察断言和规则覆盖' },
  { id: 'development', title: '单任务开发', owner: 'developer', condition: '同一候选提交自测、独立测试和代码Review通过，阻塞关闭', evidence: '命令、退出码、结果、候选提交及独立Review' },
  { id: 'integration', title: '集成验证', owner: 'integrator', condition: '同一集成提交通过跨模块端到端、数据一致性及关键回归', evidence: '集成提交、接口/数据库/浏览器端到端运行结果' },
  { id: 'delivery', title: '交付', owner: 'delivery', condition: '规格、代码、测试、Review及交付包同版可核对并可运行', evidence: '交付绑定、包哈希及干净目录启动记录' },
];
const specialists = run => [...run.spec.requirements.map(r => `business:${r.id}`), 'interaction', 'data', 'access', 'interface', 'reliability'];
export const currentMeeting = run => run.specReview?.rounds?.find(round => round.id === run.specReview.currentRoundId) ?? null;
const binding = run => ({ projectId: run.projectId, runId: run.id, sourceRevision: run.sourceRevision,
  sourceGeneration: run.sourceGeneration ?? 0, specRevision: run.specRevision, answersRevision: contentRevision(run.clarificationHistory ?? []) });
const sameBinding = (a, b) => !!a && !!b && contentRevision(a) === contentRevision(b);
function assertCurrent(run, round) {
  need(round && sameBinding(round.binding, binding(run)) && contentRevision(run.spec) === run.specRevision
    && contentRevision(run.sourceSnapshot) === run.sourceRevision, '规格或需求版本已变化，旧评审只保留历史，请为当前规格新建评审。');
}
export function meetingCoverage(run) {
  return run.spec.requirements.map(requirement => ({ requirementId: requirement.id, clause: `${requirement.id} ${requirement.title}`,
    owner: `business:${requirement.id}`, reviewer: 'independent',
    specialists: [`business:${requirement.id}`, 'interaction', 'data', 'access', 'interface', 'reliability'],
    observable: [...requirement.acceptance], verificationNodes: DELIVERY_STAGES.map(stage => stage.id) }));
}
function checkCoverage(run, coverage) {
  return run.spec.requirements.length > 0 && coverage.length === run.spec.requirements.length
    && run.spec.requirements.every(requirement => coverage.some(row => row.requirementId === requirement.id && row.owner !== row.reviewer
      && row.owner && row.reviewer === 'independent' && row.observable?.length && row.observable.every(text => typeof text === 'string' && text.trim())
      && specialists(run).filter(seat => !seat.startsWith('business:') || seat === `business:${requirement.id}`).every(seat => row.specialists.includes(seat))
      && DELIVERY_STAGES.every(stage => row.verificationNodes.includes(stage.id))));
}
export function startSpecificationMeeting(run, { revision, scenario = 'reservation' } = {}) {
  need(run.workflowVersion === 2 && run.status === 'awaiting_spec' && run.spec?.requirements?.length, '请在完整规格的人工确认停点启用评审。');
  need(revision === run.specRevision, '规格版本已变化，请刷新后启用评审。');
  need(['reservation', 'reject_review', 'late_review'].includes(scenario), '未知离线评审场景。', 400);
  const previous = currentMeeting(run);
  if (previous && sameBinding(previous.binding, binding(run))) throw new HttpError(409, '本版已有评审，请继续当前节点；Review退回须实际修订规格，不能原样重开。');
  run.specReview ??= { required: true, currentRoundId: null, rounds: [] };
  need(run.specReview.rounds.length < 20, '最多保留20轮评审，请新建规划运行。');
  if (previous) previous.status = 'superseded';
  const round = { id: randomUUID(), number: run.specReview.rounds.length + 1, binding: binding(run), kind: 'offline_fixture', scenario,
    notice: '离线角色模型夹具，仅验证规格评审流程；不代表真实模型审阅、测试执行或软件验收。',
    createdAt: now(), status: 'in_progress', seats: { ...MEETING_ROLES, ...Object.fromEntries(run.spec.requirements.map(r => [`business:${r.id}`, `业务域 ${r.title}`])) },
    coverage: meetingCoverage(run), proposals: [], issues: [], decisions: structuredClone(run.spec.meetingDecisions ?? []),
    nodes: MEETING_NODES.map(node => ({ ...node, status: 'pending', artifact: null, selfTest: null, reviews: [], attempts: [], blocking: [] })),
    bundleRevision: null, confirmation: null };
  const obligations = new Map();
  for (const prior of run.specReview.rounds) for (const node of prior.nodes) for (const finding of node.blocking) {
    const id = contentRevision([node.id, finding.role, finding.location, finding.condition]);
    obligations.set(id, { ...finding, id, nodeId: node.id, fromSpecRevision: prior.binding.specRevision });
  }
  round.obligations = [...obligations.values()];
  run.specReview.required = true; run.specReview.currentRoundId = round.id; run.specReview.rounds.push(round);
  run.approvals.spec = null; return round;
}

const RELEASE = ['取消后立即释放原时段，其他人可重新预约', '取消后仍保留原时段，本版不支持重新预约'];
const CANCEL_ACCESS = ['仅预约本人及管理员可取消，其他人拒绝且不改记录', '仅管理员可取消，其他人拒绝且不改记录'];
/** Isolated role calls for the first-release fixture. No network or credential access. */
export class OfflineSpecificationRoles {
  async propose({ seat, spec, source, confirmedAnswers = [] }) {
    const applicable = spec.requirements.filter(r => !seat.startsWith('business:') || seat === `business:${r.id}`);
    const rules = applicable.map(r => ({ requirementId: r.id, rule: r.description, exception: '按规格拒绝非法状态、越权和无效输入；不补造业务默认值。',
      observable: [...r.acceptance], sourceQuote: r.sourceQuote }));
    const issues = [], sourceResolutions = [];
    for (const r of applicable) {
      const clause = `${r.description}\n${r.sourceQuote}`, decided = spec.meetingDecisions ?? [];
      if (!/预约/.test(clause) || !/取消/.test(clause)) continue;
      const question = seat === 'data' ? '取消后原时段是否立即释放并允许他人重新预约？'
        : seat === 'access' ? '哪些角色可以取消预约，被拒绝时原记录应如何处理？' : null;
      if (!question || decided.some(d => d.question === question && d.requirementIds.includes(r.id))) continue;
      const authoritative = [source?.content ?? '', ...confirmedAnswers.map(item => item.answer)].join('\n');
      const supported = authoritative.match(seat === 'data' ? /取消后(?:原)?时段(?:立即)?重新可预约/ : /仅(?:预约本人及管理员|管理员)可取消/);
      if (supported) {
        sourceResolutions.push({ requirementIds: [r.id], question, answer: supported[0], roles: [seat],
          sourceQuote: supported[0], basis: '原文或已确认答复' });
        continue;
      }
      issues.push({ topic: `cancel-policy:${r.id}`, requirementIds: [r.id], question, options: seat === 'data' ? RELEASE : CANCEL_ACCESS,
        impact: seat === 'data' ? '影响时段占用、并发重新预约及集成断言。' : '影响取消权限、拒绝反馈及数据是否变化。', blocking: true });
    }
    return { seat, rules, issues, sourceResolutions, reservations: ['离线夹具只能验证结构、引用和状态门禁，真实业务充分性仍需人工核对。'] };
  }
  async review(request) {
    const { role, nodeId, artifact, scenario, attempt } = request;
    const resolutions = (request.obligations ?? []).map(obligation => ({ id: obligation.id,
      resolved: obligation.condition.includes('失败时保持原记录') && artifact.spec?.requirements.some(r => r.id === obligation.requirementId && r.acceptance.some(text => text.includes('失败时保持原记录'))),
      evidence: '按当前版本条款重新核对原阻塞的复核条件；未知条件不自动关闭。' }));
    const rejected = scenario === 'reject_review' && nodeId === 'specification' && role === 'independent'
      && !artifact.spec.requirements[0].acceptance.some(text => text.includes('失败时保持原记录'));
    return { binding: request.binding, nodeId, artifactRevision: request.artifactRevision, role, kind: 'offline_fixture',
      passed: !rejected && resolutions.every(item => item.resolved), resolutions, findings: rejected ? [{ requirementId: artifact.spec.requirements[0].id, location: `${artifact.spec.requirements[0].id}.acceptance`,
        impact: '失败后数据行为未明确', condition: '在首条需求验收中明确“失败时保持原记录”，保存真实修订后重审。', blocking: true }] : (request.obligations ?? []).filter(o => !resolutions.find(r => r.id === o.id)?.resolved),
      evidence: '离线角色按当前输入核对条款、来源和节点条件。',
      ...(scenario === 'late_review' && nodeId === 'specification' && role === 'independent' && attempt === 1
        ? { binding: { ...request.binding, specRevision: '0'.repeat(64) } } : {}) };
  }
}

function stageChecklist(run, round) {
  return DELIVERY_STAGES.map(stage => ({ ...stage, inputVersion: binding(run),
    inputs: ['当前设计规格', ...(stage.id === 'architecture' ? [] : ['已放行的前置阶段产物'])],
    deliverables: [stage.evidence], requiredReviewers: ['independent', ...(stage.id === 'development' ? ['tester'] : [])],
    selfTest: stage.condition, requiredEvidence: stage.evidence, independentReview: '审查同一固定版本的产物、自测证据和阻塞关闭记录。',
    blockingPolicy: '必审角色缺席、自测/Review不通过、旧版本证据或阻塞未关闭时等待，不允许强制完成。',
    dependsOn: stage.id === 'architecture' ? ['spec_confirmation'] : stage.id === 'tasks' ? ['architecture']
      : stage.id === 'acceptance' ? ['tasks'] : stage.id === 'development' ? ['acceptance'] : stage.id === 'integration' ? ['development'] : ['integration'],
    rules: round.coverage.map(row => ({ requirementId: row.requirementId, specClause: row.clause, observable: row.observable,
      verificationNode: stage.id, evidence: stage.evidence, executed: false })), definitionOnly: true }));
}
function reviewers(node, run) {
  if (node.id === 'specification') return [...specialists(run), 'acceptance', 'independent'];
  if (node.id === 'checklist') return [...DELIVERY_STAGES.map(stage => stage.owner), 'independent'];
  return ['independent', ...(node.id === 'confirmation' ? ['product', 'acceptance'] : [])];
}
function digestBundle(run, round) {
  return contentRevision({ binding: round.binding, spec: run.spec, coverage: round.coverage,
    nodes: round.nodes.map(node => ({ id: node.id, artifact: node.artifact, selfTest: node.selfTest, reviews: node.reviews })),
    proposals: round.proposals, issues: round.issues, decisions: round.decisions, obligations: round.obligations, checklist: round.checklist });
}
async function bounded(work, timeoutMs, signal) {
  let timer, abort;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('评审角色超时，节点继续等待。')), timeoutMs);
    abort = () => reject(new Error('评审已中断，节点继续等待。'));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  })]); } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function advanceSpecificationMeeting(run, input, { executor = new OfflineSpecificationRoles(), timeoutMs = 3000, signal, assertAccess = () => {} } = {}) {
  const round = currentMeeting(run); assertCurrent(run, round);
  need(input.roundId === round.id && input.revision === run.specRevision, '评审轮次或版本已变化，请刷新。');
  need(!round.confirmation, '已确认的评审只保留记录。');
  const node = round.nodes.find(node => node.status !== 'passed');
  need(node && !['rejected', 'awaiting_user'].includes(node.status), '当前节点有阻塞，须用户裁决或实际修订后重审。');
  const captured = binding(run), nodeIndex = round.nodes.indexOf(node), attempt = node.attempts.length + 1;
  const check = () => { assertAccess(); assertCurrent(run, round); need(!signal?.aborted && sameBinding(captured, binding(run)), '旧评审结果已失效，不放行下游。'); };
  check(); need(node.attempts.length < 20, '本节点最多20次离线尝试。');
  node.reviews = []; node.blocking = [];
  const record = { at: now(), attempt, binding: captured, status: 'authoring', ignored: [], reviewReceipts: [] }; node.attempts.push(record);
  let artifact;
  try {
    if (node.id === 'baseline') artifact = { source: structuredClone(run.sourceSnapshot), confirmedAnswers: structuredClone(run.clarificationHistory ?? []),
      requirements: structuredClone(run.spec.requirements), sourceRevision: run.sourceRevision, coverage: round.coverage };
    if (node.id === 'proposals') {
      const proposals = await Promise.all(specialists(run).map(async seat => {
        const result = await bounded(Promise.resolve().then(() => executor.propose({ seat, spec: structuredClone(run.spec),
          source: structuredClone(run.sourceSnapshot), confirmedAnswers: structuredClone((run.clarificationHistory ?? []).flatMap(round => round.answers)), binding: captured, signal })), timeoutMs, signal);
        check(); need(result?.seat === seat && Array.isArray(result.rules) && result.rules.length, `专业席 ${seat} 缺席或未提交规则。`);
        const expected = run.spec.requirements.filter(r => !seat.startsWith('business:') || seat === `business:${r.id}`);
        need(expected.every(r => result.rules.some(rule => rule.requirementId === r.id && rule.sourceQuote === r.sourceQuote
          && typeof rule.rule === 'string' && rule.rule.trim() && Array.isArray(rule.observable) && rule.observable.length)), `专业席 ${seat} 条款缺少来源或可观察结果。`);
        return { ...result, selfTest: { passed: true, method: '条款来源、覆盖和场景走查', binding: captured, owner: seat, kind: 'offline_fixture' } };
      }));
      round.proposals = structuredClone(proposals);
      const authoritative = [run.sourceSnapshot.content, ...(run.clarificationHistory ?? []).flatMap(round => round.answers.map(answer => answer.answer))];
      round.sourceResolutions = proposals.flatMap(proposal => (proposal.sourceResolutions ?? []).map(resolution => {
        need(typeof resolution.sourceQuote === 'string' && resolution.sourceQuote.trim() && authoritative.some(text => text.includes(resolution.sourceQuote))
          && resolution.answer === resolution.sourceQuote && resolution.requirementIds?.length
          && resolution.requirementIds.every(id => run.spec.requirements.some(r => r.id === id))
          && resolution.roles?.length === 1 && resolution.roles[0] === proposal.seat, '来源裁决必须逐字引用原文或已确认答复并绑定受影响条款。');
        return { ...resolution, fromSpecRevision: run.specRevision, at: now() };
      }));
      const grouped = new Map();
      for (const proposal of proposals) for (const issue of proposal.issues ?? []) {
        need(typeof issue.question === 'string' && issue.question.trim() && issue.requirementIds?.length
          && issue.requirementIds.every(id => run.spec.requirements.some(r => r.id === id)) && issue.options?.length >= 2
          && issue.options.every(option => typeof option === 'string' && option.trim()), '专业异议缺少条款、选项或依据。');
        const key = contentRevision([issue.topic, issue.question, issue.requirementIds]);
        if (grouped.has(key)) grouped.get(key).roles.push(proposal.seat);
        else grouped.set(key, { ...issue, id: `MR-${key.slice(0, 12)}`, roles: [proposal.seat], status: 'open' });
      }
      round.issues = [...grouped.values()]; artifact = { proposals, issues: round.issues };
    }
    if (node.id === 'decisions') {
      const open = round.issues.filter(issue => issue.blocking && issue.status !== 'closed');
      artifact = { topics: [...new Set(round.issues.map(issue => issue.topic))], issues: round.issues, decisions: round.decisions, sourceResolutions: round.sourceResolutions ?? [] };
      if (open.length) { node.artifact = artifact; node.status = 'awaiting_user'; round.status = 'awaiting_decision'; record.status = 'awaiting_user'; return; }
    }
    if (node.id === 'specification') artifact = { spec: structuredClone(run.spec), coverage: round.coverage, decisions: round.decisions };
    if (node.id === 'checklist') { round.checklist = stageChecklist(run, round); artifact = { checklist: round.checklist }; }
    if (node.id === 'confirmation') artifact = { specRevision: run.specRevision, priorNodeVersions: round.nodes.slice(0, 5).map(n => ({ id: n.id, revision: n.selfTest?.artifactRevision })),
      decisions: round.decisions, checklistRevision: contentRevision(round.checklist) };
    check(); node.artifact = structuredClone(artifact);
    need(Buffer.byteLength(JSON.stringify(artifact)) <= 2 * 1024 * 1024, '评审产物超出2MB限制。');
    const artifactRevision = contentRevision(artifact);
    const selfPassed = checkCoverage(run, round.coverage) && round.nodes.slice(0, nodeIndex).every(n => n.status === 'passed')
      && run.spec.requirements.every(r => r.sourceQuote && r.acceptance?.length)
      && (node.id !== 'checklist' || round.checklist.every(row => row.rules.length === run.spec.requirements.length && row.requiredReviewers.length && row.requiredEvidence));
    node.selfTest = { owner: node.owner, binding: captured, artifactRevision, passed: selfPassed, kind: 'offline_fixture',
      evidence: ['原文与已确认答复引用核对', '需求主责/独立审阅/专业维度覆盖检查', '关键场景、可观察条件与下游承接走查'] };
    record.selfTest = structuredClone(node.selfTest);
    if (!selfPassed) { node.status = 'rejected'; round.status = 'blocked'; record.status = 'self_test_failed'; return; }
    node.status = 'awaiting_review';
    for (const role of reviewers(node, run)) {
      const result = await bounded(Promise.resolve().then(() => executor.review({ role, nodeId: node.id, artifact: structuredClone(artifact),
        selfTest: structuredClone(node.selfTest), binding: captured, artifactRevision, scenario: round.scenario, attempt, signal,
        obligations: structuredClone(round.obligations.filter(o => o.nodeId === node.id && o.role === role)) })), timeoutMs, signal);
      check();
      record.reviewReceipts.push(structuredClone(result ?? null));
      if (!result || result.role !== role || result.nodeId !== node.id || !sameBinding(result.binding, captured) || result.artifactRevision !== artifactRevision) {
        record.ignored.push({ role, reason: '缺席或旧版本/不匹配的Review不计入放行。' }); record.status = 'awaiting_review'; round.status = 'waiting'; return;
      }
      need(role !== node.owner && typeof result.passed === 'boolean' && Array.isArray(result.findings)
        && typeof result.evidence === 'string' && result.evidence.trim(), 'Review不能由主责自批，且须提供明确结论与证据。');
      for (const finding of result.findings) need(typeof finding.location === 'string' && !!finding.location.trim()
        && typeof finding.impact === 'string' && !!finding.impact.trim() && typeof finding.condition === 'string' && !!finding.condition.trim()
        && typeof finding.blocking === 'boolean', 'Review意见须有位置、影响、复核条件及阻塞标记。');
      node.reviews.push(structuredClone(result));
      node.blocking.push(...result.findings.filter(finding => finding.blocking).map(finding => ({ ...finding, role })));
      for (const obligation of round.obligations.filter(o => o.nodeId === node.id && o.role === role)) {
        if (!result.resolutions?.some(resolution => resolution.id === obligation.id && resolution.resolved === true
          && typeof resolution.evidence === 'string' && resolution.evidence.trim())) node.blocking.push(obligation);
      }
      if (!result.passed || node.blocking.length) { node.status = 'rejected'; round.status = 'blocked'; record.status = 'review_rejected'; return; }
    }
    check(); node.status = 'passed'; record.status = 'passed'; record.finishedAt = now(); round.status = 'in_progress';
    if (node.id === 'decisions' && round.sourceResolutions?.length) round.status = 'needs_source_revision';
    if (round.nodes.every(node => node.status === 'passed')) { round.bundleRevision = digestBundle(run, round); round.status = 'awaiting_confirmation'; }
  } catch (error) {
    // A missing role or timeout is durable waiting, not a fabricated pass.
    check(); node.status = 'awaiting_review'; record.status = 'waiting'; record.reason = error.message; round.status = 'waiting';
  }
}

export function assertSpecificationMeeting(run, expectedBundle) {
  if (!run.specReview?.required) return;
  const round = currentMeeting(run); assertCurrent(run, round);
  need(round.status === 'awaiting_confirmation' && round.nodes.length === MEETING_NODES.length && checkCoverage(run, round.coverage)
    && !round.issues.some(issue => issue.blocking && issue.status !== 'closed') && round.bundleRevision === digestBundle(run, round), '规格评审尚未通过或联合产物已变化，工程规划继续等待。');
  for (const node of round.nodes) {
    const hash = contentRevision(node.artifact);
    need(node.status === 'passed' && node.selfTest?.passed === true && sameBinding(node.selfTest.binding, binding(run)) && node.selfTest.artifactRevision === hash
      && reviewers(node, run).every(role => node.reviews.some(review => review.role === role && role !== node.owner && review.passed === true
        && review.nodeId === node.id && sameBinding(review.binding, binding(run)) && review.artifactRevision === hash && !review.findings.some(finding => finding.blocking)
        && round.obligations.filter(o => o.nodeId === node.id && o.role === role).every(o => review.resolutions?.some(r => r.id === o.id && r.resolved === true && r.evidence)))),
    `${node.title}的自测、必审席位或同版本Review尚未通过。`);
  }
  if (expectedBundle !== undefined) need(expectedBundle === round.bundleRevision, '确认包版本已变化，请核对规格、纪要和清单后重新确认。');
}
export function specificationMeetingIssue(run) {
  const round = currentMeeting(run);
  if (!round || run.status !== 'awaiting_spec' || !sameBinding(round.binding, binding(run)) || round.status !== 'awaiting_decision') return null;
  const qa = round.issues.filter(issue => issue.blocking && issue.status !== 'closed').map(issue => ({ id: issue.id,
    question: `${issue.requirementIds.join('、')} / ${issue.roles.map(role => round.seats[role] ?? role).join('、')}：${issue.question}\n请选择并原样填写一个选项：\n${issue.options.join('\n')}\n影响：${issue.impact}` }));
  const id = contentRevision([round.id, round.binding, qa]);
  return { id, kind: 'specification_meeting', stageId: 'spec', title: '多 Agent 规格评审业务裁决',
    message: '权限与数据等专业席的关联异议已归并，原文不能唯一裁定时须用户选择；答复后生成新规格版本并重新复核。',
    qa, questions: qa.map(row => row.question), answers: run.planningIssueDraft?.id === id ? run.planningIssueDraft.answers ?? {} : {},
    allowQuestions: true, autoExplain: false, canExplain: false, pending: false, canSave: true, canContinue: true };
}
export function prepareMeetingAnswers(run, issue, input) {
  const round = currentMeeting(run); assertCurrent(run, round);
  need(issue.id === input.issueId && typeof input.continue === 'boolean' && input.answers && typeof input.answers === 'object', '议题版本或回答格式不正确。');
  need(Object.keys(input.answers).every(id => issue.qa.some(q => q.id === id)), '包含旧版或未知议题。');
  const decisions = round.issues.filter(item => item.blocking && item.status !== 'closed').flatMap(item => {
    const answer = input.answers[item.id]; if (!answer) return [];
    need(typeof answer === 'string' && item.options.includes(answer.trim()), '请原样选择列出的业务选项；新增范围须先走需求变更。', 400);
    return [{ issueId: item.id, topic: item.topic, requirementIds: item.requirementIds, question: item.question, answer: answer.trim(),
      roles: item.roles, fromSpecRevision: run.specRevision, basis: '用户明确裁决', at: now() }];
  });
  need(decisions.length > 0 && (!input.continue || decisions.length === issue.qa.length), '请回答全部阻塞议题再继续。', 400);
  return decisions;
}
export function meetingArtifacts(run) {
  const round = currentMeeting(run); if (!round) return [];
  return [{ name: 'spec-review-minutes.json', title: '规格评审会议纪要', content: JSON.stringify({ kind: 'offline_fixture',
    rounds: run.specReview.rounds, currentRoundId: round.id }, null, 2) },
  { name: 'stage-review-checklist.json', title: '阶段验收与Review清单', content: JSON.stringify({ definitionOnly: true,
    binding: round.binding, bundleRevision: round.bundleRevision, confirmation: round.confirmation, checklist: round.checklist ?? [] }, null, 2) }];
}
