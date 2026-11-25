const SOURCE_LABELS = {
  planning: '规划过程', review: '规格与计划', tasks: '开发任务',
  simulation: '模拟编排', source: '需求变更', execution: '代码执行', planned: '按规划开发', release: '本机版本', verification: '测试提案', connection: '连接状态',
};
const contextKey = context => JSON.stringify([context?.projectId || '', context?.runId || '']);
const messageOf = value => {
  const message = String(value?.message ?? value ?? '操作未完成，请稍后重试。');
  return /^(?:Failed to fetch|Load failed|NetworkError(?: when attempting to fetch resource)?\.?)/i.test(message)
    ? '暂时无法连接本地服务，操作结果尚未确认。请先检查服务并刷新核对，填写内容已保留。' : message;
};

/** Display feedback without moving the user's work, selection or keyboard focus. */
export function createWorkspaceNotices({ errorBanner, errorText, dismissButton, toast, getContext, locate = () => {} }) {
  if (!errorBanner || !errorText || !dismissButton || !toast || typeof getContext !== 'function') throw new TypeError('通知区域或项目上下文不完整。');
  const document = errorBanner.ownerDocument;
  let currentKey = contextKey(getContext()), current = null, lastFailure = '', toastTimer;
  const source = document.createElement('strong'), actions = document.createElement('div');
  const expand = document.createElement('button'), inspect = document.createElement('button');
  source.className = 'workspace-notice-source'; actions.className = 'workspace-notice-actions';
  expand.type = inspect.type = dismissButton.type = 'button';
  expand.dataset.noticeExpand = ''; inspect.dataset.noticeLocate = '';
  inspect.textContent = '查看问题'; expand.textContent = '展开详情';
  expand.setAttribute('aria-controls', errorText.id);
  errorBanner.classList.add('workspace-notice');
  errorBanner.setAttribute('aria-atomic', 'true');
  errorText.classList.add('workspace-notice-message');
  actions.append(expand, inspect, dismissButton); errorBanner.prepend(source); errorBanner.append(actions);
  const homes = [errorBanner, toast].map(element => {
    const marker = document.createElement('span'); marker.hidden = true; marker.dataset.noticeHome = '';
    element.before(marker); return { element, marker };
  });
  const dialogs = [];
  function reservePageSpace() {
    const space = !errorBanner.hidden && !errorBanner.closest('dialog[open]') ? Math.ceil(errorBanner.getBoundingClientRect().height) + 24 : 0;
    document.documentElement.style.setProperty('--workspace-notice-space', `${space}px`);
  }
  function relocate(records = []) {
    for (let index = dialogs.length - 1; index >= 0; index--) if (!dialogs[index].isConnected || !dialogs[index].open) dialogs.splice(index, 1);
    for (const record of records) if (record.type === 'attributes' && record.target.tagName === 'DIALOG' && record.target.open) {
      const index = dialogs.indexOf(record.target); if (index >= 0) dialogs.splice(index, 1);
      dialogs.push(record.target);
    }
    for (const dialog of document.querySelectorAll('dialog[open]')) if (!dialogs.includes(dialog)) dialogs.push(dialog);
    const dialog = dialogs.at(-1);
    for (const { element, marker } of homes) {
      if (dialog) { if (element.parentNode !== dialog) dialog.append(element); }
      else if (marker.isConnected && element.parentNode !== marker.parentNode) marker.after(element);
    }
    reservePageSpace();
  }
  const observer = new MutationObserver(relocate);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  document.addEventListener('close', () => relocate(), true);
  document.addEventListener('cancel', () => queueMicrotask(() => relocate()), true);
  if (typeof ResizeObserver === 'function') new ResizeObserver(reservePageSpace).observe(errorBanner);
  document.defaultView.addEventListener('resize', reservePageSpace);
  relocate();

  function clear(options = {}) {
    if (options?.source !== undefined || options?.context !== undefined) {
      syncContext();
      if (!current || options.source !== undefined && current.source !== options.source || options.context !== undefined && current.context !== contextKey(options.context)) return false;
    }
    current = null; errorBanner.hidden = true; errorText.textContent = ''; source.textContent = '';
    expand.hidden = inspect.hidden = true; expand.setAttribute('aria-expanded', 'false');
    errorBanner.dataset.expanded = 'false'; errorBanner.classList.remove('workspace-notice-long');
    reservePageSpace();
    return true;
  }
  function syncContext() {
    const nextKey = contextKey(getContext());
    if (nextKey === currentKey) return false;
    currentKey = nextKey; lastFailure = ''; clear();
    clearTimeout(toastTimer); toast.hidden = true; toast.textContent = '';
    return true;
  }
  function error(value, options = {}) {
    syncContext();
    if (options.context && contextKey(options.context) !== currentKey) return false;
    const message = messageOf(value);
    if (current && current.message === message && current.source === (options.source || '') && current.target === options.target && current.stageId === options.stageId) {
      errorBanner.hidden = false; relocate(); return true;
    }
    current = { message, source: options.source || '', target: options.target, stageId: options.stageId, context: currentKey };
    source.textContent = SOURCE_LABELS[current.source] || current.source || '操作未完成';
    errorText.textContent = message; errorBanner.hidden = false;
    errorBanner.classList.toggle('workspace-notice-long', message.length > 240 || message.split('\n').length > 3);
    errorBanner.dataset.expanded = 'false'; expand.setAttribute('aria-expanded', 'false'); expand.textContent = '展开详情';
    expand.hidden = !errorBanner.classList.contains('workspace-notice-long');
    inspect.hidden = !(current.target || current.stageId || current.source);
    relocate(); return true;
  }
  function success(message) {
    syncContext(); toast.textContent = messageOf(message); toast.hidden = false; relocate();
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
  }
  function failure(run) {
    syncContext();
    if (!run || run.id !== getContext()?.runId) return false;
    const stage = run.stages?.find(item => item.status === 'failed');
    if (!stage && run.status !== 'failed') return false;
    const description = stage?.id === 'spec' ? run.specificationFailure : ['architecture', 'tasks'].includes(stage?.id) ? run.engineeringFailure : null;
    const message = description?.message || stage?.error || run.error || '本次规划未完成，请查看失败阶段。';
    const next = description?.nextStep;
    const text = `${stage?.title ? `${stage.title}：` : ''}${messageOf(message)}${next ? `\n${next}` : ''}`;
    const key = JSON.stringify([run.id, stage?.id, stage?.attempt, messageOf(message), next]);
    if (key === lastFailure) return false;
    lastFailure = key;
    return error(text, { source: 'planning', stageId: stage?.id, context: getContext() });
  }
  dismissButton.addEventListener('click', clear);
  expand.addEventListener('click', () => {
    if (syncContext() || !current) return;
    const expanded = errorBanner.dataset.expanded !== 'true';
    errorBanner.dataset.expanded = String(expanded); expand.setAttribute('aria-expanded', String(expanded));
    expand.textContent = expanded ? '收起详情' : '展开详情';
    reservePageSpace();
  });
  inspect.addEventListener('click', () => {
    if (syncContext() || !current || current.context !== currentKey) return;
    const { source, stageId, target } = current;
    const context = { ...getContext() };
    try {
      const result = locate({ source, stageId, target });
      if (result?.catch) result.catch(cause => error(cause, { source: '界面定位', context }));
    } catch (cause) { error(cause, { source: '界面定位', context }); }
  });
  clear();
  return Object.freeze({ error, clear, success, syncContext, failure });
}
