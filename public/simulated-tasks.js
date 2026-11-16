const escape = value => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const SIM_STATUS = { pending: '待开始', ready: '就绪', running: '进行中', awaiting_confirmation: '待人工确认',
  completed: '模拟完成', failed: '失败', blocked: '阻塞', paused: '已暂停', interrupted: '已中断，需核对' };

export function createSimulatedTasks({ api, getContext, onUpdate, onError }) {
  let host, contextKey = '', runs = [], selectedId = '', canStart = false, reason = '', timer, busy = false, requestSequence = 0;
  const draft = { concurrency: '2', durationMs: '1200', failOnceIds: '', confirmationIds: '', reason: '' };
  const selection = () => runs.find(run => run.id === selectedId) ?? null;
  const base = context => `/api/projects/${encodeURIComponent(context.projectId)}/runs/${encodeURIComponent(context.runId)}/simulations`;
  function render() {
    if (!host) return;
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const focusField = focused?.dataset.simField;
    const selectionStart = focused?.selectionStart, selectionEnd = focused?.selectionEnd;
    const context = getContext(); host.hidden = !context.projectId || !context.runId;
    if (host.hidden) return;
    const run = selection(), editable = run && context.current && run.planRevision === context.planRevision;
    host.innerHTML = `<h3>开发任务模拟编排</h3><p>规划确认后的独立运行。所有状态由后端保存；模拟完成不代表真实编码、测试通过或软件验收，不开放源码交付。</p>
      <div class="simulation-options"><label>并发上限 <input data-sim-field="concurrency" aria-label="模拟并发上限" type="number" min="1" max="8" value="${escape(draft.concurrency)}"></label>
      <label>模拟时长（毫秒） <input data-sim-field="durationMs" aria-label="模拟时长" type="number" min="0" max="10000" value="${escape(draft.durationMs)}"></label>
      <label>首次失败任务 ID <input data-sim-field="failOnceIds" aria-label="首次失败任务 ID" placeholder="例如 B，多个用逗号分隔" value="${escape(draft.failOnceIds)}"></label>
      <label>人工确认任务 ID <input data-sim-field="confirmationIds" aria-label="人工确认任务 ID" placeholder="例如 D，多个用逗号分隔" value="${escape(draft.confirmationIds)}"></label></div>
      <button class="button button-primary" data-simulation-action="start" ${!canStart || busy ? 'disabled' : ''}>启动模拟编排</button>
      <p role="status">${escape(reason || '当前计划已确认，可创建新的模拟运行。')}</p>
      ${runs.length ? `<label>模拟运行历史 <select id="simulation-select" aria-label="模拟运行历史">${runs.map(item => `<option value="${escape(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${escape(item.createdAt)} · 计划v${item.planVersion} · ${escape(SIM_STATUS[item.status] || item.status)} · ${escape(item.id.slice(0, 8))}</option>`).join('')}</select></label>` : '<p>尚未创建模拟运行，开发任务仍为待实施计划。</p>'}
      ${run ? `<p><strong>模拟运行：${escape(SIM_STATUS[run.status] || run.status)}</strong> / 并发 ${run.concurrency} / 需求 ${escape(run.sourceRevision.slice(0, 8))} / 计划 ${escape(run.planRevision.slice(0, 8))}${editable ? '' : ' / 旧计划历史，只读'}</p>
      <div class="simulation-actions">${editable && ['running', 'awaiting_confirmation'].includes(run.status) ? '<button class="button button-outline" data-simulation-action="pause">阶段边界暂停</button>' : ''}
      ${editable && ['paused', 'interrupted'].includes(run.status) ? '<button class="button button-outline" data-simulation-action="resume">继续模拟</button>' : ''}
      <a href="${base(context)}/${encodeURIComponent(run.id)}/download" download>导出模拟记录</a></div>
      <label>人工确认依据（仅用于模拟结果）<textarea data-sim-field="reason" aria-label="模拟人工确认依据" maxlength="5000" rows="2">${escape(draft.reason)}</textarea></label>
      <details><summary>模拟运行事件（${run.events.length}）</summary><ol>${run.events.map(event => `<li>${escape(event.at)} ${escape(event.message)}</li>`).join('')}</ol></details>` : ''}`;
    host.querySelectorAll('button').forEach(button => { if (busy) button.disabled = true; });
    if (focusField) {
      const next = host.querySelector(`[data-sim-field="${focusField}"]`); next?.focus({ preventScroll: true });
      if (next && selectionStart !== null && selectionStart !== undefined && next.type !== 'number') next.setSelectionRange(selectionStart, selectionEnd);
    } else if (focused?.id === 'simulation-select') host.querySelector('#simulation-select')?.focus({ preventScroll: true });
  }
  async function refresh() {
    const request = ++requestSequence;
    clearTimeout(timer);
    const context = getContext(), key = JSON.stringify(context);
    if (key !== contextKey) { contextKey = key; runs = []; selectedId = ''; render(); onUpdate(); }
    if (!context.projectId || !context.runId) return;
    try {
      const data = await api(base(context));
      if (request !== requestSequence || key !== JSON.stringify(getContext())) return;
      const previous = JSON.stringify({ runs, canStart, reason, selectedId });
      runs = data.runs; canStart = data.canStart; reason = data.reason;
      if (!runs.some(run => run.id === selectedId)) {
        try { selectedId = sessionStorage.getItem(`taskflow-simulation:${context.projectId}/${context.runId}`) ?? ''; } catch { /* optional preference */ }
        if (!runs.some(run => run.id === selectedId)) selectedId = [...runs].reverse().find(run => run.planRevision === context.planRevision)?.id ?? runs.at(-1)?.id ?? '';
      }
      if (previous !== JSON.stringify({ runs, canStart, reason, selectedId })) { render(); onUpdate(); }
    } catch (error) { if (request === requestSequence && key === JSON.stringify(getContext())) { canStart = false; reason = `模拟状态读取失败：${error.message}`; render(); } }
    finally { if (request === requestSequence && key === JSON.stringify(getContext())) timer = setTimeout(refresh, 650); }
  }
  async function action(button) {
    if (busy) return;
    const context = getContext(), key = JSON.stringify(context), run = selection();
    const action = button.dataset.simulationAction; busy = true; render();
    try {
      const split = value => value.split(/[,，\s]+/u).filter(Boolean);
      const body = action === 'start' ? { planRevision: context.planRevision, concurrency: Number(draft.concurrency), durationMs: Number(draft.durationMs),
        failOnceIds: split(draft.failOnceIds), confirmationIds: split(draft.confirmationIds) } : { action,
        ...(button.dataset.simTask ? { taskId: button.dataset.simTask } : {}),
        ...(action === 'confirm' ? { reason: draft.reason, attempt: Number(button.dataset.simAttempt) } : {}) };
      const data = await api(action === 'start' ? base(context) : `${base(context)}/${encodeURIComponent(run.id)}/action`, { method: 'POST', body: JSON.stringify(body) });
      if (key !== JSON.stringify(getContext())) return;
      selectedId = data.simulation.id;
      try { sessionStorage.setItem(`taskflow-simulation:${context.projectId}/${context.runId}`, selectedId); } catch { /* optional preference */ }
      await refresh();
    } catch (error) { if (key === JSON.stringify(getContext())) onError(error); }
    finally { busy = false; render(); }
  }
  function detail(taskId) {
    const run = selection(), task = run?.tasks.find(item => item.id === taskId); if (!task) return '';
    const editable = getContext().current && run.planRevision === getContext().planRevision;
    return `<section class="simulation-task-detail"><h4>模拟执行状态：${escape(SIM_STATUS[task.status])}</h4><p>${escape(task.reason)}</p>
      <p>当前尝试：${task.attempts.length} / ${task.requiresConfirmation ? '需要人工确认' : '自动发布模拟结果'}</p>
      ${editable && task.status === 'failed' ? `<button class="button button-outline" data-simulation-action="retry" data-sim-task="${escape(task.id)}">重试此模拟任务</button>` : ''}
      ${editable && task.status === 'awaiting_confirmation' ? `<button class="button button-primary" data-simulation-action="confirm" data-sim-task="${escape(task.id)}" data-sim-attempt="${task.attempts.length}">确认此模拟结果</button><p>请先在上方填写人工确认依据。</p>` : ''}
      <h4>执行记录</h4>${task.attempts.length ? task.attempts.map(attempt => `<p>第 ${attempt.number} 次 / ${escape(SIM_STATUS[attempt.status] || attempt.status)}<br>${escape(attempt.startedAt)} → ${escape(attempt.finishedAt || '进行中')}<br>${escape(attempt.summary)}${attempt.confirmation ? `<br>人工依据：${escape(attempt.confirmation.reason)} / ${escape(attempt.confirmation.at)}` : ''}</p>`).join('') : '<p>尚未派发。</p>'}
      <h4>状态历史</h4><ol>${task.history.map(event => `<li>${escape(event.at)} ${escape(SIM_STATUS[event.status])}：${escape(event.reason)}</li>`).join('')}</ol><p>仅模拟结果，不是软件验收。</p></section>`;
  }
  function mount(element) {
    host = element;
    host.addEventListener('input', event => { if (event.target.dataset.simField) draft[event.target.dataset.simField] = event.target.value; });
    host.addEventListener('change', event => { if (event.target.id === 'simulation-select') {
      selectedId = event.target.value; const context = getContext();
      try { sessionStorage.setItem(`taskflow-simulation:${context.projectId}/${context.runId}`, selectedId); } catch { /* optional preference */ }
      render(); onUpdate();
    } });
    document.addEventListener('click', event => { const button = event.target.closest('[data-simulation-action]'); if (button) void action(button); });
    render();
  }
  return { mount, refresh, selection, detail };
}
