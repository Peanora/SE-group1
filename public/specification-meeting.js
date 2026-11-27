const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const status = {
  pending: '等待前置', passed: '通过', awaiting_review: '等待独立 Review', awaiting_user: '等待业务裁决',
  rejected: '退回修改', in_progress: '评审进行中', waiting: '等待有效证据', blocked: '有阻塞异议',
  awaiting_decision: '等待用户裁决', awaiting_confirmation: '规格和清单待联合确认',
  needs_source_revision: '需求内容待更新', superseded: '旧版本，仅保留历史',
};

const phases = [
  { id: 'baseline', label: '需求基线', title: '确认需求基线', owner: 'product', detail: '固定原文、已确认答复与本版规格，逐条核对可追溯性。' },
  { id: 'proposals', label: '专业提案', title: '形成专业提案', owner: 'facilitator', detail: '业务域和专业席提交版本化提案，自测后接受各自的独立审阅。' },
  { id: 'decisions', label: '讨论裁决', title: '讨论并决策', owner: 'facilitator', detail: '汇集关联异议，明确选择的依据、影响范围及谁来复核。' },
  { id: 'specification', label: '设计规格', title: '汇编设计规格', owner: 'author', detail: '合并已经过裁决的规则，对同一规格逐条验收和专业复核。' },
  { id: 'checklist', label: 'Review 规则', title: '确定阶段 Review 要求', owner: 'acceptance', detail: '为未来的功能、阶段和交付定义证据、放行条件及返工去向。' },
  { id: 'confirmation', label: '联合确认', title: '提交用户确认', owner: 'author', detail: '核对同一版本的设计规格、会议纪要和 Review 定义后确认。' },
];

const roleLabels = {
  facilitator: '会议主持', product: '产品需求', author: '规格主笔', acceptance: '验收设计', independent: '独立 Review',
  interaction: '交互席', data: '数据席', access: '权限席', interface: '接口席', reliability: '可靠性席',
  architect: '架构设计', pm: '任务拆解', tester: '测试与验收', developer: '开发',
  integrator: '集成验证', delivery: '交付',
};

const specialties = ['interaction', 'data', 'access', 'interface', 'reliability'];
const isModelRound = round => round?.kind === 'model_review' || round?.scenario === 'model_review';
const views = [
  { id: 'nodes', label: '节点证据' },
  { id: 'features', label: '逐条评审' },
  { id: 'gates', label: '阶段门禁' },
];
const discussionViews = [
  { id: 'discussion', label: '议题讨论' },
  { id: 'routing', label: '问题分流' },
];
const discussionPhases = { collecting: '收集独立提案', challenging: '交叉质疑', routing: '汇总并分流' };
const routeNames = {
  source_rework: '按原文修订',
  cross_requirement_conflict: '协调跨条款冲突',
  human_decision: '由用户裁决',
  review_required: '待规格主笔核对',
};
const label = (round, role) => round?.seats?.[role] ?? roleLabels[role] ?? role;
const phaseLabel = value => status[value] ?? value;
const short = value => typeof value === 'string' ? value.slice(0, 10) : '尚未形成';
const list = values => (Array.isArray(values) ? values : values ? [values] : []).filter(Boolean);
const joined = (values, separator = '、') => list(values).map(escape).join(separator);
const listMarkup = values => list(values).map(value => `<li>${escape(value)}</li>`).join('');
const textMarkup = values => list(values).map(value => `<p>${escape(value)}</p>`).join('');

function field(title, value) {
  return `<div><dt>${escape(title)}</dt><dd>${escape(value)}</dd></div>`;
}

