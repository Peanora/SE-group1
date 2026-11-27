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
const PROPOSAL_REVIEWERS = { interaction: 'access', data: 'interface', access: 'interaction', interface: 'reliability', reliability: 'data' };
const REVIEW_PROTOCOL = 3;
const hasProposalReview = round => [2, REVIEW_PROTOCOL].includes(round.reviewProtocol);
const hasIssueRouting = round => round.reviewProtocol === REVIEW_PROTOCOL;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const checkedText = value => typeof value === 'string' && value.trim().length > 0;
const checkedTexts = value => Array.isArray(value) && value.length > 0 && value.every(checkedText);
const proposalReviewers = seat => [PROPOSAL_REVIEWERS[seat] ?? 'acceptance', 'independent'];
const selfTestKind = round => round.kind === 'model_review' ? 'platform_structural' : 'offline_fixture';
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
const hasFormatDefinition = requirement => !Object.hasOwn(requirement, 'formatAcceptance')
  || checkedTexts(requirement.formatAcceptance) && requirement.formatAcceptance.length <= 20
  && requirement.formatAcceptance.every(value => value.length <= 1200);
export function startSpecificationMeeting(run, { revision, scenario = 'reservation' } = {}) {
  need(run.workflowVersion === 2 && run.status === 'awaiting_spec' && run.spec?.requirements?.length, '请在完整规格的人工确认停点启用评审。');
  need(revision === run.specRevision, '规格版本已变化，请刷新后启用评审。');
  need(['reservation', 'reject_review', 'late_review', 'model_review'].includes(scenario), '未知评审模式。', 400);
  const previous = currentMeeting(run);
  if (previous && sameBinding(previous.binding, binding(run))) throw new HttpError(409, '本版已有评审，请继续当前节点；Review退回须实际修订规格，不能原样重开。');
  need(scenario === 'model_review' || !run.specReview?.rounds?.some(round => round.kind === 'model_review'),
    '当前规划已进入模型评审，修订及裁决后须继续模型评审。');
  run.specReview ??= { required: true, currentRoundId: null, rounds: [] };
  need(run.specReview.rounds.length < 20, '最多保留20轮评审，请新建规划运行。');
  if (previous) previous.status = 'superseded';
  const kind = scenario === 'model_review' ? 'model_review' : 'offline_fixture';
  const carriedIssues = carryBlockingIssues(run);
  const round = { id: randomUUID(), number: run.specReview.rounds.length + 1, binding: binding(run), kind, scenario, reviewProtocol: REVIEW_PROTOCOL,
    notice: kind === 'model_review' ? '模型席位对版本化规格材料提出意见。用户须确认业务裁决和本版联合包。'
      : '离线角色模型夹具，仅验证规格评审流程；不代表真实模型审阅、测试执行或软件验收。',
    createdAt: now(), status: 'in_progress', seats: { ...MEETING_ROLES, ...Object.fromEntries(run.spec.requirements.map(r => [`business:${r.id}`, `业务域 ${r.title}`])) },
    coverage: meetingCoverage(run), proposals: [], issues: [], carriedIssues, decisions: structuredClone(run.spec.meetingDecisions ?? []),
    nodes: MEETING_NODES.map(node => ({ ...node, status: 'pending', artifact: null, selfTest: null, reviews: [], attempts: [], blocking: [] })),
    bundleRevision: null, confirmation: null };
  const obligations = new Map();
  for (const prior of run.specReview.rounds) for (const node of prior.nodes) for (const finding of node.blocking) {
    const scope = finding.proposalSeat ? [finding.proposalSeat] : [];
    const id = contentRevision([node.id, ...scope, finding.role, finding.location, finding.condition]);
    obligations.set(id, { ...finding, id, nodeId: node.id, fromSpecRevision: prior.binding.specRevision });
  }
  round.obligations = [...obligations.values()];
  refreshDiscussion(run, round, 'collecting');
  run.specReview.required = true; run.specReview.currentRoundId = round.id; run.specReview.rounds.push(round);
  run.approvals.spec = null; return round;
}

