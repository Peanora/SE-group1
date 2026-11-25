import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ToolMessages, ToolShell, workbenchUrl } from './shell';

type FactoryStatus = { available?: boolean; state?: string; version?: string; url?: string; message?: string };
type Handoff = { available?: boolean; specRevision?: string; runId?: string; title?: string };
type FactoryContext = { factory?: FactoryStatus; handoff?: Handoff; project?: { id: string; name: string }; run?: { id: string | number } };
type Action = 'start' | 'stop' | 'plan';

const params = new URLSearchParams(location.search);
const projectId = params.get('project')?.trim();
const selectedRun = params.get('run')?.trim();
const endpoint = projectId ? `/api/projects/${encodeURIComponent(projectId)}/factory` : '';
const statusPath = selectedRun ? `${endpoint}?${new URLSearchParams({ run: selectedRun })}` : endpoint;
const states: Record<string, string> = {
  loading: '正在读取状态', idle: '尚未启动', stopped: '尚未启动', starting: '正在启动', running: '运行中', ready: '运行中',
  stopping: '正在停止', unavailable: '当前不可用', blocked: '当前不可用', failed: '启动或连接失败', error: '连接失败',
};

function localDashboard(value?: string) {
  const port = Number(typeof value === 'string' ? /^http:\/\/127\.0\.0\.1:([0-9]+)\/?$/.exec(value)?.[1] : NaN);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? `http://127.0.0.1:${port}/` : '';
}

