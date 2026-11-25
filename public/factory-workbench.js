const byId = id => document.getElementById(`factory-${id}`);
const params = new URLSearchParams(location.search);
const projectId = params.get('project')?.trim();
const selectedRun = params.get('run')?.trim();
const endpoint = projectId && `/api/projects/${encodeURIComponent(projectId)}/factory`;
const statusPath = endpoint && (selectedRun ? `${endpoint}?${new URLSearchParams({ run: selectedRun })}` : endpoint);
const states = {
  idle: '尚未启动', stopped: '尚未启动', starting: '正在启动', running: '运行中', ready: '运行中',
  stopping: '正在停止', unavailable: '当前不可用', blocked: '当前不可用', failed: '启动或连接失败', error: '连接失败',
};
const modelConfirmation = byId('planning-confirmation');
const executionConfirmation = byId('execution-confirmation');
let context = {};
let actionInProgress = false;
let readingStatus = false;
let actionSequence = 0;
let createdRunId = null;

function localDashboard(value) {
  const port = typeof value === 'string' && /^http:\/\/127\.0\.0\.1:([0-9]+)\/?$/.exec(value)?.[1];
  return port && Number(port) >= 1 && Number(port) <= 65535 ? `http://127.0.0.1:${Number(port)}/` : null;
}

function setMessage(target, message) {
  const element = byId(target);
  const text = message || '';
  if (element.textContent !== text) element.textContent = text;
  element.hidden = !text;
}

function renderDashboard(url) {
  const dashboard = byId('dashboard');
  const frame = byId('dashboard-frame');
  dashboard.hidden = !url;
  if (!url) {
    frame.removeAttribute('src');
    byId('created-run').hidden = true;
    return;
  }
  const graphUrl = `${url}#/network`;
  if (frame.getAttribute('src') !== graphUrl) frame.src = graphUrl;
  byId('open-graph').href = graphUrl;
  byId('open-settings').href = `${url}#/settings`;
  byId('open-performance').href = `${url}#/performance`;
  byId('open-dashboard').href = graphUrl;
  const runLink = byId('created-run');
  runLink.hidden = !createdRunId;
  if (createdRunId) {
    runLink.href = `${url}#/runs/${createdRunId}`;
    runLink.textContent = `打开 Factory 运行 #${createdRunId}`;
  }
}

function render() {
  const { factory, handoff, project } = context;
  const url = localDashboard(factory?.url);
  const state = url ? 'running' : factory?.available === false ? 'unavailable' : factory?.state || (factory ? 'stopped' : 'loading');
  const hasSpec = Boolean(handoff?.available && handoff.specRevision && (selectedRun || handoff.runId));
  const canStart = Boolean(factory?.available && !url && !['starting', 'stopping'].includes(state));
  const version = byId('version');
  const runtime = byId('runtime-message');
  const handoffMessage = byId('handoff-message');
  byId('project').textContent = project?.name || (projectId ? 'Taskflow 项目' : '请先在项目工作台选择一个项目。');
  byId('status').dataset.state = state;
  byId('state').textContent = states[state] || (state === 'loading' ? '正在读取状态' : '当前不可用');
  version.hidden = !factory?.version;
  version.textContent = factory?.version || '';
  runtime.textContent = factory?.url && !url ? 'Factory 返回了无效的本地地址，请刷新或重新启动。'
    : (factory?.message || (url ? '本地 Factory 已启动。配置、执行记录和交互会话均由 Factory 管理。'
      : factory?.available === false ? '尚未找到 Factory v1.0.5。请在 Taskflow 项目目录运行 npm run factory:install，然后刷新状态。'
        : 'Factory 调用本机配置的编码 CLI。启动后可在原生界面管理 Agent、命令和交互会话。'));
  byId('start-form').hidden = Boolean(url);
  byId('start').disabled = !canStart || actionInProgress || !executionConfirmation.checked;
  const canStop = Boolean(url || state === 'failed');
  byId('stop').hidden = !canStop;
  byId('stop').disabled = !canStop || actionInProgress;
  byId('refresh').disabled = !endpoint || readingStatus || actionInProgress;
  byId('handoff-version').hidden = !hasSpec;
  byId('plan-form').hidden = !hasSpec;
  byId('spec-title').textContent = handoff?.title || '设计规格';
  byId('spec-revision').textContent = handoff?.specRevision || '';
  byId('plan').disabled = !url || !hasSpec || actionInProgress || !modelConfirmation.checked;
  handoffMessage.textContent = !hasSpec ? '当前项目的规划运行确认规格后，可以在这里交给 Factory 生成开发计划。'
    : url ? '在 Taskflow 确认的规格将作为本次 Factory 规划的依据。' : '启动本地 Factory 后即可提交这版规格。';
  renderDashboard(url);
}