const RELEASE = ['取消后立即释放原时段，其他人可重新预约', '取消后仍保留原时段，本版不支持重新预约'];
const CANCEL_ACCESS = ['仅预约本人及管理员可取消，其他人拒绝且不改记录', '仅管理员可取消，其他人拒绝且不改记录'];
/** Isolated role calls for the first-release fixture. No network or credential access. */
export class OfflineSpecificationRoles {
  async propose({ seat, spec, source, confirmedAnswers = [] }) {
    const applicable = spec.requirements.filter(r => !seat.startsWith('business:') || seat === `business:${r.id}`);
    const dimension = {
      interaction: '核对角色所见、操作反馈和异常恢复', data: '核对字段、状态变化与持久记录',
      access: '核对发起角色、可见范围和拒绝行为', interface: '核对输入、可观察输出和失败反馈',
      reliability: '核对恢复后结果、原状态和操作证据',
    }[seat] ?? '核对业务角色、状态与验收场景';
    const rules = applicable.map(r => ({ requirementId: r.id, rule: r.description, exception: dimension,
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
    const { role, nodeId, artifact, scenario, attempt, proposalSeat } = request;
    const resolutions = (request.obligations ?? []).map(obligation => ({ id: obligation.id,
      resolved: obligation.condition.includes('失败时保持原记录') && artifact.spec?.requirements.some(r => r.id === obligation.requirementId && r.acceptance.some(text => text.includes('失败时保持原记录'))),
      evidence: '按当前版本条款重新核对原阻塞的复核条件；未知条件不自动关闭。' }));
    const rejected = scenario === 'reject_review' && nodeId === 'specification' && role === 'independent'
      && !artifact.spec.requirements[0].acceptance.some(text => text.includes('失败时保持原记录'));
    return { binding: request.binding, nodeId, artifactRevision: request.artifactRevision, role, kind: 'offline_fixture',
      ...(proposalSeat ? { proposalSeat } : {}),
      passed: !rejected && resolutions.every(item => item.resolved), resolutions, findings: rejected ? [{ requirementId: artifact.spec.requirements[0].id, location: `${artifact.spec.requirements[0].id}.acceptance`,
        impact: '失败后数据行为未明确', condition: '在首条需求验收中明确“失败时保持原记录”，保存真实修订后重审。', blocking: true }] : (request.obligations ?? []).filter(o => !resolutions.find(r => r.id === o.id)?.resolved),
      evidence: proposalSeat ? `离线夹具 ${role} 核对 ${proposalSeat} 的 ${artifact.proposal.rules.length} 条规则、来源与可观察结果。`
        : '离线夹具确认当前产物哈希、自测结果及必需证据字段，业务充分性须人工核对。',
      ...(scenario === 'late_review' && nodeId === 'specification' && role === 'independent' && attempt === 1
        ? { binding: { ...request.binding, specRevision: '0'.repeat(64) } } : {}) };
  }
}

const STAGE_REVIEW_DEFINITIONS = [
  { inputs: ['已联合确认的设计规格和 Review 清单'], deliverables: ['架构及规格条款到承载模块的映射'],
    reviewers: ['product', 'independent'], focus: '核对承载模块、接口责任与失败处理。' },
  { inputs: ['已审阅的架构及模块映射'], deliverables: ['带依赖、交接产物与验收条件的任务计划'],
    reviewers: ['architect', 'independent'], focus: '核对任务边界、承接条款、版本、依赖与写入冲突。' },
  { inputs: ['已审阅的任务计划', '逐需求 Review 定义'], deliverables: ['逐要求可执行断言和必要测试数据'],
    reviewers: ['product', 'independent'], focus: '核对正常、失败、权限和边界输入是否对应可观察结果。' },
  { inputs: ['已批准的验收定义', '已放行的直接前置产物'], deliverables: ['每项改动的固定候选、自测和独立验证记录'],
    reviewers: ['tester', 'independent'], focus: '按逐需求 Review 定义检查行为和格式，核对结果与候选提交一致。' },
  { inputs: ['已放行的各边界产物', '跨模块端到端用例'], deliverables: ['固定集成版本和跨模块回归结果'],
    reviewers: ['tester', 'independent'], focus: '在同一集成提交复验跨模块操作、状态和数据一致性。' },
  { inputs: ['已验收同一集成版本的测试与 Review 证据'], deliverables: ['可运行交付包和版本证据索引'],
    reviewers: ['tester', 'independent'], focus: '对照规格、提交、证据及交付包，核对能在干净目录启动和验证。' },
];
const REVIEW_REWORK = '记录缺陷所在条款、影响和复核条件；主责修订并冻结新版本，同一版本重跑受影响自测、独立验证及 Review。';

function featureReviewDefinitions(run, round) {
  return run.spec.requirements.map((requirement, index) => {
    const covered = round.coverage[index];
    const checks = covered.observable.map((expected, position) => ({ id: `${requirement.id}-B${position + 1}`, kind: 'behavior', expected,
      evidence: '在同一候选上记录输入、角色、实际结果及与验收条件的差异。' }));
    const proposal = round.proposals.find(item => item.seat === `business:${requirement.id}` && item.status === 'passed');
    const proposedFormats = proposal?.rules.find(rule => rule.requirementId === requirement.id)?.formatAcceptance;
    const explicitFormats = requirement.formatAcceptance ?? proposedFormats;
    const formats = explicitFormats ?? ['本条尚无独立格式断言；在验收设计中确认字段、状态值或界面反馈的适用格式。'];
    checks.push(...formats.map((expected, position) => ({ id: `${requirement.id}-F${position + 1}`, kind: 'format', expected,
      definitionStatus: explicitFormats ? 'defined' : 'pending',
      ...(requirement.formatAcceptance ? { definitionSource: 'specification' }
        : proposedFormats ? { definitionSource: 'reviewed_business_proposal', proposalRevision: proposal.artifactRevision } : {}),
      evidence: '保留界面截图、响应样例或状态记录，以及对应规格条款。' })));
    return { id: `review:${requirement.id}`, requirementId: requirement.id, title: requirement.title, specClause: covered.clause,
      inputVersion: round.binding, sourceQuote: requirement.sourceQuote, owner: covered.owner,
      requiredReviewers: ['tester', 'independent'], checks,
      selfTest: '按本条规格逐项核对行为、格式和失败反馈，并保留可重复的候选证据。',
      independentReview: '独立测试与审查复查同一候选的逐项证据，需求行为或约定格式不符即退回。',
      rework: REVIEW_REWORK, upstream: ['acceptance'], downstream: ['integration'], definitionOnly: true, executed: false };
  });
}

function stageChecklist(round) {
  return DELIVERY_STAGES.map((stage, index) => {
    const definition = STAGE_REVIEW_DEFINITIONS[index];
    return { ...stage, inputVersion: round.binding, inputs: ['当前设计规格', ...definition.inputs],
      deliverables: definition.deliverables, requiredReviewers: definition.reviewers,
      selfTest: stage.condition, requiredEvidence: stage.evidence, independentReview: definition.focus,
      blockingPolicy: '必审缺席、自测或 Review 未通过，以及证据过期或阻塞未关闭时继续等待。',
      rework: REVIEW_REWORK, dependsOn: [DELIVERY_STAGES[index - 1]?.id ?? 'spec_confirmation'],
      downstream: DELIVERY_STAGES[index + 1] ? [DELIVERY_STAGES[index + 1].id] : [],
      rules: round.coverage.map(row => ({ requirementId: row.requirementId, specClause: row.clause, observable: row.observable,
        verificationNode: stage.id, ...(hasProposalReview(round) ? { featureReviewId: `review:${row.requirementId}` } : {}),
        reviewFocus: definition.focus, evidence: stage.evidence, executed: false })),
      definitionOnly: true };
  });
}
function reviewers(node, run) {
  if (node.id === 'specification') return [...specialists(run), 'acceptance', 'independent'];
  if (node.id === 'checklist') return [...DELIVERY_STAGES.map(stage => stage.owner), 'independent'];
  return ['independent', ...(node.id === 'confirmation' ? ['product', 'acceptance'] : [])];
}
export function meetingModelAdvanceLimit(run) {
  const round = currentMeeting(run);
  if (!round || round.kind !== 'model_review' || !sameBinding(round.binding, binding(run)) || round.confirmation) return 0;
  const node = round.nodes.find(item => item.status !== 'passed');
  if (!node || ['rejected', 'awaiting_user'].includes(node.status)) return 0;
  const nodeReviews = reviewers(node, run).length;
  if (node.id !== 'proposals') return nodeReviews;
  const prepared = new Map(round.proposals.map(proposal => [proposal.seat, proposal]));
  return specialists(run).reduce((count, seat) => {
    const proposal = prepared.get(seat);
    const required = proposalReviewers(seat);
    if (!proposal) return count + 1 + required.length;
    return count + required.filter(role => !proposal.reviews.some(review => review.role === role)).length;
  }, nodeReviews);
}
function digestBundle(run, round) {
  return contentRevision({ binding: round.binding, spec: run.spec, coverage: round.coverage,
    nodes: round.nodes.map(node => ({ id: node.id, artifact: node.artifact, selfTest: node.selfTest, reviews: node.reviews })),
    proposals: round.proposals, issues: round.issues, decisions: round.decisions, obligations: round.obligations, checklist: round.checklist,
    ...(hasProposalReview(round) ? { reviewProtocol: round.reviewProtocol, featureReviews: round.featureReviews } : {}),
    ...(hasIssueRouting(round) ? { discussion: round.discussion, carriedIssues: round.carriedIssues } : {}) });
}
async function bounded(work, timeoutMs, signal) {
  let timer, abort;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('评审角色超时，节点继续等待。')), timeoutMs);
    abort = () => reject(new Error('评审已中断，节点继续等待。'));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  })]); } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function proposalContent(proposal) {
  const { seat, rules, issues, sourceResolutions, reservations } = proposal;
  return { seat, rules, issues, sourceResolutions, reservations };
}