function stageMap(round, active, selectedNode, pending) {
  const nodes = new Map(round?.nodes.map(node => [node.id, node]));
  return `<ol class="sm-map" aria-label="规格评审流程">
    ${phases.map((phase, index) => {
      const node = nodes.get(phase.id);
      const selected = selectedNode === phase.id;
      const live = pending && active === phase.id;
      const waitingForConfirmation = phase.id === 'confirmation' && node?.status === 'passed' && !round.confirmation;
      const visualStatus = waitingForConfirmation ? 'awaiting_confirmation' : node?.status ?? 'pending';
      return `<li data-phase-state="${escape(visualStatus)}" data-phase-live="${live}">
        <button type="button" class="sm-map-node" data-meeting="node" data-node="${phase.id}" aria-pressed="${selected}" aria-controls="spec-meeting-content" title="${escape(node?.title ?? phase.title)}">
          <span class="sm-map-stop" aria-hidden="true">${visualStatus === 'passed' ? '✓' : String(index + 1).padStart(2, '0')}</span>
          <strong>${round?.discussion && phase.id === 'decisions' ? '汇总与分流' : phase.label}</strong>
          <span class="sm-map-state">${live ? '等待本次响应' : waitingForConfirmation ? '待用户确认' : escape(phaseLabel(visualStatus))}</span>
        </button>
      </li>`;
    }).join('')}
  </ol>`;
}

function seatLanes(round) {
  const seats = Object.keys(round?.seats ?? {});
  const proposals = new Map(round?.proposals?.map(proposal => [proposal.seat, proposal]));
  const lanes = [
    { title: '业务域', roles: seats.filter(role => role.startsWith('business:')) },
    ...specialties.map(role => ({ title: label(round, role), roles: seats.includes(role) ? [role] : [] })),
  ];
  return `<div class="sm-seats" aria-label="并行专业席位">
    ${lanes.map(({ title, roles }) => {
      const entries = roles.map(role => proposals.get(role)).filter(Boolean);
      const blocked = entries.some(item => item.status === 'rejected' || item.blocking?.length);
      const approved = roles.length > 0 && roles.every(role => proposals.get(role)?.status === 'passed');
      const result = blocked ? 'blocked' : approved ? 'passed' : entries.length ? 'submitted' : 'pending';
      const text = blocked ? '退回修改' : approved ? '独立复核通过'
        : entries.length ? `${entries.length}/${roles.length} 已提交` : roles.length ? '待提交' : '待分配';
      return `<div class="sm-seat" data-seat-state="${result}">
        <span class="sm-seat-signal" aria-hidden="true"></span>
        <span><strong>${escape(title)}</strong><small>${text}</small></span>
      </div>`;
    }).join('')}
  </div>`;
}

function findingsMarkup(items, round) {
  return list(items).map(finding => `<li>
    <strong>${escape(finding.location || finding.requirementId || '需复核')}</strong>
    ${finding.role ? `<span>${escape(label(round, finding.role))}</span>` : ''}
    <p>${escape(finding.impact)}</p><p>复核条件：${escape(finding.condition)}</p>
  </li>`).join('');
}

function requestUsage(round) {
  const requests = round?.modelRequests;
  if (!requests || !Number.isInteger(requests.limit)) return '';
  const attempts = list(requests.attempts);
  const used = attempts.reduce((sum, attempt) => sum + (attempt.used ?? attempt.reserved ?? 0), 0);
  const unsettled = attempts.filter(attempt => attempt.used === null).length;
  return `<span>请求 ${escape(used)} / ${escape(requests.limit)}${unsettled ? '（包含待核对额度）' : ''}</span>`;
}

