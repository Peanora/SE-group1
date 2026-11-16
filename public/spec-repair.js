const escape = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

// A failed specification is not an execution result. This editor only collects
// user-supplied source data; it never approves the specification or calls a model
// without an explicit "save and retry" action.
export function createSpecRepair({ container, getState, submit, refresh, toast, openSourceEditor }) {
  const drafts = new Map();
  let viewKey = '';
  let current = null;
  let pending = false;
  const $$ = (selector) => [...container.querySelectorAll(selector)];
  const storageKey = (run, attemptId) => `taskflow-spec-repair:${run.id}:${attemptId || 'none'}`;

  function persist(draft) {
    try { sessionStorage.setItem(draft.key, JSON.stringify(draft)); } catch { /* Keep the in-memory draft. */ }
  }
  function discard(draft) {
    drafts.delete(draft.key);
    try { sessionStorage.removeItem(draft.key); } catch { /* Browser storage can be unavailable. */ }
  }
  function getDraft(run, failure) {
    const key = storageKey(run, failure.attemptId);
    let draft = drafts.get(key);
    if (!draft) {
      try { draft = JSON.parse(sessionStorage.getItem(key)); } catch { /* Start from the saved draft. */ }
    }
    if (!draft || draft.key !== key || draft.sourceRevision !== run.sourceRevision) {
      const saved = failure.supplement?.saved && typeof failure.supplement.saved === 'object' ? failure.supplement.saved : {};
      draft = { key, sourceRevision: run.sourceRevision, answers: Object.fromEntries((failure.supplement?.fields || []).map(field => [field.id, typeof saved[field.id] === 'string' ? saved[field.id] : ''])), error: '' };
    }
    for (const field of failure.supplement?.fields || []) if (typeof draft.answers[field.id] !== 'string') draft.answers[field.id] = '';
    drafts.set(key, draft);
    return draft;
  }
  function validState() {
    const { run, busy } = getState();
    const failure = run?.specificationFailure, supplement = failure?.supplement;
    return { run, busy, failure, supplement, visible: Boolean(run && run.workflowVersion === 2 && run.status === 'failed' && supplement?.available && !run.sourceSuperseded) };
  }
  function sync() {
    if (!current || container.hidden) return;
    const { busy, supplement } = validState();
    const lock = pending || busy;
    const hasAnswer = Boolean(supplement && (supplement.fields || []).some(field => String(current.answers[field.id] || '').trim()));
    $$('[data-spec-repair-action="save"]').forEach(button => { button.disabled = lock || !hasAnswer; });
    $$('[data-spec-repair-action="retry"]').forEach(button => { button.disabled = lock || !hasAnswer || !supplement?.canRetry; });
    $$('[data-spec-repair-action="source"]').forEach(button => { button.disabled = lock; });
    $$('input, textarea').forEach(element => { element.disabled = lock; });
    const status = container.querySelector('#spec-repair-status');
    if (status && supplement) status.textContent = !hasAnswer ? '请至少填写一项补充信息。' : !supplement.canRetry ? '本次规格调用次数已用尽；可以保存补充信息，但不能再调用模型。' : pending ? '正在处理…' : '可以仅保存补充信息，也可以保存后重新整理规格。重新整理会新增一次模型请求。';
    const error = container.querySelector('#spec-repair-error');
    if (error) { error.textContent = current.error || ''; error.hidden = !current.error; }
  }
  function field(field) {
    const id = `spec-repair-${field.id}`;
    return `<label class="review-field" for="${escape(id)}"><span>${escape(field.label)}</span><textarea id="${escape(id)}" rows="3" maxlength="${Number(field.maxLength) || 4000}" data-spec-repair-field="${escape(field.id)}" placeholder="${escape(field.placeholder || '')}">${escape(current.answers[field.id] || '')}</textarea><small>${escape(field.question)}</small></label>`;
  }
  function render() {
    const { run, failure, supplement, visible } = validState();
    container.hidden = !visible;
    if (!visible) { viewKey = ''; current = null; return; }
    const draft = getDraft(run, failure);
    const signature = `${run.id}:${failure.attemptId}:${(supplement.fields || []).map(field => field.id).join(',')}:${supplement.canRetry}:${run.sourceRevision}`;
    if (signature === viewKey) { current = draft; sync(); return; }
    viewKey = signature; current = draft;
    const position = failure.requirementIndex ? `第 ${failure.requirementIndex} 条需求` : '规格整体';
    const positionTitle = failure.requirementTitle ? `（${failure.requirementTitle}）` : '';
    container.innerHTML = `<div class="spec-repair-intro"><span class="spec-repair-check" aria-hidden="true">!</span><div><h3 id="spec-repair-heading">规格整理未完成：定位问题并补充信息</h3><p>${escape(failure.message)}</p>${failure.detail && failure.detail !== failure.message ? `<p>${escape(failure.detail)}</p>` : ''}<p>这不是软件已经执行或验收的结论，也没有生成可确认的规格。原始需求和已保存回答都不会丢失。</p></div></div>
      <dl class="spec-repair-meta"><div><dt>问题类型</dt><dd>${escape(failure.label || '规格未通过校验')}</dd></div><div><dt>位置</dt><dd>${escape(position)}${escape(positionTitle)}</dd></div><div><dt>剩余调用</dt><dd>${Number.isSafeInteger(failure.remaining) ? `${failure.remaining} 次` : '未知'}</dd></div></dl>
      <div class="review-editor spec-repair-editor"><p class="review-help">补充内容会作为新的需求来源保存，不会覆盖原始需求。重新整理后仍需你单独确认规格；确认前不会生成开发计划。</p><div class="spec-repair-fields">${(supplement.fields || []).map(field).join('')}</div><p id="spec-repair-status" class="review-help" aria-live="polite"></p><p id="spec-repair-error" class="inline-error" role="alert" hidden></p><div class="spec-repair-actions"><button type="button" class="button button-outline" data-spec-repair-action="save">保存补充信息（不调用模型）</button><button type="button" class="button button-primary" data-spec-repair-action="retry">保存并重新整理规格（消耗 1 次）</button><button type="button" class="text-button" data-spec-repair-action="source">改为修改原始需求</button></div></div>`;
    sync();
  }
  async function act(action) {
    const { run, busy, supplement } = validState();
    const draft = current;
    if (!run || !draft || busy || pending || !supplement) return;
    if (action === 'source') { openSourceEditor?.(); return; }
    const answers = Object.fromEntries((supplement.fields || []).map(field => [field.id, String(draft.answers[field.id] || '').trim()]).filter(([, answer]) => answer));
    if (!Object.keys(answers).length) {
      draft.error = '请至少填写一项补充信息，再保存或重新整理。'; persist(draft); sync();
      container.querySelector('[data-spec-repair-field]')?.focus(); return;
    }
    if (action === 'retry' && !supplement.canRetry) return;
    draft.error = ''; pending = true; sync();
    try {
      await submit('supplement_spec', { revision: run.sourceRevision, answers, retry: action === 'retry' });
      discard(draft);
      toast(action === 'retry' ? '补充信息已保存，正在重新整理规格' : '补充信息已保存；本次未调用模型');
      try { await refresh(); } catch { /* The next poll reads the saved run. */ }
    } catch (error) {
      draft.error = error.message || '补充信息未保存，请稍后重试。'; persist(draft);
      try { await refresh(); } catch { /* Keep the supplied text for a retry. */ }
    } finally { pending = false; viewKey = ''; sync(); }
  }
  container.addEventListener('input', (event) => {
    const id = event.target.dataset.specRepairField;
    if (!id || !current) return;
    current.answers[id] = event.target.value;
    persist(current); sync();
  });
  container.addEventListener('click', (event) => {
    const button = event.target.closest('[data-spec-repair-action]');
    if (button && !button.disabled) void act(button.dataset.specRepairAction);
  });
  return { render };
}