const topicId = requirementId => `MT-${contentRevision(requirementId).slice(0, 12)}`;
const sourceTexts = run => [run.sourceSnapshot.content,
  ...(run.clarificationHistory ?? []).flatMap(item => item.answers.map(answer => answer.answer))];
const excerpt = (value, size) => Array.from(value).slice(0, size).join('');

function discussionTopics(run, proposals = []) {
  // Each topic is keyed by the existing clause identity across specification revisions.
  const topics = new Map(run.spec.requirements.map(requirement => [requirement.id, {
    id: topicId(requirement.id), requirementId: requirement.id, title: requirement.title,
    sourceQuote: requirement.sourceQuote, positions: [], challenges: [],
  }]));
  for (const proposal of proposals) for (const rule of proposal.rules) {
    const topic = topics.get(rule.requirementId);
    topic.positions.push({ seat: proposal.seat, proposalRevision: proposal.authorRevision ?? proposal.artifactRevision,
      rule: excerpt(rule.rule, 150),
      exception: excerpt(rule.exception ?? '', 80),
      observable: rule.observable.slice(0, 2).map(item => excerpt(item, 80)),
      questions: (proposal.issues ?? []).filter(issue => issue.requirementIds.includes(rule.requirementId))
        .map(({ topic: issue, question, options }) => ({ topic: issue, question, options })) });
    for (const review of proposal.reviews) {
      const findings = review.findings.filter(finding => {
        const ids = finding.requirementIds ?? (finding.requirementId ? [finding.requirementId] : []);
        return ids.length ? ids.includes(rule.requirementId) : proposal.rules.length === 1;
      });
      topic.challenges.push({ proposalSeat: proposal.seat, role: review.role, artifactRevision: review.artifactRevision,
        evidence: excerpt(review.evidence, 240), findings });
    }
  }
  return [...topics.values()];
}

function reviewProposalArtifact(proposal, topics, decisions) {
  const covered = new Set(proposal.rules.map(rule => rule.requirementId));
  return { proposal: proposalContent(proposal), discussion: {
    topics: topics.filter(topic => covered.has(topic.requirementId)).map(({ challenges, ...topic }) => topic),
    decisions: decisions.filter(decision => decision.requirementIds.some(id => covered.has(id))),
  } };
}

function findingIds(finding, proposal) {
  return finding.requirementIds ?? (finding.requirementId ? [finding.requirementId] :
    proposal?.rules.length === 1 ? [proposal.rules[0].requirementId] : []);
}

function validFindingScopes(findings, run, proposal = null) {
  const knownIds = new Set(run.spec.requirements.map(item => item.id));
  const localIds = proposal && new Set(proposal.rules.map(rule => rule.requirementId));
  return findings.every(finding => {
    const ids = findingIds(finding, proposal);
    return Array.isArray(ids) && new Set(ids).size === ids.length && ids.every(id => knownIds.has(id))
      && (!finding.requirementId || ids.includes(finding.requirementId))
      && (!localIds || !ids.length || ids.some(id => localIds.has(id)))
      && (!finding.topicId || ids.some(id => topicId(id) === finding.topicId));
  });
}

const humanIssueKey = (question, requirementIds) => contentRevision([question, [...requirementIds].sort()]);
const isBlockingIssue = issue => issue.blocking && issue.status === 'open';

function carryBlockingIssues(run) {
  const pending = new Map();
  for (const round of run.specReview.rounds.filter(hasIssueRouting)) for (const issue of round.issues) {
    const id = humanIssueKey(issue.question, issue.requirementIds);
    if (['closed', 'resolved_pending_recheck'].includes(issue.status)) pending.delete(id);
    else if (isBlockingIssue(issue)) {
      pending.set(id, { ...structuredClone(issue),
        carriedFrom: issue.carriedFrom ?? { roundId: round.id, specRevision: round.binding.specRevision } });
    }
  }
  // User decisions recorded by the orchestration action remain authoritative when
  // later reviewers omit the old question or use a different topic label.
  const decided = new Set((run.spec.meetingDecisions ?? []).filter(item => item.basis === '用户明确裁决')
    .map(item => humanIssueKey(item.question, item.requirementIds)));
  return [...pending.entries()].filter(([id]) => !decided.has(id)).map(([, issue]) => issue);
}

function canAnswerIssue(run, issue) {
  return isBlockingIssue(issue) && issue.requirementIds.every(id => run.spec.requirements.some(requirement => requirement.id === id));
}

