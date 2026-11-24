const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const status = { pending: '等待前置', passed: '通过', awaiting_review: '等待独立 Review', awaiting_user: '等待业务裁决',
  rejected: '退回修改', in_progress: '评审进行中', waiting: '等待有效证据', blocked: '有阻塞异议', awaiting_decision: '等待用户裁决',
  awaiting_confirmation: '规格和清单待联合确认', superseded: '旧版本，仅保留历史' };
export function createSpecificationMeeting({ container, getState, submit, inspectIssue, showArtifact }) {
  let pending = false, signature = '', scenario = 'reservation', error = '';
  function roundOf(run) { return run?.specReview?.rounds.find(round => round.id === run.specReview.currentRoundId); }
  function render() {
    const { run, busy, canEdit = true } = getState();
    const round = roundOf(run), current = round?.binding.specRevision === run?.specRevision && !run?.sourceSuperseded;
    container.hidden = !run?.spec?.requirements?.length || run?.workflowVersion !== 2 || !!run?.automaticDelivery || (!round && run.status !== 'awaiting_spec');
    if (container.hidden) return;
    const next = JSON.stringify([run.id, run.specRevision, run.status, round, pending, busy, canEdit, error]);
    if (signature === next) return; signature = next;
    const focused = container.contains(document.activeElement) ? document.activeElement?.dataset.meeting : null;
    container.innerHTML = `<h3>多 Agent 规格评审</h3><p>首版使用离线角色模型夹具，不调用付费模型。启用后须通过各节点的主责自测和同版本独立 Review，并联合确认规格、会议纪要与阶段清单，才能进入工程规划。离线通过不代表真实模型审阅、代码测试或软件验收。</p>
      ${!round || !current ? `<label>离线场景 <select data-meeting="scenario" aria-label="规格评审离线场景"><option value="reservation" ${scenario === 'reservation' ? 'selected' : ''}>业务评审与预约取消裁决</option><option value="reject_review" ${scenario === 'reject_review' ? 'selected' : ''}>模拟自测通过但独立 Review 退回</option><option value="late_review" ${scenario === 'late_review' ? 'selected' : ''}>模拟旧版本 Review 迟到</option></select></label>
      <button class="button button-primary" data-meeting="start" ${busy || pending || !canEdit || run.status !== 'awaiting_spec' ? 'disabled' : ''}>启用本版离线评审</button>` : ''}
      ${round ? `<p><strong>${escape(current ? round.confirmation ? '本版规格与阶段清单已联合确认' : status[round.status] ?? round.status : '规格已变化，旧评审失效')}</strong> / 第${round.number}轮 / 规格 ${escape(round.binding.specRevision.slice(0, 10))} / 联合包 ${escape(round.bundleRevision?.slice(0, 10) ?? '尚未就绪')}</p>
      <ol class="spec-meeting-nodes">${round.nodes.map(node => `<li><strong>${escape(node.title)}：${escape(status[node.status] ?? node.status)}</strong>
        <p>主责 ${escape(round.seats[node.owner] ?? node.owner)} / 自测 ${node.selfTest ? node.selfTest.passed ? '通过' : '未通过' : '未完成'} / 独立意见 ${node.reviews.length} / 尝试 ${node.attempts.length}</p>
        ${node.attempts.at(-1)?.reason ? `<p>${escape(node.attempts.at(-1).reason)}</p>` : ''}
        ${node.blocking.map(f => `<p class="inline-error">${escape(f.location)}：${escape(f.impact)}；复核条件：${escape(f.condition)}</p>`).join('')}
        ${node.attempts.flatMap(a => a.ignored ?? []).map(item => `<p>${escape(item.role)}：${escape(item.reason)}</p>`).join('')}
        <details><summary>同版本产物、自测及角色 Review 证据</summary><pre>${escape(JSON.stringify({ artifact: node.artifact, selfTest: node.selfTest, reviews: node.reviews, attempts: node.attempts }, null, 2))}</pre></details></li>`).join('')}</ol>
      ${current && run.status === 'awaiting_spec' ? `<div class="simulation-actions">${['in_progress', 'waiting'].includes(round.status) ? `<button class="button button-primary" data-meeting="continue" ${busy || pending || !canEdit ? 'disabled' : ''}>继续离线评审</button>` : ''}
        ${round.status === 'awaiting_decision' ? '<button class="button button-primary" data-meeting="issues">查看问题并裁决</button>' : ''}
        ${round.status === 'blocked' ? '<p>须在下方规格编辑器实际修订并保存，再为新版本启用评审；不能原样重试洗掉阻塞。</p>' : ''}
        ${round.status === 'awaiting_confirmation' ? '<p>请核对本版规格、纪要和阶段清单，然后使用下方联合确认按钮。</p>' : ''}</div>` : ''}
      <details><summary>需求覆盖与专业席位</summary><p>首版对每条Web需求保守保留全部专业维度；业务域按需求模块分席，不因关键词漏掉权限或数据维度。</p><ul>${round.coverage.map(row => `<li>${escape(row.clause)}<br>主责 ${escape(round.seats[row.owner])} / 独立审阅 ${escape(round.seats[row.reviewer])}<br>专业：${row.specialists.map(role => escape(round.seats[role] ?? role)).join('、')}<br>可观察：${row.observable.map(escape).join('；')}</li>`).join('')}</ul></details>
      <details><summary>关联议题、用户裁决和非阻塞保留意见</summary><pre>${escape(JSON.stringify({ issues: round.issues, decisions: round.decisions, reservations: round.proposals.flatMap(p => p.reservations ?? []) }, null, 2))}</pre></details>
      <details><summary>阶段验收与 Review 清单（定义，不代表已执行）</summary>${(round.checklist ?? []).map(row => `<h4>${escape(row.title)}</h4><p>主责：${escape(row.owner)} / 必审：${row.requiredReviewers.map(escape).join('、')}</p><p>${escape(row.condition)}</p><p>证据：${escape(row.requiredEvidence)}</p><p>依赖：${row.dependsOn.map(escape).join('、')}</p><ul>${row.rules.map(rule => `<li>${escape(rule.specClause)} → ${escape(rule.verificationNode)} → ${rule.observable.map(escape).join('；')}</li>`).join('')}</ul>`).join('') || '<p>前置节点通过后生成。</p>'}</details>
      <p>${round.confirmation ? `本版联合确认时间：${escape(round.confirmation.at)}；依据：${escape(round.confirmation.feedback || '用户确认当前规格、会议纪要及阶段清单')}` : '尚无本版用户联合确认。'}</p>
      <button class="text-button" data-meeting="minutes">查看完整会议纪要与历史</button> <button class="text-button" data-meeting="checklist">查看阶段清单</button>` : ''}
      ${error ? `<p class="inline-error" role="alert">${escape(error)}</p>` : ''}`;
    if (focused) container.querySelector(`[data-meeting="${focused}"]`)?.focus({ preventScroll: true });
  }
  container.addEventListener('change', event => { if (event.target.dataset.meeting === 'scenario') scenario = event.target.value; });
  container.addEventListener('click', async event => {
    const button = event.target.closest('[data-meeting]'); if (!button || button.tagName !== 'BUTTON') return;
    const action = button.dataset.meeting;
    if (action === 'issues') { inspectIssue(); return; }
    if (action === 'minutes' || action === 'checklist') { showArtifact(action === 'minutes' ? 'spec-review-minutes.json' : 'stage-review-checklist.json'); return; }
    const context = getState(), id = context.run?.id;
    if (pending || context.busy || !context.canEdit) return;
    pending = true; error = ''; render();
    try {
      if (action === 'start') await submit('start_spec_meeting', { revision: context.run.specRevision, scenario });
      for (let step = 0; step < 18; step++) {
        const latest = getState().run, round = roundOf(latest);
        if (latest?.id !== id || !round || !['in_progress', 'waiting'].includes(round.status)) break;
        await submit('advance_spec_meeting', { revision: latest.specRevision, roundId: round.id });
        const updated = roundOf(getState().run);
        if (updated?.status === 'waiting') break;
      }
    } catch (failure) { if (getState().run?.id === id) error = failure.message; }
    finally { pending = false; render(); }
  });
  return { render };
}
