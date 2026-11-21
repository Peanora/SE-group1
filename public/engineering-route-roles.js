const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const contractFields = ['request', 'response'];
const routeDrafts = run => run.engineeringPlan.proposal.routes.map(({ id, roles, request, response }) => ({ id, roles: [...roles], request, response }));

/** Local drafts are data. Only the owner can save a version-bound permission change. */
export function createEngineeringRouteRoles({ getState, submit, refresh, toast, onChange = () => {} }) {
  const drafts = new Map(); let host = null, signature = '', pending = false, current = null;
  const keyFor = run => `taskflow-route-roles:${run.id}`;
  const persist = draft => { drafts.set(draft.key, draft); try { sessionStorage.setItem(draft.key, JSON.stringify(draft)); } catch {} };
  function context() {
    const state = getState(), run = state.run;
    if (!host || !run || run.sourceSuperseded || state.health?.engineeringRoleRevision?.available !== true || run.workflowVersion !== 2 || run.status !== 'awaiting_review' || !run.engineeringPlan?.proposal?.routes) return null;
    const canEdit = !state.health?.teamAccess?.enabled || state.actorRole === 'owner';
    const contractAvailable = state.health?.engineeringRouteContractRevision?.available === true;
    return { state, run, canEdit, contractAvailable };
  }
  function draftFor(run) {
    const key = keyFor(run); let draft = drafts.get(key);
    if (!draft) { try { draft = JSON.parse(sessionStorage.getItem(key)); } catch {} }
    if (!draft || draft.key !== key || !Array.isArray(draft.routes) || draft.routes.some(edit => !edit || typeof edit.id !== 'string' || !Array.isArray(edit.roles) || edit.roles.some(role => typeof role !== 'string')) || !draft.dirty && !draft.feedback && draft.revision !== run.planRevision) draft = { key, revision: run.planRevision, specRevision: run.specRevision,
      routes: routeDrafts(run), feedback: '', dirty: false, error: '' };
    drafts.set(key, draft); return draft;
  }
  function changes(run, draft, contractAvailable) {
    return draft.routes.flatMap(edit => {
      const route = run.engineeringPlan.proposal.routes.find(route => route.id === edit.id);
      if (!route) return [];
      const change = { id: edit.id };
      if (!same(route.roles, edit.roles)) change.roles = [...edit.roles];
      if (contractAvailable) for (const field of contractFields) {
        if (typeof edit[field] === 'string' && edit[field].trim() !== route[field].trim()) change[field] = edit[field];
      }
      return Object.keys(change).length > 1 ? [change] : [];
    });
  }
  function sync() {
    const ctx = context(); if (!ctx || !current) return;
    const { run, state, canEdit, contractAvailable } = ctx, stale = current.revision !== run.planRevision || current.specRevision !== run.specRevision;
    const locked = pending || state.busy || !canEdit || stale;
    host.querySelectorAll('input,textarea,button').forEach(element => { element.disabled = locked; });
    const reset = host.querySelector('[data-route-reset]'); reset.hidden = !stale && (canEdit || !current.dirty); reset.disabled = pending || state.busy;
    const edited = changes(run, current, contractAvailable).length;
    const save = host.querySelector('[data-route-save]'); save.disabled ||= !edited;
    const status = host.querySelector('[data-route-status]'); status.textContent = !canEdit ? '当前账号只读，接口约定由负责人修订。' : stale ? '计划已更新，原草稿仍保留；请载入最新版本后重新核对。' : edited ? `${edited} 个接口有未保存的修改。保存后还需重新确认计划。` : '本地修改不调用模型。保存会产生新计划版本，原确认失效。';
    const error = host.querySelector('[data-route-error]'); error.textContent = current.error || ''; error.hidden = !current.error;
  }
  function renderRoute(run, route, index, draft, contractAvailable) {
    const edit = draft.routes.find(item => item.id === route.id);
    const title = escape(route.method) + ' ' + escape(route.path);
    const roles = run.engineeringPlan.roleDefinitions.map(role =>
      `<label class="review-choice"><input type="checkbox" data-route-index="${index}" value="${escape(role.id)}" ${(edit?.roles || route.roles).includes(role.id) ? 'checked' : ''}><span>${escape(role.text)}</span></label>`).join('');
    const contract = contractAvailable ? contractFields.map(field =>
      `<label class="review-field"><span>${field === 'request' ? '请求约定' : '响应约定'}</span><textarea rows="2" maxlength="2000" data-route-contract-index="${index}" data-route-contract-field="${field}">${escape(typeof edit?.[field] === 'string' ? edit[field] : route[field])}</textarea></label>`).join('') : '';
    return `<details class="review-item"><summary><strong>${title}</strong></summary><fieldset class="review-choices"><legend>${title} 的允许角色</legend>${roles}</fieldset>${contract}</details>`;
  }
  function render() {
    const ctx = context(); if (!ctx) { if (host) host.innerHTML = ''; current = null; signature = ''; return; }
    const { run, canEdit, contractAvailable } = ctx, draft = canEdit ? draftFor(run) : { revision: run.planRevision, specRevision: run.specRevision, routes: routeDrafts(run), feedback: '', dirty: false, error: '' }; current = draft;
    const next = `${run.id}:${run.specRevision}:${run.planRevision}:${canEdit}:${contractAvailable}`;
    if (next !== signature) {
      signature = next;
      host.innerHTML = `<details class="review-context engineering-role-editor" ${draft.dirty || draft.error ? 'open' : ''}>
        <summary>${contractAvailable ? '修订接口约定与权限' : '修订接口权限'}</summary>
        ${run.engineeringPlan.proposal.routes.map((route, index) => renderRoute(run, route, index, draft, contractAvailable)).join('')}
        <label class="review-field"><span>修订说明（选填）</span><textarea data-route-feedback rows="2" maxlength="4000">${escape(draft.feedback)}</textarea></label>
        <p class="review-help" data-route-status aria-live="polite"></p><p class="inline-error" data-route-error role="alert" hidden></p>
        <button type="button" class="text-button" data-route-reset hidden>放弃本地草稿，载入最新版本</button>
        <button type="button" class="button button-outline" data-route-save>保存接口修订</button></details>`;
      host.addEventListener('input', input); host.addEventListener('click', click);
    }
    sync();
  }
  function input(event) {
    if (!current || event.target.disabled) return;
    const ctx = context(); if (!ctx?.canEdit) return;
    if (event.target.matches('[data-route-feedback]')) current.feedback = event.target.value;
    else if (event.target.matches('[data-route-index]')) {
      const index = Number(event.target.dataset.routeIndex), route = ctx.run.engineeringPlan.proposal.routes[index], edit = current.routes.find(edit => edit.id === route?.id);
      if (!edit) return;
      edit.roles = [...host.querySelectorAll('[data-route-index]')].filter(element => Number(element.dataset.routeIndex) === index && element.checked).map(element => element.value);
    } else if (ctx.contractAvailable && event.target.matches('[data-route-contract-field]')) {
      const { routeContractIndex, routeContractField } = event.target.dataset;
      const route = ctx.run.engineeringPlan.proposal.routes[Number(routeContractIndex)];
      const edit = current.routes.find(item => item.id === route?.id);
      if (!edit || !contractFields.includes(routeContractField)) return;
      edit[routeContractField] = event.target.value;
    } else return;
    current.dirty = changes(ctx.run, current, ctx.contractAvailable).length > 0;
    current.error = ''; persist(current); sync(); onChange();
  }
  async function click(event) {
    const reset = event.target.closest('[data-route-reset]'), save = event.target.closest('[data-route-save]');
    if (reset && !reset.disabled && current) { drafts.delete(current.key); try { sessionStorage.removeItem(current.key); } catch {} signature = ''; render(); onChange(); return; }
    if (!save || save.disabled || pending || !current) return;
    const ctx = context(); if (!ctx || !ctx.canEdit) return;
    const draft = current, edits = changes(ctx.run, draft, ctx.contractAvailable); if (!edits.length) return;
    const action = edits.some(edit => contractFields.some(field => Object.hasOwn(edit, field))) ? 'revise_route_contracts' : 'revise_route_roles';
    pending = true; draft.error = ''; sync(); onChange();
    try {
      await submit({ action, revision: draft.revision, changes: edits, feedback: draft.feedback });
      drafts.delete(draft.key); try { sessionStorage.removeItem(draft.key); } catch {} signature = ''; toast('接口修订已保存，请重新审阅并确认计划。');
    } catch (error) { draft.error = error.message || '保存结果尚未确认，请刷新核对。'; persist(draft); try { await refresh(); } catch {} }
    finally { pending = false; render(); onChange(); }
  }
  return {
    mount(element) { if (host !== element) { host?.removeEventListener('input', input); host?.removeEventListener('click', click); host = element; signature = ''; } render(); },
    render,
    hasDirty() {
      const ctx = context();
      const draft = ctx?.canEdit && drafts.get(keyFor(ctx.run));
      return !!draft && changes(ctx.run, draft, ctx.contractAvailable).length > 0;
    },
    captureFocus() {
      const element = document.activeElement;
      if (!host?.contains(element)) return null;
      if (element.matches('[data-route-feedback]')) return { runId: getState().run?.id, feedback: true, start: element.selectionStart, end: element.selectionEnd };
      if (element.matches('[data-route-contract-field]')) return { runId: getState().run?.id, contractField: element.dataset.routeContractField, index: element.dataset.routeContractIndex, start: element.selectionStart, end: element.selectionEnd };
      if (element.matches('[data-route-index]')) return { runId: getState().run?.id, index: element.dataset.routeIndex, role: element.value };
      return null;
    },
    restoreFocus(snapshot) {
      if (!snapshot || snapshot.runId !== getState().run?.id || !host) return;
      let element;
      if (snapshot.feedback) element = host.querySelector('[data-route-feedback]');
      else if (snapshot.contractField) element = [...host.querySelectorAll('[data-route-contract-field]')].find(input => input.dataset.routeContractIndex === snapshot.index && input.dataset.routeContractField === snapshot.contractField);
      else element = [...host.querySelectorAll('[data-route-index]')].find(input => input.dataset.routeIndex === snapshot.index && input.value === snapshot.role);
      if (element && !element.disabled) { for (let node = element.parentElement; node && node !== host; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true; element.focus({ preventScroll: true }); if (snapshot.feedback || snapshot.contractField) element.setSelectionRange(snapshot.start, snapshot.end); }
    },
  };
}