function collectIssues(round, proposals, reviewFindings = []) {
  const grouped = new Map((round.carriedIssues ?? []).map(issue =>
    [humanIssueKey(issue.question, issue.requirementIds), structuredClone(issue)]));
  const decided = (question, requirementIds) => round.decisions.some(item =>
    humanIssueKey(item.question, item.requirementIds) === humanIssueKey(question, requirementIds));
  function add(issue, role) {
    const ids = hasProposalReview(round) ? [...issue.requirementIds].sort() : issue.requirementIds;
    const key = contentRevision(hasIssueRouting(round) ? [issue.question, ids] : [issue.topic, issue.question, ids]);
    const existing = grouped.get(key);
    if (!existing) grouped.set(key, { ...issue, id: `MR-${key.slice(0, 12)}`, roles: [role], status: 'open' });
    else if (hasProposalReview(round)) {
      existing.roles = [...new Set([...existing.roles, role])];
      existing.options = [...new Set([...existing.options, ...issue.options])];
      if (existing.impact !== issue.impact && !existing.impact.split('\n').includes(issue.impact)) existing.impact += `\n${issue.impact}`;
      existing.blocking ||= issue.blocking;
    } else existing.roles.push(role);
    return grouped.get(key);
  }
  for (const proposal of proposals) for (const issue of proposal.issues ?? []) {
    if (!hasIssueRouting(round) || !decided(issue.question, issue.requirementIds)) add(issue, proposal.seat);
  }
  for (const input of reviewFindings) {
    const { finding, role, requirementIds } = input;
    if (finding.kind !== 'human_decision' || !requirementIds.length || !checkedText(finding.question)
      || !checkedTexts(finding.options) || new Set(finding.options).size < 2 || !finding.blocking
      || decided(finding.question, requirementIds)) continue;
    const issue = add({ topic: finding.topic ?? `decision:${[...requirementIds].sort().join(',')}`, requirementIds,
      question: finding.question, options: finding.options, impact: finding.impact, blocking: true }, role);
    input.issueId = issue.id;
  }
  return [...grouped.values()];
}

function refreshDiscussion(run, round, phase) {
  const proposals = new Map(round.proposals.map(proposal => [proposal.seat, proposal]));
  const findings = [];
  function append(nodeId, reviews, blockers, proposal) {
    const proposalSeat = proposal?.seat;
    for (const review of reviews) for (const finding of review.findings) {
      findings.push({ finding, nodeId, role: review.role, proposalSeat, requirementIds: findingIds(finding, proposal) });
    }
    // A prior obligation can still be unresolved even when this pass adds no new finding.
    for (const finding of blockers) if (finding.id) {
      findings.push({ finding, nodeId, role: finding.role, proposalSeat, requirementIds: findingIds(finding, proposal) });
    }
  }
  for (const proposal of round.proposals) append('proposals', proposal.reviews, proposal.blocking, proposal);
  for (const node of round.nodes) append(node.id, node.reviews, node.blocking);
  const knownSource = sourceTexts(run);
  round.issues = collectIssues(round, round.proposals, findings);
  const byId = new Map(round.issues.map(issue => {
    const missingScope = issue.requirementIds.some(id => !run.spec.requirements.some(requirement => requirement.id === id));
    return [issue.id, {
      id: issue.id, ...(missingScope ? { condition: '恢复涉及的规格条款，或通过需求变更重新核对业务范围。' } : { issueId: issue.id }),
      kind: missingScope ? 'review_required' : 'human_decision', requirementIds: issue.requirementIds,
      blocking: issue.blocking, status: issue.status, role: issue.roles[0], roles: issue.roles, impact: issue.impact,
      question: issue.question, options: issue.options, ...(issue.carriedFrom ? { carriedFrom: issue.carriedFrom } : {}),
    }];
  }));
  for (const { finding, nodeId, role, proposalSeat, requirementIds, issueId } of findings) {
    if (issueId) continue;
    const source = checkedText(finding.sourceQuote) && knownSource.some(text => text.includes(finding.sourceQuote));
    const kind = finding.kind === 'source_rework' && requirementIds.length && source ? 'source_rework'
      : finding.kind === 'cross_requirement_conflict' && requirementIds.length > 1 ? 'cross_requirement_conflict'
      : 'review_required';
    const id = `MF-${contentRevision([kind, nodeId, role, proposalSeat, finding.location, finding.condition, [...requirementIds].sort()]).slice(0, 12)}`;
    byId.set(id, { id, kind, nodeId, role, ...(proposalSeat ? { proposalSeat } : {}), requirementIds, status: 'open',
      blocking: finding.blocking, location: finding.location, impact: finding.impact, condition: finding.condition,
      ...(source ? { sourceQuote: finding.sourceQuote } : {}) });
  }
  for (const resolution of round.sourceResolutions ?? round.proposals.flatMap(proposal => proposal.sourceResolutions ?? [])) {
    const id = `MF-${contentRevision(['source_basis', resolution.requirementIds, resolution.question, resolution.sourceQuote]).slice(0, 12)}`;
    if (!byId.has(id)) byId.set(id, { id, kind: 'source_rework', nodeId: 'proposals', role: resolution.roles[0],
      requirementIds: resolution.requirementIds, status: 'open', blocking: true,
      impact: resolution.question, condition: resolution.answer, sourceQuote: resolution.sourceQuote });
  }
  round.discussion = {
    phase, topics: discussionTopics(run, round.proposals),
    awaitingProposals: specialists(run).filter(seat => !proposals.has(seat)),
    awaitingReviews: round.proposals.flatMap(proposal => proposal.requiredReviewers
      .filter(role => !proposal.reviews.some(review => review.role === role)).map(role => ({ seat: proposal.seat, role }))),
    routes: [...byId.values()],
  };
  return round.issues.some(issue => canAnswerIssue(run, issue));
}

function specificationProposalEvidence(round) {
  return round.proposals.map(proposal => ({
    seat: proposal.seat,
    artifactRevision: proposal.artifactRevision,
    ...(proposal.authorRevision ? { authorRevision: proposal.authorRevision } : {}),
    reviewerRoles: proposal.reviews.map(review => review.role),
    rules: proposal.rules.map(({ requirementId, rule, exception, observable, formatAcceptance }) =>
      ({ requirementId, rule, exception, observable, ...(formatAcceptance ? { formatAcceptance } : {}) })),
  }));
}