function nodeEvidence(node, phase, round) {
  const blocker = findingsMarkup(node?.blocking, round);
  const latest = node?.attempts?.at(-1);
  const artifactRevision = node?.selfTest?.artifactRevision ?? latest?.artifactRevision;
  const selfPassed = node?.selfTest?.passed;
  const reviews = list(node?.reviews);
  return `<section class="sm-evidence" aria-label="当前节点证据">
    <div class="sm-evidence-head"><div><h4>${escape(node?.title ?? phase.title)}</h4><p>${escape(phase.detail)}</p></div>
      <span class="sm-chip" data-tone="${escape(node?.status ?? 'pending')}">${escape(phaseLabel(node?.status ?? 'pending'))}</span>
    </div>
    <dl class="sm-measure">
      ${field('主责席位', label(round, node?.owner ?? phase.owner))}
      ${field('主责自测', selfPassed === true ? '通过' : selfPassed === false ? '未通过' : '待提交')}
      ${field('同版独立 Review', reviews.length ? `${reviews.filter(item => item.passed === true).length} 份通过 / ${reviews.length} 份记录` : '等待证据')}
      ${field('固定产物版本', short(artifactRevision))}
    </dl>
    ${latest?.reason ? `<p class="sm-message">${escape(latest.reason)}</p>` : ''}
    ${latest?.ignored?.length ? `<ul class="sm-line-list">${latest.ignored.map(receipt => `<li>${escape(label(round, receipt.role))}：${escape(receipt.reason)}</li>`).join('')}</ul>` : ''}
    ${blocker ? `<section class="sm-blockers"><h5>阻塞与返工</h5><ul>${blocker}</ul></section>` : ''}
    ${node?.selfTest?.evidence?.length ? `<details data-meeting-detail="self-test"><summary>查看主责自测依据</summary><ul>${listMarkup(node.selfTest.evidence)}</ul></details>` : ''}
    ${reviews.length ? `<ul class="sm-line-list sm-receipts" aria-label="同版本 Review 回执">
      ${reviews.map(review => `<li><div><strong>${escape(label(round, review.role))}</strong><span class="sm-chip" data-tone="${review.passed ? 'passed' : 'rejected'}">${review.passed ? '通过' : '退回'}</span></div>
        <p>${escape(review.evidence)}</p>${review.findings?.length ? `<ul class="sm-findings">${findingsMarkup(review.findings, round)}</ul>` : ''}</li>`).join('')}
    </ul>` : ''}
    ${node ? `<details data-meeting-detail="node-record"><summary>同版本产物、自测及角色 Review 证据</summary>
      <pre>${escape(JSON.stringify({ artifact: node.artifact, selfTest: node.selfTest, reviews, attempts: node.attempts }, null, 2))}</pre></details>` : ''}
  </section>`;
}

function proposalEvidence(round) {
  const proposals = list(round?.proposals);
  if (!proposals.length) return '';
  return `<details class="sm-secondary" data-meeting-detail="professional-evidence">
    <summary>各席提案、自测与复核（${proposals.length}）</summary>
    <ul class="sm-line-list sm-receipts">
      ${proposals.map(proposal => `<li><div><strong>${escape(label(round, proposal.seat))}</strong><span class="sm-chip" data-tone="${escape(proposal.status ?? 'pending')}">
        ${escape(proposal.status ? phaseLabel(proposal.status) : '已提交提案')}</span></div>
        <p>自测 ${proposal.selfTest?.passed === true ? '通过' : '待核对'} · 产物 ${escape(short(proposal.artifactRevision))}</p>
        ${proposal.requiredReviewers?.length ? `<p>必审 ${joined(proposal.requiredReviewers.map(role => label(round, role)))}</p>` : ''}
        ${proposal.reviews?.length ? `<ul class="sm-findings">${proposal.reviews.map(review => `<li>${escape(label(round, review.role))} ${review.passed ? '通过' : '退回'} · ${escape(review.evidence)}</li>`).join('')}</ul>` : ''}
        ${proposal.blocking?.length ? `<ul class="sm-findings">${findingsMarkup(proposal.blocking, round)}</ul>` : ''}
      </li>`).join('')}
    </ul>
  </details>`;
}

function issueEvidence(round) {
  if (!round) return '';
  const issues = list(round.issues);
  const decisions = list(round.decisions);
  const reservations = list(round.proposals).flatMap(proposal => list(proposal.reservations));
  if (!issues.length && !decisions.length && !reservations.length) return '';
  return `<details class="sm-secondary" data-meeting-detail="issue-record">
    <summary>关联议题、用户裁决和非阻塞保留意见</summary>
    <ul class="sm-line-list sm-receipts">
      ${issues.map(issue => `<li><div><strong>${escape(issue.question)}</strong><span class="sm-chip" data-tone="${issue.blocking && issue.status !== 'closed' ? 'blocked' : 'pending'}">
        ${issue.status === 'closed' ? '已裁决' : issue.blocking ? '阻塞' : '保留'}</span></div>
        <p>${joined(issue.requirementIds)} · ${joined(list(issue.roles).map(role => label(round, role)))}</p>
        <p>${escape(issue.impact)}</p></li>`).join('')}
      ${decisions.map(decision => `<li><strong>${escape(decision.question)}</strong><p>${escape(decision.answer)}</p><p>依据：${escape(decision.basis)}</p></li>`).join('')}
      ${[...new Set(reservations)].map(text => `<li><p>${escape(text)}</p></li>`).join('')}
    </ul>
  </details>`;
}