function receive(result) {
  if (Object.hasOwn(result, 'handoff') && result.handoff?.specRevision !== context.handoff?.specRevision) {
    modelConfirmation.checked = false;
  }
  context = { ...context, ...result };
}

async function request(url, body, timeout = 30000) {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = result?.message ?? result?.error?.message ?? result?.error;
    throw new Error(typeof detail === 'string' ? detail : `Factory 请求失败（HTTP ${response.status}）`);
  }
  if (!result || typeof result !== 'object') throw new Error('Factory 返回的数据格式有误。');
  return result;
}

async function refresh({ quiet = false } = {}) {
  if (!endpoint || actionInProgress || readingStatus) return;
  const sequence = actionSequence;
  readingStatus = true;
  render();
  try {
    const result = await request(statusPath);
    if (sequence !== actionSequence) return;
    receive(result);
    if (!quiet) setMessage('error', '');
  } catch (error) {
    if (!quiet && sequence === actionSequence) {
      setMessage('error', error.message);
      if (!context.factory) context.factory = { state: 'unavailable' };
    }
  } finally {
    readingStatus = false;
    render();
  }
}

async function act(action, body, pendingMessage, successMessage) {
  if (!endpoint || actionInProgress) return;
  actionInProgress = true;
  actionSequence++;
  let needsRefresh = false;
  setMessage('error', '');
  setMessage('notice', pendingMessage);
  render();
  try {
    const result = await request(`${endpoint}/${action}`, body, action === 'start' ? 90000 : 30000);
    receive(result);
    if (action === 'stop') createdRunId = null;
    if (action === 'plan') {
      const runId = String(result.run?.id ?? '');
      createdRunId = /^[1-9]\d*$/.test(runId) ? runId : null;
      modelConfirmation.checked = false;
    }
    if (action === 'start') executionConfirmation.checked = false;
    setMessage('notice', successMessage);
  } catch (error) {
    needsRefresh = true;
    setMessage('notice', '');
    setMessage('error', error.name === 'TimeoutError' ? '等待 Factory 超时。请刷新状态，核对结果后再重试。' : error.message);
  } finally {
    actionInProgress = false;
    render();
    if (needsRefresh) void refresh({ quiet: true });
  }
}

byId('refresh').addEventListener('click', () => refresh());
executionConfirmation.addEventListener('change', render);
modelConfirmation.addEventListener('change', render);
byId('start-form').addEventListener('submit', event => {
  event.preventDefault();
  if (byId('start').disabled) return;
  const repositoryPath = byId('repository').value.trim();
  void act('start', { confirmedLocalExecution: true, ...(repositoryPath ? { repositoryPath } : {}) },
    '正在启动本地 Factory…', 'Factory 已启动，可以打开原生工作台。');
});
byId('stop').addEventListener('click', () => {
  if (byId('stop').disabled || !window.confirm('停止本项目的 Factory？正在运行的规划、任务和交互会话可能中断。')) return;
  void act('stop', {}, '正在停止本地 Factory…', '本地 Factory 已停止。');
});
byId('plan-form').addEventListener('submit', event => {
  event.preventDefault();
  if (byId('plan').disabled) return;
  const { handoff } = context;
  void act('plan', { runId: selectedRun || handoff.runId, specRevision: handoff.specRevision, modelUsageConfirmed: true },
    '正在提交已确认规格…', '已提交给 Factory 规划。请在 Factory 查看任务图和规划结果。');
});

if (endpoint) {
  void refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible' && ['running', 'ready', 'starting', 'stopping'].includes(context.factory?.state)) {
      void refresh({ quiet: true });
    }
  }, 4500);
} else {
  context.factory = { state: 'unavailable' };
  render();
}