function versionedProposal(result, seat, run, round) {
  need(result?.seat === seat && Array.isArray(result.rules) && result.rules.length, `专业席 ${seat} 缺席或未提交规则。`);
  const expected = run.spec.requirements.filter(r => !seat.startsWith('business:') || seat === `business:${r.id}`);
  need(result.rules.length === expected.length && expected.every(requirement => {
    const rule = result.rules.find(rule => rule?.requirementId === requirement.id);
    return rule?.sourceQuote === requirement.sourceQuote && checkedText(rule.rule) && checkedTexts(rule.observable) && hasFormatDefinition(rule)
      && (!hasIssueRouting(round) || (rule.exception === undefined || typeof rule.exception === 'string')
        && (rule.topicId === undefined || rule.topicId === topicId(requirement.id)));
  }), `专业席 ${seat} 的条款范围、来源或可观察结果未通过自测。`);
  need(['issues', 'sourceResolutions', 'reservations'].every(key => !Object.hasOwn(result, key) || Array.isArray(result[key])),
    `专业席 ${seat} 的附属提案字段格式无效。`);
  const ids = new Set(expected.map(requirement => requirement.id));
  const inScope = items => Array.isArray(items) && items.length && new Set(items).size === items.length && items.every(id => ids.has(id));
  need((result.issues ?? []).every(issue => issue && inScope(issue.requirementIds)
    && [issue.topic, issue.question, issue.impact].every(checkedText)
    && checkedTexts(issue.options) && new Set(issue.options).size === issue.options.length
    && issue.options.length >= 2 && typeof issue.blocking === 'boolean')
    && (result.reservations ?? []).every(checkedText), `专业席 ${seat} 的异议或保留意见未通过自测。`);
  const authoritative = sourceTexts(run);
  need((result.sourceResolutions ?? []).every(item => item && inScope(item.requirementIds) && checkedText(item.question)
    && checkedText(item.sourceQuote) && item.answer === item.sourceQuote && Array.isArray(item.roles) && item.roles.length === 1
    && item.roles[0] === seat && authoritative.some(text => text.includes(item.sourceQuote))),
  `专业席 ${seat} 不得把未经来源支持的建议当作业务裁决。`);
  const proposal = proposalContent(result);
  const artifactRevision = contentRevision({ proposal });
  need(Buffer.byteLength(JSON.stringify(proposal)) <= MAX_ARTIFACT_BYTES, `专业席 ${seat} 的提案超出2MB限制。`);
  return { ...proposal, ...(hasIssueRouting(round) ? { authorRevision: artifactRevision } : {}),
    status: 'awaiting_review', artifactRevision, requiredReviewers: proposalReviewers(seat), reviews: [], blocking: [],
    selfTest: { passed: true, method: '核对分席范围、逐条来源与可观察结果', binding: round.binding,
      artifactRevision, owner: seat, kind: selfTestKind(round), evidence: expected.map(requirement => `${requirement.id} 的来源和可观察结果已关联`) } };
}

function reviewHasEvidence(result, obligations = []) {
  return typeof result?.passed === 'boolean' && checkedText(result.evidence) && Array.isArray(result.findings)
    && result.findings.every(finding => finding && [finding.location, finding.impact, finding.condition].every(checkedText)
      && typeof finding.blocking === 'boolean')
    && (result.passed || result.findings.some(finding => finding.blocking)
      || Array.isArray(result.resolutions) && result.resolutions.some(item => item?.resolved === false && checkedText(item.evidence)
        && obligations.some(obligation => obligation.id === item.id)));
}

function reviewMatches(result, { role, nodeId, proposalSeat, artifactRevision, binding: signed }) {
  return result?.role === role && result.nodeId === nodeId && result.proposalSeat === proposalSeat
    && sameBinding(result.binding, signed) && result.artifactRevision === artifactRevision;
}

function scopedObligations(round, nodeId, role, proposalSeat) {
  return round.obligations.filter(item => item.nodeId === nodeId && item.role === role && item.proposalSeat === proposalSeat);
}

function unresolvedObligations(result, obligations) {
  return obligations.filter(obligation => !Array.isArray(result.resolutions)
    || !result.resolutions.some(resolution => resolution?.id === obligation.id && resolution.resolved === true && checkedText(resolution.evidence)));
}

async function requestReview({ executor, request, timeoutMs, signal, check, record, run, proposal }) {
  const result = await bounded(Promise.resolve().then(() => executor.review({ ...structuredClone(request), signal })), timeoutMs, signal);
  check();
  // An adapter may omit the proposal discriminator; the exact digest still
  // binds the result to that author's proposal. Any supplied seat must match.
  const receipt = request.proposalSeat && result && result.proposalSeat === undefined
    ? { ...result, proposalSeat: request.proposalSeat } : result;
  need(Buffer.byteLength(JSON.stringify(receipt ?? null)) <= MAX_ARTIFACT_BYTES, 'Review 回执超出2MB限制。');
  if (request.proposalSeat) {
    record.proposalReviewReceipts.push({ proposalSeat: request.proposalSeat, role: request.role, result: structuredClone(receipt ?? null) });
  } else {
    record.reviewReceipts.push(structuredClone(receipt ?? null));
  }
  if (!reviewMatches(receipt, request)) {
    record.ignored.push({ role: request.role, ...(request.proposalSeat ? { proposalSeat: request.proposalSeat } : {}),
      reason: '缺席或旧版本/不匹配的Review不计入放行。' });
    return null;
  }
  need(request.role !== request.selfTest.owner && reviewHasEvidence(receipt, request.obligations)
    && (!run || validFindingScopes(receipt.findings, run, proposal)),
    'Review 须由其他席位给出明确证据，退回必须有可复核的阻塞位置、影响和复核条件。');
  return structuredClone(receipt);
}