function discussionEvidence(round, selectedTopic) {
  const discussion = round.discussion;
  const topics = list(discussion.topics);
  const match = topics.find(topic => topic.id === selectedTopic);
  const related = list(discussion.routes).find(route => route.blocking && route.requirementIds?.length);
  const topic = match ?? topics.find(item => related?.requirementIds.includes(item.requirementId)) ?? topics[0];
  const positions = list(topic?.positions);
  const challenges = list(topic?.challenges);
  return `<section class="sm-sheet sm-discussion" aria-label="同议题提案与交叉质疑">
    <div class="sm-evidence-head"><div><h4>同议题提案与交叉质疑</h4><p>各席先独立提交，提案固定后再交其他席位质疑。</p></div>
      <span class="sm-chip">${escape(discussionPhases[discussion.phase] ?? discussion.phase)}</span></div>
    ${topic ? `<label class="sm-topic-picker">业务议题 <select data-meeting="topic">
      ${topics.map(item => `<option value="${escape(item.id)}"${item === topic ? ' selected' : ''}>${escape(item.requirementId)} · ${escape(item.title)}</option>`).join('')}
      </select></label>
    <div class="sm-discussion-columns">
      <section><h5>独立提案 <span>${positions.length} 份</span></h5>
        ${positions.length ? `<ul class="sm-line-list">${positions.map(position => `<li>
          <strong>${escape(label(round, position.seat))}</strong><code>${escape(short(position.proposalRevision))}</code>
          <p>${escape(position.rule)}</p>${position.exception ? `<p>${escape(position.exception)}</p>` : ''}
        </li>`).join('')}</ul>` : '<p class="sm-message">等待独立提案。</p>'}</section>
      <section><h5>交叉质疑 <span>${challenges.length} 份</span></h5>
        ${challenges.length ? `<ul class="sm-line-list">${challenges.map(challenge => `<li>
          <strong>${escape(label(round, challenge.role))} → ${escape(label(round, challenge.proposalSeat))}</strong>
          <p>${escape(challenge.evidence)}</p>
          ${challenge.findings?.length ? `<ul class="sm-findings">${findingsMarkup(challenge.findings, round)}</ul>` : ''}
        </li>`).join('')}</ul>` : '<p class="sm-message">提案固定后接收交叉质疑。</p>'}</section>
    </div>` : '<p class="sm-message">需求基线固定后会列出业务议题。</p>'}
    ${discussion.awaitingProposals?.length ? `<p class="sm-message">等待 ${discussion.awaitingProposals.length} 份提案。</p>` : ''}
    ${discussion.awaitingReviews?.length ? `<p class="sm-message">等待 ${discussion.awaitingReviews.length} 份有效质疑回执。</p>` : ''}
  </section>`;
}

function routingEvidence(round, canRevise) {
  const routes = list(round.discussion.routes);
  const groups = Object.entries(routeNames).map(([kind, title]) => ({ kind, title, entries: routes.filter(route => route.kind === kind) }));
  return `<section class="sm-sheet sm-routing" aria-label="问题分流记录">
    <div class="sm-evidence-head"><div><h4>问题分流记录</h4><p>按依据与影响确定处理去向。阻塞项关闭后才放行规格。</p></div>
      <span class="sm-chip">${routes.length} 项</span></div>
    ${routes.length ? groups.filter(group => group.entries.length).map(group => `<section class="sm-route-group" data-route-kind="${group.kind}">
      <h5>${group.title}</h5><ul class="sm-line-list">${group.entries.map(route => {
        const clauses = list(route.requirementIds);
        const open = route.status === 'open';
        return `<li><div class="sm-route-title"><strong>${escape(route.question || route.location || clauses.join('、') || '规格层问题')}</strong>
          <span class="sm-chip" data-tone="${open ? route.blocking ? 'blocked' : 'pending' : 'passed'}">
            ${open ? route.blocking ? '阻塞' : '保留' : route.status === 'resolved_pending_recheck' ? '待复核' : '已关闭'}</span></div>
          ${route.impact ? `<p>${escape(route.impact)}</p>` : ''}
          ${clauses.length || route.role ? `<p>${joined(clauses)}${clauses.length && route.role ? ' · ' : ''}${escape(route.role ? label(round, route.role) : '')}</p>` : ''}
          ${route.sourceQuote ? `<blockquote>${escape(route.sourceQuote)}</blockquote>` : ''}
          ${route.condition ? `<p><strong>复核条件</strong> ${escape(route.condition)}</p>` : ''}
          ${canRevise && open && group.kind !== 'human_decision' ? `<button type="button" class="text-button" data-meeting="revise-clause"
            data-clause="${escape(clauses[0] ?? '')}">修订规格条款</button>` : ''}
        </li>`;
      }).join('')}</ul>
    </section>`).join('') : `<p class="sm-message">${round.discussion.phase === 'routing' ? '本轮没有需分流的问题。' : '交叉质疑结束后会在这里汇总。'}</p>`}
  </section>`;
}

