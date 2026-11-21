const VIEWS = ['plan', 'tasks', 'source', 'execution'];

// Views keep their actual DOM; changing views never recreates an input draft.
export function createWorkspaceLayout({ getContext, onViewChange = () => {}, isViewReady = () => true }) {
  // This controller owns restoration; native reload restoration must not race it.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const panels = new Map(VIEWS.map(view => [view, document.querySelector(`[data-workspace-panel="${view}"]`)]));
  const nav = document.querySelector('#workspace-nav');
  const tabs = [...nav.querySelectorAll('[data-workspace-view]')];
  const dialog = document.querySelector('#task-edit-dialog');
  const review = document.querySelector('#review-banner');
  const reviewHome = document.querySelector('#review-home');
  const editorHost = document.querySelector('#task-edit-host');
  let key = '', view = 'plan', previous = 'plan', saved = {}, editorReturn = null, restoreEditorFocus = true;
  let editorStatus = '';
  let persistFrame = null, pendingScroll = false;
  const storageKey = () => `taskflow.workspace:${key}`;

  function persist() {
    if (!key) return;
    saved = { ...saved, layout: 'document-v1', view, scroll: pendingScroll ? saved.scroll : { ...saved.scroll, [view]: { top: window.scrollY, left: window.scrollX } } };
    try { sessionStorage.setItem(storageKey(), JSON.stringify(saved)); } catch { /* Current drafts and navigation remain in memory. */ }
  }
  function read() {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey()));
      if (!value || typeof value !== 'object' || !VIEWS.includes(value.view)) return {};
      // Earlier builds stored panel-relative coordinates, not page coordinates.
      return value.layout === 'document-v1' ? value : { view: value.view };
    } catch { return {}; }
  }
  function restoreScroll() {
    if (!pendingScroll) return;
    const position = saved.scroll?.[view] || { top: 0, left: 0 };
    if (!Number.isFinite(position.top) || position.top < 0) { pendingScroll = false; return; }
    window.scrollTo({ top: position.top, left: Number.isFinite(position.left) ? position.left : 0, behavior: 'auto' });
    // Keep the saved coordinate until the asynchronous view has its final layout.
    if (isViewReady(view) && position.top <= document.documentElement.scrollHeight - window.innerHeight + 1) pendingScroll = false;
  }
  function paint() {
    for (const [name, panel] of panels) panel.hidden = name !== view;
    for (const tab of tabs) {
      const selected = tab.dataset.workspaceView === view;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    restoreScroll();
  }
  function show(next, { focus = false } = {}) {
    if (!VIEWS.includes(next) || !getContext().projectId) return false;
    if (dialog.open) closeEditor({ restoreFocus: false });
    if (next !== view) { persist(); previous = view; view = next; pendingScroll = true; }
    paint(); onViewChange(view);
    restoreScroll(); persist();
    if (focus) panels.get(view).focus({ preventScroll: true });
    return true;
  }
  function sync() {
    const context = getContext(), nextKey = context.projectId ? `${context.projectId}:${context.runId || 'new'}` : '';
    if (nextKey !== key) {
      persist(); closeEditor({ restoreFocus: false }); key = nextKey; saved = read();
      view = VIEWS.includes(saved.view) ? saved.view : 'plan'; previous = 'plan'; pendingScroll = true;
      document.querySelector('#workflow-details').open = true;
      paint(); onViewChange(view); restoreScroll();
    }
    const visible = Boolean(context.projectId);
    nav.hidden = !visible; document.querySelector('#workspace-context').hidden = !visible;
    document.querySelector('#workspace-panels').hidden = !visible;
    for (const tab of tabs) tab.disabled = !visible || context.busy === true;
    if (dialog.open && (context.runStatus === 'awaiting_spec' || context.runStatus === 'succeeded' && editorStatus !== 'succeeded' || context.historical)) {
      closeEditor({ restoreFocus: false });
      if (context.runStatus === 'awaiting_spec') show('plan');
    }
  }
  function openEditor({ returnTarget = '[data-edit-selected-task]' } = {}) {
    if (dialog.open) return;
    persist(); editorReturn = returnTarget; restoreEditorFocus = true; editorStatus = getContext().runStatus;
    editorHost.append(review); dialog.showModal();
  }
  function returnReview() {
    if (review.parentElement !== reviewHome) reviewHome.append(review);
    if (restoreEditorFocus && view === 'tasks') {
      const target = typeof editorReturn === 'string' ? document.querySelector(editorReturn) : editorReturn;
      if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
    }
    restoreEditorFocus = true; editorReturn = null;
  }
  function closeEditor({ restoreFocus = true } = {}) {
    restoreEditorFocus = restoreFocus;
    if (dialog.open) dialog.close();
    // Restore synchronously; native close dispatch can occur after a project switch.
    returnReview();
  }
  nav.addEventListener('click', event => {
    const tab = event.target.closest('[data-workspace-view]');
    if (tab && !tab.disabled) show(tab.dataset.workspaceView);
  });
  nav.addEventListener('keydown', event => {
    const index = tabs.indexOf(document.activeElement); if (index < 0) return;
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault(); show(tabs[next].dataset.workspaceView); tabs[next].focus({ preventScroll: true });
  });
  dialog.addEventListener('close', () => { if (!dialog.open) returnReview(); });
  dialog.querySelectorAll('[data-close-task-editor]').forEach(button => button.addEventListener('click', () => closeEditor()));
  document.querySelector('[data-workspace-back]')?.addEventListener('click', () => show(previous, { focus: true }));
  window.addEventListener('scroll', () => {
    if (persistFrame !== null) return;
    persistFrame = requestAnimationFrame(() => { persistFrame = null; persist(); });
  }, { passive: true });
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(event, () => { pendingScroll = false; }, { passive: true });
  new MutationObserver(() => { if (pendingScroll) restoreScroll(); }).observe(document.querySelector('#workspace-panels'), { childList: true, subtree: true });
  window.addEventListener('pagehide', persist);
  return { show, sync, openEditor, closeEditor, restore: restoreScroll, view: () => view };
}