async function prepareProposals({ run, round, executor, timeoutMs, signal, check, record, attempt }) {
  const seats = specialists(run);
  const proposals = new Map(round.proposals.map(proposal => [proposal.seat, proposal]));
  const confirmedAnswers = (run.clarificationHistory ?? []).flatMap(item => item.answers);
  const routeIssues = hasIssueRouting(round);
  const agenda = routeIssues ? discussionTopics(run).map(({ positions, challenges, ...topic }) => topic) : [];
  const responses = await Promise.allSettled(seats.map(async seat => {
    if (proposals.has(seat)) return proposals.get(seat);
    const result = await bounded(Promise.resolve().then(() => executor.propose({ seat, spec: structuredClone(run.spec),
      source: structuredClone(run.sourceSnapshot), confirmedAnswers: structuredClone(confirmedAnswers),
      ...(routeIssues ? { topics: structuredClone(agenda.filter(item => !seat.startsWith('business:') || seat === `business:${item.requirementId}`)) } : {}),
      binding: structuredClone(round.binding), signal })), timeoutMs, signal);
    check();
    return versionedProposal(result, seat, run, round);
  }));
  check();
  const ready = round.proposals = responses.flatMap(response => response.status === 'fulfilled' ? [response.value] : []);
  const missing = responses.filter(result => result.status === 'rejected');
  if (missing.length) record.proposalWarnings = missing.map(result => result.reason.message);
  if (routeIssues && missing.length) return { ready, blocked: [], complete: false, phase: 'collecting' };
  const topics = routeIssues ? discussionTopics(run, ready) : [];

  await Promise.all(ready.map(async proposal => {
    if (proposal.status === 'passed') return;
    const artifact = routeIssues ? reviewProposalArtifact(proposal, topics, round.decisions) : { proposal: proposalContent(proposal) };
    if (routeIssues) {
      proposal.artifactRevision = contentRevision(artifact);
      proposal.selfTest.artifactRevision = proposal.artifactRevision;
    }
    const pending = proposal.requiredReviewers.filter(role => !proposal.reviews.some(result => result.role === role));
    const reviewed = await Promise.allSettled(pending.map(async role => {
      const obligations = scopedObligations(round, 'proposals', role, proposal.seat);
      const result = await requestReview({ executor, timeoutMs, signal, check, record,
        ...(routeIssues ? { run, proposal } : {}),
        request: { role, nodeId: 'proposals', proposalSeat: proposal.seat, artifact, selfTest: proposal.selfTest,
          binding: round.binding, artifactRevision: proposal.artifactRevision, scenario: round.scenario, attempt, obligations,
          ...(routeIssues ? { source: run.sourceSnapshot, confirmedAnswers } : {}) } });
      if (!result) return;
      proposal.reviews.push(result);
      proposal.blocking.push(...[...result.findings.filter(finding => finding.blocking), ...unresolvedObligations(result, obligations)]
        .map(finding => ({ ...finding, role, proposalSeat: proposal.seat })));
    }));
    check();
    for (const failure of reviewed.filter(item => item.status === 'rejected')) {
      (record.proposalWarnings ??= []).push(failure.reason.message);
    }
    proposal.reviews.sort((a, b) => proposal.requiredReviewers.indexOf(a.role) - proposal.requiredReviewers.indexOf(b.role));
    proposal.status = proposal.blocking.length ? 'rejected' : proposal.reviews.length === proposal.requiredReviewers.length ? 'passed' : 'waiting';
  }));
  const complete = missing.length === 0 && ready.every(proposal => proposal.status === 'passed');
  const awaiting = ready.some(proposal => proposal.reviews.length < proposal.requiredReviewers.length);
  return { ready, blocked: ready.flatMap(proposal => proposal.blocking), complete, phase: awaiting ? 'challenging' : 'routing' };
}
export async function advanceSpecificationMeeting(run, input, { executor = new OfflineSpecificationRoles(), timeoutMs = 3000, signal, assertAccess = () => {} } = {}) {
  const round = currentMeeting(run); assertCurrent(run, round);
  need(input.roundId === round.id && input.revision === run.specRevision, '评审轮次或版本已变化，请刷新。');
  need(!round.confirmation, '已确认的评审只保留记录。');
  const node = round.nodes.find(node => node.status !== 'passed');
  need(node && !['rejected', 'awaiting_user'].includes(node.status), '当前节点有阻塞，须用户裁决或实际修订后重审。');
  const captured = binding(run), nodeIndex = round.nodes.indexOf(node), attempt = node.attempts.length + 1;
  const routeIssues = hasIssueRouting(round);
  const check = () => { assertAccess(); assertCurrent(run, round); need(!signal?.aborted && sameBinding(captured, binding(run)), '旧评审结果已失效，不放行下游。'); };
  check(); need(node.attempts.length < 20, '本节点最多20次离线尝试。');
  node.reviews = []; node.blocking = [];
  const record = { at: now(), attempt, binding: captured, status: 'authoring', ignored: [], reviewReceipts: [], proposalReviewReceipts: [] };
  node.attempts.push(record);
  let artifact;
  try {
    if (node.id === 'baseline') artifact = { source: structuredClone(run.sourceSnapshot), confirmedAnswers: structuredClone(run.clarificationHistory ?? []),
      requirements: structuredClone(run.spec.requirements), sourceRevision: run.sourceRevision, coverage: round.coverage };
    if (node.id === 'proposals') {
      let proposals;
      if (hasProposalReview(round)) {
        const prepared = await prepareProposals({ run, round, executor, timeoutMs, signal, check, record, attempt });
        node.artifact = { proposals: prepared.ready };
        const needsUser = routeIssues && refreshDiscussion(run, round, prepared.phase);
        if (needsUser && !prepared.complete && round.issues.some(issue => issue.carriedFrom && canAnswerIssue(run, issue))) {
          node.blocking = prepared.blocked;
          node.status = prepared.blocked.length ? 'rejected' : 'awaiting_review';
          round.discussion.phase = 'routing'; round.status = 'awaiting_decision'; record.status = 'awaiting_user'; return;
        }
        if (prepared.blocked.length) {
          node.blocking = prepared.blocked;
          if (!routeIssues || needsUser || prepared.phase === 'routing') {
            if (needsUser) round.discussion.phase = 'routing';
            node.status = 'rejected'; round.status = needsUser ? 'awaiting_decision' : 'blocked';
            record.status = needsUser ? 'awaiting_user' : 'review_rejected'; return;
          }
        }
        if (!prepared.complete) {
          node.status = 'awaiting_review'; round.status = 'waiting'; record.status = 'waiting';
          record.reason = record.proposalWarnings?.[0] ?? '至少一个提案缺少当前版本的必审回执。';
          return;
        }
        proposals = prepared.ready;
      } else proposals = await Promise.all(specialists(run).map(async seat => {
        const result = await bounded(Promise.resolve().then(() => executor.propose({ seat, spec: structuredClone(run.spec),
          source: structuredClone(run.sourceSnapshot), confirmedAnswers: structuredClone((run.clarificationHistory ?? []).flatMap(round => round.answers)), binding: structuredClone(captured), signal })), timeoutMs, signal);
        check(); need(result?.seat === seat && Array.isArray(result.rules) && result.rules.length, `专业席 ${seat} 缺席或未提交规则。`);
        const expected = run.spec.requirements.filter(r => !seat.startsWith('business:') || seat === `business:${r.id}`);
        need(expected.every(r => result.rules.some(rule => rule.requirementId === r.id && rule.sourceQuote === r.sourceQuote
          && typeof rule.rule === 'string' && rule.rule.trim() && Array.isArray(rule.observable) && rule.observable.length)), `专业席 ${seat} 条款缺少来源或可观察结果。`);
        return { ...result, selfTest: { passed: true, method: '条款来源、覆盖和场景走查', binding: captured, owner: seat, kind: 'offline_fixture' } };
      }));
      round.proposals = structuredClone(proposals);
      const authoritative = sourceTexts(run);
      round.sourceResolutions = proposals.flatMap(proposal => (proposal.sourceResolutions ?? []).map(resolution => {
        need(typeof resolution.sourceQuote === 'string' && resolution.sourceQuote.trim() && authoritative.some(text => text.includes(resolution.sourceQuote))
          && resolution.answer === resolution.sourceQuote && resolution.requirementIds?.length
          && resolution.requirementIds.every(id => run.spec.requirements.some(r => r.id === id))
          && resolution.roles?.length === 1 && resolution.roles[0] === proposal.seat, '来源裁决必须逐字引用原文或已确认答复并绑定受影响条款。');
        return { ...resolution, fromSpecRevision: run.specRevision, at: now() };
      }));
      if (routeIssues) refreshDiscussion(run, round, 'routing');
      else {
        for (const proposal of proposals) for (const issue of proposal.issues ?? []) {
          need(typeof issue.question === 'string' && issue.question.trim() && issue.requirementIds?.length
            && issue.requirementIds.every(id => run.spec.requirements.some(r => r.id === id)) && issue.options?.length >= 2
            && issue.options.every(option => typeof option === 'string' && option.trim()), '专业异议缺少条款、选项或依据。');
        }
        round.issues = collectIssues(round, proposals);
      }
      artifact = { proposals, issues: round.issues,
        ...(routeIssues ? { discussionRevision: contentRevision(round.discussion) } : {}) };
    }
    if (node.id === 'decisions') {
      const open = round.issues.filter(issue => issue.blocking && issue.status !== 'closed');
      artifact = { topics: [...new Set(round.issues.map(issue => issue.topic))], issues: round.issues, decisions: round.decisions, sourceResolutions: round.sourceResolutions ?? [] };
      if (open.length) {
        const canAnswer = !routeIssues || open.some(issue => canAnswerIssue(run, issue));
        node.artifact = artifact;
        node.status = canAnswer ? 'awaiting_user' : 'rejected'; round.status = canAnswer ? 'awaiting_decision' : 'blocked';
        record.status = canAnswer ? 'awaiting_user' : 'review_rejected';
        if (!canAnswer) record.reason = '此前的业务问题涉及当前规格中缺失的条款，请先恢复条款或更新需求范围。';
        return;
      }
    }
    if (node.id === 'specification') artifact = {
      spec: structuredClone(run.spec), coverage: round.coverage, decisions: round.decisions,
      ...(hasProposalReview(round) ? { proposalEvidence: specificationProposalEvidence(round) } : {}),
    };
    if (node.id === 'checklist') {
      round.checklist = stageChecklist(round);
      if (hasProposalReview(round)) round.featureReviews = featureReviewDefinitions(run, round);
      artifact = { checklist: round.checklist, ...(round.featureReviews ? { featureReviews: round.featureReviews } : {}) };
    }
    if (node.id === 'confirmation') artifact = { specRevision: run.specRevision, priorNodeVersions: round.nodes.slice(0, 5).map(n => ({ id: n.id, revision: n.selfTest?.artifactRevision })),
      decisions: round.decisions, checklistRevision: contentRevision(round.checklist),
      ...(hasProposalReview(round) ? { featureReviewRevision: contentRevision(round.featureReviews) } : {}) };
    check(); need(Buffer.byteLength(JSON.stringify(artifact)) <= MAX_ARTIFACT_BYTES, '评审产物超出2MB限制。');
    node.artifact = structuredClone(artifact);
    const artifactRevision = contentRevision(artifact);
    const selfPassed = checkCoverage(run, round.coverage) && round.nodes.slice(0, nodeIndex).every(n => n.status === 'passed')
      && run.spec.requirements.every(r => r.sourceQuote && r.acceptance?.length)
      && (!hasProposalReview(round) || run.spec.requirements.every(hasFormatDefinition))
      && (node.id !== 'checklist' || round.checklist.every(row => row.rules.length === run.spec.requirements.length && row.requiredReviewers.length && row.requiredEvidence));
    node.selfTest = { owner: node.owner, binding: captured, artifactRevision, passed: selfPassed, kind: selfTestKind(round),
      evidence: ['原文与已确认答复引用核对', '需求主责/独立审阅/专业维度覆盖检查', '关键场景、可观察条件与下游承接走查'] };
    record.selfTest = structuredClone(node.selfTest);
    if (!selfPassed) { node.status = 'rejected'; round.status = 'blocked'; record.status = 'self_test_failed'; return; }
    node.status = 'awaiting_review';
    for (const role of reviewers(node, run)) {
      const obligations = scopedObligations(round, node.id, role, undefined);
      const result = await requestReview({ executor, timeoutMs, signal, check, record,
        ...(routeIssues ? { run } : {}),
        request: { role, nodeId: node.id, artifact, selfTest: node.selfTest, binding: captured,
          artifactRevision, scenario: round.scenario, attempt, obligations } });
      if (!result) { record.status = 'awaiting_review'; round.status = 'waiting'; return; }
      node.reviews.push(result);
      node.blocking.push(...result.findings.filter(finding => finding.blocking).map(finding => ({ ...finding, role })));
      node.blocking.push(...unresolvedObligations(result, obligations));
      if (!result.passed || node.blocking.length) {
        const needsUser = routeIssues && refreshDiscussion(run, round, 'routing');
        node.status = 'rejected'; round.status = needsUser ? 'awaiting_decision' : 'blocked';
        record.status = needsUser ? 'awaiting_user' : 'review_rejected'; return;
      }
    }
    check(); node.status = 'passed'; record.status = 'passed'; record.finishedAt = now(); round.status = 'in_progress';
    if (routeIssues) refreshDiscussion(run, round, 'routing');
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
  if (hasProposalReview(round)) {
    const seats = specialists(run);
    const topics = hasIssueRouting(round) ? discussionTopics(run, round.proposals) : [];
    need(round.proposals.length === seats.length && seats.every(seat => {
      const proposal = round.proposals.find(item => item.seat === seat);
      if (!proposal || proposal.status !== 'passed' || proposal.blocking.length) return false;
      const authorRevision = contentRevision({ proposal: proposalContent(proposal) });
      if (hasIssueRouting(round) && proposal.authorRevision !== authorRevision) return false;
      const artifactRevision = hasIssueRouting(round) ? contentRevision(reviewProposalArtifact(proposal, topics, round.decisions)) : authorRevision;
      return proposal.artifactRevision === artifactRevision && proposal.selfTest.passed === true
        && proposal.selfTest.owner === seat && proposal.selfTest.artifactRevision === artifactRevision
        && sameBinding(proposal.selfTest.binding, round.binding) && proposalReviewers(seat).every(role => {
          const obligations = scopedObligations(round, 'proposals', role, seat);
          return proposal.reviews.some(receipt => receipt.passed === true && reviewHasEvidence(receipt, obligations)
            && reviewMatches(receipt, { role, nodeId: 'proposals', proposalSeat: seat, artifactRevision, binding: round.binding })
            && !receipt.findings.some(finding => finding.blocking) && !unresolvedObligations(receipt, obligations).length);
        });
    }) && run.spec.requirements.every(hasFormatDefinition)
      && contentRevision(round.featureReviews ?? []) === contentRevision(featureReviewDefinitions(run, round))
      && contentRevision(round.nodes.find(node => node.id === 'specification')?.artifact?.proposalEvidence ?? [])
        === contentRevision(specificationProposalEvidence(round)),
    '专业提案或逐需求 Review 定义缺少同版本证据，不能确认。');
    need(round.obligations.filter(item => item.proposalSeat).every(item =>
      seats.includes(item.proposalSeat) && proposalReviewers(item.proposalSeat).includes(item.role)),
    '有历史提案阻塞尚无同一责任席位复核，须核对修订范围。');
  }
  if (hasIssueRouting(round)) {
    const reconstructed = { ...round };
    refreshDiscussion(run, reconstructed, 'routing');
    need(contentRevision(reconstructed.discussion) === contentRevision(round.discussion)
      && !round.discussion.awaitingProposals.length && !round.discussion.awaitingReviews.length
      && !round.discussion.routes.some(route => route.blocking && route.status !== 'closed'),
    '尚有议题回执缺失或者分流阻塞未关闭，请先核对本版。');
  }
  for (const [index, node] of round.nodes.entries()) {
    const expected = MEETING_NODES[index];
    const hash = contentRevision(node.artifact);
    need(node.id === expected.id && node.owner === expected.owner && node.status === 'passed' && node.selfTest?.passed === true
      && node.selfTest.owner === expected.owner && sameBinding(node.selfTest.binding, binding(run)) && node.selfTest.artifactRevision === hash
      && reviewers(node, run).every(role => node.reviews.some(review => review.role === role && role !== node.owner && review.passed === true
        && review.nodeId === node.id && sameBinding(review.binding, binding(run)) && review.artifactRevision === hash && !review.findings.some(finding => finding.blocking)
        && !unresolvedObligations(review, scopedObligations(round, node.id, role, undefined)).length)),
    `${node.title}的自测、必审席位或同版本Review尚未通过。`);
  }
  if (expectedBundle !== undefined) need(expectedBundle === round.bundleRevision, '确认包版本已变化，请核对规格、纪要和清单后重新确认。');
}
export function specificationMeetingIssue(run) {
  const round = currentMeeting(run);
  if (!round || run.status !== 'awaiting_spec' || !sameBinding(round.binding, binding(run)) || round.status !== 'awaiting_decision') return null;
  const qa = round.issues.filter(issue => hasIssueRouting(round) ? canAnswerIssue(run, issue) : issue.blocking && issue.status !== 'closed')
    .map(issue => ({ id: issue.id,
    question: `${issue.requirementIds.join('、')} / ${issue.roles.map(role => round.seats[role] ?? role).join('、')}：${issue.question}\n请选择并原样填写一个选项：\n${issue.options.join('\n')}\n影响：${issue.impact}` }));
  const id = contentRevision([round.id, round.binding, qa]);
  return { id, kind: 'specification_meeting', stageId: 'spec', title: '多 Agent 规格评审业务裁决',
    message: hasIssueRouting(round) ? '请决定原文无法裁定的业务选项。答复会生成新版本，其他待返工和缺少回执的问题仍须复核。'
      : '权限与数据等专业席的关联异议已归并，原文不能唯一裁定时须用户选择；答复后生成新规格版本并重新复核。',
    qa, questions: qa.map(row => row.question), answers: run.planningIssueDraft?.id === id ? run.planningIssueDraft.answers ?? {} : {},
    allowQuestions: true, autoExplain: false, canExplain: false, pending: false, canSave: true, canContinue: true };
}
export function prepareMeetingAnswers(run, issue, input) {
  const round = currentMeeting(run); assertCurrent(run, round);
  need(issue.id === input.issueId && typeof input.continue === 'boolean' && input.answers && typeof input.answers === 'object', '议题版本或回答格式不正确。');
  need(Object.keys(input.answers).every(id => issue.qa.some(q => q.id === id)), '包含旧版或未知议题。');
  const decisions = round.issues.filter(item => issue.qa.some(entry => entry.id === item.id)).flatMap(item => {
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
  const reviewed = round.nodes.find(node => node.id === 'specification');
  return [{ name: 'spec-review-minutes.json', title: '规格评审会议纪要', content: JSON.stringify({ kind: round.kind,
    rounds: run.specReview.rounds, currentRoundId: round.id }, null, 2) },
  { name: 'stage-review-checklist.json', title: '阶段验收与Review清单', content: JSON.stringify({ definitionOnly: true,
    binding: round.binding, bundleRevision: round.bundleRevision, confirmation: round.confirmation,
    checklist: round.checklist ?? [], featureReviews: round.featureReviews ?? [] }, null, 2) },
  { name: 'reviewed-design-specification.json', title: '设计规格同版评审证据', content: JSON.stringify({
    kind: round.kind, state: round.status, current: sameBinding(round.binding, binding(run)), binding: round.binding,
    bundleRevision: round.bundleRevision, confirmation: round.confirmation, artifactRevision: reviewed?.selfTest?.artifactRevision ?? null,
    specification: reviewed?.artifact ?? null, selfTest: reviewed?.selfTest ?? null, reviews: reviewed?.reviews ?? [],
  }, null, 2) }];
}