function featureEvidence(round) {
  const features = list(round?.featureReviews);
  const coverage = list(round?.coverage);
  const proposals = new Map(list(round?.proposals).map(proposal => [proposal.seat, proposal]));
  return `<section class="sm-sheet">
    <div class="sm-evidence-head"><div><h4>按需求条款定义 Review</h4><p>由规格生成的检查标准、证据和返工去向。执行结果将在后续阶段记录。</p></div><span class="sm-chip">${features.length} 条定义</span></div>
    ${features.length ? features.map((feature, index) => {
      const proposal = proposals.get('business:' + feature.requirementId);
      return `<details class="sm-record" data-meeting-detail="feature-${index}">
      <summary>${escape(feature.specClause ?? feature.title ?? feature.requirementId)}</summary>
      <dl class="sm-meta">${field('主责席位', label(round, feature.owner))}${field('必审席位', list(feature.requiredReviewers).map(role => label(round, role)).join('、'))}</dl>
      ${feature.sourceQuote ? `<blockquote>${escape(feature.sourceQuote)}</blockquote>` : ''}
      ${proposal?.status ? `<p class="sm-message">本版业务提案：${escape(phaseLabel(proposal.status))} · 产物 ${escape(short(proposal.artifactRevision))}</p>` : ''}
      <ul class="sm-line-list">${list(feature.checks).map(check => `<li>
        <strong>${check.kind === 'format' ? '格式与规范' : '业务行为'}</strong> · ${escape(check.expected)}
        ${check.definitionStatus === 'pending' ? '<span class="sm-chip" data-tone="waiting">待补充</span>' : ''}
        <p>证据：${escape(check.evidence)}</p>
      </li>`).join('')}</ul>
      ${feature.selfTest ? `<p><strong>主责自测：</strong> ${escape(feature.selfTest)}</p>` : ''}
      ${feature.independentReview ? `<p><strong>独立复核：</strong> ${escape(feature.independentReview)}</p>` : ''}
      ${feature.rework ? `<p><strong>返工：</strong> ${escape(feature.rework)}</p>` : ''}
      </details>`;
    }).join('') : '<p class="sm-message">逐条 Review 定义将在阶段门禁节点生成。当前可查看需求覆盖和可观察条件。</p>'}
    ${coverage.length ? `<details class="sm-secondary" data-meeting-detail="coverage"><summary>需求覆盖与专业席位（${coverage.length}）</summary><ul class="sm-line-list">
      ${coverage.map(row => `<li><strong>${escape(row.clause)}</strong>
      <p>主责 ${escape(label(round, row.owner))} · 独立审阅 ${escape(label(round, row.reviewer))}</p>
      <p>专业席：${joined(list(row.specialists).map(role => label(round, role)))}</p>
      <ul>${listMarkup(row.observable)}</ul></li>`).join('')}
    </ul></details>` : ''}
  </section>`;
}