async function factoryRequest(url: string, body?: object, timeout = 30_000): Promise<FactoryContext> {
  const response = await fetch(url, {
    cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(timeout),
    ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = result?.message ?? result?.error?.message ?? result?.error;
    throw new Error(typeof detail === 'string' ? detail : `Factory 请求失败（HTTP ${response.status}）`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Factory 返回的数据格式有误。');
  return result;
}

export function FactoryPage() {
  const [context, setContext] = useState<FactoryContext>(endpoint ? {} : { factory: { state: 'unavailable' } });
  const latestContext = useRef(context);
  const actionLock = useRef(false);
  const readLock = useRef(false);
  const actionSequence = useRef(0);
  const [acting, setActing] = useState(false);
  const [reading, setReading] = useState(false);
  const [execConfirmed, setExecConfirmed] = useState(false);
  const [planConfirmed, setPlanConfirmed] = useState(false);
  const [createdRun, setCreatedRun] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const { factory, handoff, project } = context;
  const url = localDashboard(factory?.url);
  const lifecycle = factory?.state;
  const missingBinary = factory?.available === false;
  const transitioning = lifecycle === 'starting' || lifecycle === 'stopping';
  const state = url ? 'running' : (transitioning || lifecycle === 'failed') ? lifecycle
    : missingBinary ? 'unavailable' : lifecycle ?? (factory ? 'stopped' : 'loading');
  const runId = selectedRun || handoff?.runId;
  const returnHref = project?.id === projectId ? workbenchUrl(projectId, runId) : '/';
  const revision = handoff?.available && runId ? handoff.specRevision : undefined;
  const canStart = Boolean(factory?.available && !url && !transitioning);
  const canStop = Boolean(url || lifecycle === 'failed');
  const graph = url ? `${url}#/network` : undefined;

  function receive(result: FactoryContext) {
    const previous = latestContext.current;
    if (Object.hasOwn(result, 'handoff') && result.handoff?.specRevision !== previous.handoff?.specRevision) {
      setPlanConfirmed(false);
    }
    const next = { ...previous, ...result };
    latestContext.current = next;
    setContext(next);
  }

  async function refresh(quiet = false) {
    if (!endpoint || actionLock.current || readLock.current) return;
    const sequence = actionSequence.current;
    readLock.current = true;
    setReading(true);
    try {
      const result = await factoryRequest(statusPath);
      if (sequence !== actionSequence.current) return;
      receive(result);
      if (!quiet) setError('');
    } catch (failure) {
      if (!quiet && sequence === actionSequence.current) {
        setError(failure instanceof Error ? failure.message : '无法读取 Factory 状态。');
        if (!latestContext.current.factory) receive({ factory: { state: 'unavailable' } });
      }
    } finally {
      readLock.current = false;
      setReading(false);
    }
  }

  async function act(action: Action, body: object, pending: string, success: string) {
    if (!endpoint || actionLock.current) return;
    actionLock.current = true;
    actionSequence.current++;
    setActing(true);
    setError('');
    setNotice(pending);
    let needsRefresh = false;
    try {
      const result = await factoryRequest(`${endpoint}/${action}`, body, action === 'start' ? 90_000 : 30_000);
      receive(result);
      if (action === 'stop') setCreatedRun('');
      if (action === 'plan') {
        const id = String(result.run?.id ?? '');
        setCreatedRun(/^[1-9]\d*$/.test(id) ? id : '');
        setPlanConfirmed(false);
      }
      if (action === 'start') setExecConfirmed(false);
      setNotice(success);
    } catch (failure) {
      needsRefresh = true;
      setNotice('');
      setError(failure instanceof Error
        ? (failure.name === 'TimeoutError' ? '等待 Factory 超时。请刷新状态，核对结果后再重试。' : failure.message)
        : 'Factory 操作失败，请核对运行状态。');
    } finally {
      actionLock.current = false;
      setActing(false);
      if (needsRefresh) void refresh(true);
    }
  }

  useEffect(() => {
    if (!endpoint) return;
    void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible' && ['running', 'ready', 'starting', 'stopping'].includes(latestContext.current.factory?.state ?? '')) {
        void refresh(true);
      }
    }, 4500);
    return () => window.clearInterval(poll);
  }, []);

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStart || acting || !execConfirmed) return;
    const repositoryPath = String(new FormData(event.currentTarget).get('repositoryPath')).trim();
    void act('start', { confirmedLocalExecution: true, ...(repositoryPath ? { repositoryPath } : {}) },
      '正在启动本地 Factory…', 'Factory 已启动，可以打开原生工作台。');
  }

  function plan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!url || !runId || !revision || acting || !planConfirmed) return;
    void act('plan', { runId, specRevision: revision, modelUsageConfirmed: true },
      '正在提交已确认规格…', '已提交给 Factory 规划。请在 Factory 查看任务图和规划结果。');
  }

  function stop() {
    if (!canStop || actionLock.current || !window.confirm('停止本项目的 Factory？正在运行的规划、任务和交互会话可能中断。')) return;
    void act('stop', {}, '正在停止本地 Factory…', '本地 Factory 已停止。');
  }

  const runtimeMessage = factory?.url && !url ? 'Factory 返回了无效的本地地址，请刷新或重新启动。' :
    factory?.message || (url ? '原生工作台负责管理 CLI、执行记录和交互会话。'
      : missingBinary ? `尚未找到 Factory v${factory?.version ?? '1.0.5'}。`
        : 'Factory 使用本机配置的编码 CLI 来规划任务、执行命令和审阅变更。');
  const handoffMessage = !revision ? '项目规格在 Taskflow 确认后，即可交给 Factory 规划。'
    : url ? 'Factory 将按以下规格版本规划。' : '启动本地 Factory 后即可提交这版规格。';

  return (
    <ToolShell id="factory-main" skipLabel="跳到 Factory 工作流" returnLabel="返回项目工作台" returnHref={returnHref}>
      <header className="factory-heading">
        <div className="factory-context">
          <h1>Factory 工作流</h1>
          <p id="factory-project">{project?.name || (projectId ? 'Taskflow 项目' : '请先在项目工作台选择一个项目。')}</p>
        </div>
        <div className="factory-session">
          <div className="factory-status" id="factory-status" data-state={state}>
            <span className="factory-status-dot" aria-hidden="true" />
            <span id="factory-state">{states[state] ?? '当前不可用'}</span>
            <span id="factory-version" hidden={!factory?.version}>{factory?.version}</span>
          </div>
          <button id="factory-refresh" type="button" className="tools-text-button" disabled={!endpoint || reading || acting} onClick={() => void refresh()}>刷新状态</button>
          <button id="factory-stop" type="button" className="tools-button tools-danger" hidden={!canStop} disabled={!canStop || acting} onClick={stop}>停止本地 Factory</button>
        </div>
      </header>
      <ToolMessages prefix="factory" error={error} notice={notice} />
      <div className={`factory-layout${url ? ' factory-layout-running' : ''}`}>
        <section id="factory-dashboard" className="factory-dashboard" aria-labelledby="factory-dashboard-heading" hidden={!url}>
          <div className="factory-dashboard-header">
            <h2 id="factory-dashboard-heading">Factory 原生工作台</h2>
            <nav aria-label="Factory 原生工作台入口">
              <a href={graph} id="factory-open-graph" target="factory-dashboard-frame">Agent 图</a>
              <a href={url ? `${url}#/settings` : undefined} id="factory-open-settings" target="factory-dashboard-frame">配置与角色</a>
              <a href={url ? `${url}#/performance` : undefined} id="factory-open-performance" target="factory-dashboard-frame">运行表现</a>
              <a href={graph} id="factory-open-dashboard" target="_blank" rel="noopener noreferrer">在新标签页打开 <span aria-hidden="true">↗</span></a>
            </nav>
          </div>
          {url && <iframe src={graph} id="factory-dashboard-frame" name="factory-dashboard-frame" title="Agentic Software Factory 原生工作台" referrerPolicy="no-referrer" />}
        </section>
        <aside className="factory-controls" aria-label="Factory 会话与规格">
          <section className="factory-runtime" aria-labelledby="factory-runtime-heading">
            <h2 id="factory-runtime-heading">本地运行环境</h2>
            <p id="factory-runtime-message">{runtimeMessage}</p>
            {missingBinary && <p className="factory-install-note">在 Taskflow 项目目录运行 <code>npm run factory:install</code>，然后刷新状态。</p>}
            <form id="factory-start-form" hidden={Boolean(url)} onSubmit={start}>
              <label className="tools-field" htmlFor="factory-repository">
                <span>Git 仓库绝对路径 <small>选填</small></span>
                <input id="factory-repository" name="repositoryPath" autoComplete="off" spellCheck={false} aria-describedby="factory-repository-hint" />
              </label>
              <p id="factory-repository-hint" className="tools-hint">留空使用项目的专用目录。你也可以填写有权操作的本机仓库路径。</p>
              <label className="tools-check">
                <input id="factory-execution-confirmation" type="checkbox" checked={execConfirmed} onChange={event => setExecConfirmed(event.target.checked)} required />
                <span>我确认启用本机执行。Factory 中配置的 CLI 会以当前系统账户权限运行。</span>
              </label>
              <button id="factory-start" className="tools-button tools-primary" disabled={!canStart || acting || !execConfirmed}>启动本地 Factory</button>
            </form>
          </section>
          <section className="factory-handoff" aria-labelledby="factory-handoff-heading">
            <h2 id="factory-handoff-heading">已确认规格</h2>
            <p id="factory-handoff-message">{handoffMessage}</p>
            <dl id="factory-handoff-version" className="factory-spec" hidden={!revision}>
              <div><dt>规格</dt><dd id="factory-spec-title">{handoff?.title || '设计规格'}</dd></div>
              <div><dt>版本</dt><dd id="factory-spec-revision">{revision}</dd></div>
            </dl>
            <form id="factory-plan-form" hidden={!revision} onSubmit={plan}>
              <label className="tools-check">
                <input id="factory-planning-confirmation" type="checkbox" checked={planConfirmed} onChange={event => setPlanConfirmed(event.target.checked)} required />
                <span>我确认将此版规格交给 Factory 的 Planner，允许消耗该 CLI 的模型用量。</span>
              </label>
              <button id="factory-plan" className="tools-button tools-primary" disabled={!url || !revision || acting || !planConfirmed}>交给 Factory 规划</button>
            </form>
            <p className="tools-hint">规划完成后，请到 Factory 核对任务和团队，再启动开发。</p>
            <a id="factory-created-run" className="tools-text-button factory-run-link" href={url && createdRun ? `${url}#/runs/${createdRun}` : undefined} target="_blank" rel="noopener noreferrer" hidden={!url || !createdRun}>
              {createdRun && `打开 Factory 运行 #${createdRun}`}
            </a>
          </section>
        </aside>
      </div>
    </ToolShell>
  );
}