function gateEvidence(round) {
  const stages = list(round?.checklist);
  const names = new Map(stages.map(stage => [stage.id, stage.title]));
  names.set('spec_confirmation', '规格联合确认');
  const dependencies = ids => list(ids).map(id => names.get(id) ?? id).join('、') || '—';
  return `<section class="sm-sheet">
    <div class="sm-evidence-head"><div><h4>阶段验收与 Review 清单（定义，不代表已执行）</h4>
      <p>阶段 Review 核对同一版本的产物、必要证据和阻塞关闭情况。</p></div><span class="sm-chip">${stages.length} 个门禁</span></div>
    ${stages.map((row, index) => `<details class="sm-record" data-meeting-detail="gate-${index}"><summary>${escape(row.title)}</summary>
      <dl class="sm-meta">
        ${field('主责席位', label(round, row.owner))}
        ${field('必审席位', list(row.requiredReviewers).map(role => label(round, role)).join('、'))}
        ${field('依赖', dependencies(row.dependsOn))}
        ${field('下游', dependencies(row.downstream))}
      </dl>
      ${row.inputs?.length ? `<p><strong>输入：</strong> ${joined(row.inputs)}</p>` : ''}
      ${row.deliverables?.length ? `<p><strong>阶段产物：</strong> ${joined(row.deliverables)}</p>` : ''}
      <p><strong>放行条件：</strong> ${escape(row.condition)}</p>
      <p><strong>验收证据：</strong> ${escape(row.requiredEvidence)}</p>
      ${row.independentReview ? `<p><strong>独立复核：</strong> ${escape(row.independentReview)}</p>` : ''}
      ${textMarkup(row.blockingPolicy)}
      ${row.rework ? `<p><strong>返工：</strong> ${escape(row.rework)}</p>` : ''}
      <ul class="sm-line-list">${list(row.rules).map(rule => `<li><strong>${escape(rule.specClause)}</strong>
        <ul>${listMarkup(rule.observable)}</ul></li>`).join('')}</ul>
    </details>`).join('') || '<p class="sm-message">前置节点通过后生成阶段 Review 定义。</p>'}
  </section>`;
}

function reviewStart({ run, pending, busy, canEdit, modelReview, current, scenario }) {
  if (current || run.status !== 'awaiting_spec' || run.sourceSuperseded) return '';
  const disabled = busy || pending || !canEdit ? ' disabled' : '';
  const modelRequired = run.specReview?.rounds?.some(isModelRound);
  const canStartModel = modelReview?.available && Number.isInteger(modelReview.maxCalls);
  const choices = [
    ['reservation', '业务规则与裁决'],
    ['reject_review', '模拟自测通过但独立 Review 退回'],
    ['late_review', '模拟旧版本 Review 迟到'],
  ];
  return `<div class="sm-start">
    ${!modelRequired ? `<div class="sm-options">
      <label>离线场景 <select data-meeting="scenario" aria-label="规格评审离线场景"${disabled}>
        ${choices.map(([value, title]) => `<option value="${value}"${scenario === value ? ' selected' : ''}>${title}</option>`).join('')}
      </select></label>
      <button type="button" class="button button-outline" data-meeting="start"${disabled}>启用本版离线评审</button>
    </div>` : ''}
    ${canStartModel ? `<div class="sm-model-start">
      <button type="button" class="button button-primary" data-meeting="start-model"${disabled}>启用本版模型评审</button>
      <p>当前项目的需求与规格将发送至已配置的模型服务${modelReview.modelNames?.length ? `（${joined(modelReview.modelNames)}）` : ''}。每个规划运行最多 ${modelReview.maxCalls} 次请求，按服务商计费。点击即授权。</p>
    </div>` : modelRequired ? '<p class="sm-message">本项目的评审修订需使用模型评审。请在 Agent 角色中恢复模型服务配置。</p>' : ''}
  </div>`;
}

function reviewActions({ round, current, run, busy, pending, canEdit, modelReview }) {
  if (!round || !current || run.status !== 'awaiting_spec') return '';
  const model = isModelRound(round);
  const disabled = busy || pending || !canEdit || (model && !modelReview?.available) ? ' disabled' : '';
  let body = '';
  if (['in_progress', 'waiting'].includes(round.status)) {
    body = `<button type="button" class="button button-primary" data-meeting="continue"${disabled}>${model ? '继续模型评审' : '继续离线评审'}</button>`;
    if (model && !modelReview?.available) body += '<p>模型评审服务不可用，请在 Agent 角色中核对配置。</p>';
  } else if (round.status === 'awaiting_decision') {
    body = '<button type="button" class="button button-primary" data-meeting="issues">查看问题并裁决</button>';
  } else if (round.status === 'blocked') {
    body = '<p>按阻塞项修改相关条款并保存，在新版本重新发起评审。原意见和复核条件将随新轮次保留。</p>';
    if (round.discussion?.routes?.length) body += '<button type="button" class="button button-primary" data-meeting="view" data-view="routing">查看问题分流</button>';
  } else if (round.status === 'awaiting_confirmation') {
    body = '<p>请核对设计规格、会议纪要和阶段清单，然后使用下方联合确认按钮。</p>';
  } else if (round.status === 'needs_source_revision') {
    body = '<p>先按此次裁决更新需求，再为新版本继续评审。</p>';
  }
  return body ? `<div class="sm-action-row">${body}</div>` : '';
}

export function createSpecificationMeeting({ container, getState, submit, inspectIssue, reviseClause = () => {}, showArtifact }) {
  let pendingRun = '', signature = '', scenario = 'reservation', error = '', view = 'nodes', selectedNode = '';
  let contextId = '', selectedTopic = '';
  const roundOf = run => run?.specReview?.rounds?.find(round => round.id === run.specReview.currentRoundId);

  function render() {
    const { run, busy, canEdit = true, modelReview } = getState();
    const round = roundOf(run);
    const current = !!round && round.binding.specRevision === run?.specRevision && !run?.sourceSuperseded;
    container.hidden = !run?.spec?.requirements?.length || run?.workflowVersion !== 2 || !!run?.automaticDelivery || (!round && run.status !== 'awaiting_spec');
    if (container.hidden) return;
    const pending = pendingRun === run.id;
    const applying = Boolean(pendingRun);
    const nextContext = `${run.id}/${round?.id ?? ''}`;
    if (nextContext !== contextId) {
      contextId = nextContext;
      selectedNode = '';
      selectedTopic = '';
      view = 'nodes';
      if (!pending) error = '';
    }
    const activeNode = round?.nodes.find(node => node.status !== 'passed')?.id ?? (round ? 'confirmation' : 'baseline');
    const currentNode = selectedNode || activeNode;
    const next = JSON.stringify([run.id, run.specRevision, run.status, round, pending, applying, busy, canEdit, modelReview, error, view, currentNode, selectedTopic]);
    if (signature === next) return;
    signature = next;
    const active = container.contains(document.activeElement) ? document.activeElement?.dataset : null;
    const focusKey = active?.meeting ? [active.meeting, active.node, active.view, active.clause].join('/') : null;
    const open = new Set([...container.querySelectorAll('[data-meeting-detail][open]')].map(element => element.dataset.meetingDetail));
    const phase = phases.find(item => item.id === currentNode) ?? phases[0];
    const node = round?.nodes.find(item => item.id === currentNode);
    const availableViews = round?.discussion ? [views[0], ...discussionViews, ...views.slice(1)] : views;
    const canRevise = current && canEdit && !busy && !pending && round.status === 'blocked';
    const phasePanel = view === 'features' ? featureEvidence(round) : view === 'gates' ? gateEvidence(round)
      : view === 'discussion' && round?.discussion ? discussionEvidence(round, selectedTopic)
      : view === 'routing' && round?.discussion ? routingEvidence(round, canRevise) : `
      <div class="sm-work"><section class="sm-professions"><h4>并行专业席位</h4>${seatLanes(round)}${proposalEvidence(round)}</section>
        ${nodeEvidence(node, phase, round)}</div>${issueEvidence(round)}`;
    const model = isModelRound(round);
    const roundStatus = current ? round.confirmation ? '本版规格与阶段清单已联合确认' : phaseLabel(round.status) : '规格已变化，旧评审失效';
    container.innerHTML = `<div class="sm-flow">
      <header class="sm-header"><div><h3>多 Agent 规格评审</h3><p>从需求条款到设计规格，保留同版本的决议、Review 与放行依据。</p></div>
        ${round ? `<div class="sm-header-state"><span class="sm-chip" data-tone="${escape(current ? round.confirmation ? 'passed' : round.status : 'superseded')}">${escape(roundStatus)}</span>
          <small>${model ? '模型评审' : '离线夹具'} · 第 ${round.number} 轮</small></div>` : ''}
      </header>
      ${reviewStart({ run, pending: applying, busy, canEdit, modelReview, current, scenario })}
      ${!model ? '<p class="sm-fixture-note">离线夹具用于核对流程和证据，业务规则仍需结合需求人工确认。</p>' : ''}
      ${stageMap(round, activeNode, currentNode, pending)}
      ${reviewActions({ round, current, run, busy, pending: applying, canEdit, modelReview })}
      <div class="sm-views" role="group" aria-label="评审视图">
        ${availableViews.map(option => `<button type="button" data-meeting="view" data-view="${option.id}" aria-pressed="${view === option.id}" aria-controls="spec-meeting-content">${option.label}</button>`).join('')}
      </div>
      <div id="spec-meeting-content" class="sm-content">${phasePanel}</div>
      ${round ? `<footer class="sm-footer">
        <p class="sm-versions"><span>规格 <code title="${escape(round.binding.specRevision)}">${escape(short(round.binding.specRevision))}</code></span>
          <span>联合包 <code title="${escape(round.bundleRevision)}">${escape(short(round.bundleRevision))}</code></span>${requestUsage(round)}
        </p>
        <div><button type="button" class="text-button" data-meeting="design-spec">查看设计规格</button>
          <button type="button" class="text-button" data-meeting="minutes">查看完整会议纪要与历史</button>
          <button type="button" class="text-button" data-meeting="checklist">查看阶段清单</button></div>
        ${round.confirmation ? `<p>联合确认时间 ${escape(round.confirmation.at)} · ${escape(round.confirmation.feedback || '用户确认当前规格、会议纪要及阶段清单')}</p>` : ''}
      </footer>` : ''}
      ${error ? `<p class="inline-error" role="alert">${escape(error)}</p>` : ''}
    </div>`;

    for (const details of container.querySelectorAll('[data-meeting-detail]')) {
      if (open.has(details.dataset.meetingDetail)) details.open = true;
    }
    if (focusKey) [...container.querySelectorAll('[data-meeting]')].find(element => {
      const key = element.dataset;
      return [key.meeting, key.node, key.view, key.clause].join('/') === focusKey;
    })?.focus({ preventScroll: true });
  }

  container.addEventListener('change', event => {
    if (event.target.dataset.meeting === 'scenario') scenario = event.target.value;
    if (event.target.dataset.meeting === 'topic') {
      selectedTopic = event.target.value;
      render();
    }
  });

  container.addEventListener('click', async event => {
    const button = event.target.closest('button[data-meeting]');
    if (!button) return;
    const action = button.dataset.meeting;
    if (action === 'node') {
      selectedNode = button.dataset.node;
      view = 'nodes';
      render();
      return;
    }
    if (action === 'view') {
      view = button.dataset.view;
      render();
      return;
    }
    if (action === 'issues') { inspectIssue(); return; }
    if (action === 'revise-clause') { reviseClause(button.dataset.clause); return; }
    const artifact = { 'design-spec': 'spec.md', minutes: 'spec-review-minutes.json', checklist: 'stage-review-checklist.json' }[action];
    if (artifact) {
      showArtifact(artifact);
      return;
    }

    const context = getState();
    const id = context.run?.id;
    if (!id || pendingRun || context.busy || context.canEdit === false || !['start', 'start-model', 'continue'].includes(action)) return;
    if (action === 'start-model' && !context.modelReview?.available) return;
    pendingRun = id;
    error = '';
    selectedNode = '';
    view = 'nodes';
    render();
    try {
      if (action !== 'continue') {
        await submit('start_spec_meeting', { revision: context.run.specRevision, scenario: action === 'start-model' ? 'model_review' : scenario });
      }
      for (let step = 0; step < 18; step++) {
        const latest = getState().run;
        const current = roundOf(latest);
        if (latest?.id !== id || !current || !['in_progress', 'waiting'].includes(current.status)) break;
        await submit('advance_spec_meeting', { revision: latest.specRevision, roundId: current.id });
        if (roundOf(getState().run)?.status === 'waiting') break;
      }
    } catch (failure) {
      if (getState().run?.id === id) error = failure.message;
    } finally {
      pendingRun = '';
      render();
    }
  });

  return { render };
}
