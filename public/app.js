import { canEditPlanTasks, createPlanningReview } from './planning-review.js';
import { createSpecRepair } from './spec-repair.js';
import { createPlanningIssue } from './planning-issue.js';
import { createSpecificationMeeting } from './specification-meeting.js';
import { createExecutionPanel } from './execution-panel.js';
import { createVerificationPlans } from './verification-plans.js';
import { createPlannedExecutionPanel } from './planned-execution.js';
import { createProjectEvolution } from './project-evolution.js';
import { createSourceChanges } from './source-changes.js';
import { createSimulatedTasks, SIM_STATUS } from './simulated-tasks.js';
import { createWorkspaceLayout } from './workspace-layout.js';
import { createWorkspaceNotices } from './workspace-notices.js';
import { deliverySteps } from './delivery-workflow.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { health: null, projects: [], project: null, run: null, automatic: null, stageId: 'spec', taskId: null, artifactName: 'task.md', tab: 'events', raw: false, busy: false, epoch: 0, selectionPending: false, pollTimer: null, feedback: '', importFile: null, filename: 'requirements.md' };
let sourceReadyProject = '';
let deliveryMarkup = '';
let executionMarkup = '';
let expandedAutomaticRun = '';
let automaticRetryConsent = null;
const notices = createWorkspaceNotices({ errorBanner: $('#error-banner'), errorText: $('#error-text'), dismissButton: $('#dismiss-error'), toast: $('#toast'),
  getContext: () => ({ projectId: state.project?.id || '', runId: state.run?.id || '' }), locate: locateWorkspaceProblem });
const workspaceLayout = createWorkspaceLayout({ getContext: () => ({ projectId: state.selectionPending ? '' : state.project?.id || '', runId: state.run?.id || '', busy: state.busy, runStatus: state.run?.status, historical: historicalRun() }),
  isViewReady: view => view !== 'source' || sourceReadyProject === state.project?.id,
  onViewChange: view => {
    if (view === 'tasks') { state.tab = 'tasks'; renderRecords(); }
    if (view === 'execution') $('#execution-tools').open = !state.run?.engineeringPlan || !state.health?.plannedExecution?.available;
  } });
let executionContextKey = '';
let sourceContextKey = '';
let simulationContextKey = '';
const simulatedTasks = createSimulatedTasks({ api, getContext: () => ({ projectId: state.selectionPending ? '' : state.project?.id ?? '',
  runId: state.selectionPending ? '' : state.run?.id ?? '', planRevision: state.run?.planRevision ?? '', current: !state.selectionPending && !historicalRun() }),
  onUpdate: () => { if (state.tab === 'tasks') renderRecords(); }, onError: error => showError(error, 'simulation'),
  onFailure: ({ message, context }) => notices.error(message, { source: 'simulation', context }) });
simulatedTasks.mount(document.querySelector('#simulation-panel-host'));
function syncSimulatedTasks() {
  const key = JSON.stringify([state.selectionPending, state.project?.id, state.run?.id, state.run?.planRevision, historicalRun()]);
  if (key !== simulationContextKey) { simulationContextKey = key; void simulatedTasks.refresh(); }
}
function historicalRun(run = state.run) {
  return !!run && (run.sourceSuperseded === true || (state.project?.currentSourceRevision !== undefined
    && (run.sourceRevision !== state.project.currentSourceRevision || (run.sourceGeneration ?? 0) !== state.project.sourceGeneration)));
}
function automaticStatus() {
  if (state.selectionPending || !state.run?.automaticDelivery || historicalRun()) return null;
  return state.automatic?.runId === state.run.id ? state.automatic.result : {
    status: 'queued', stage: 'source', message: '正在读取自动交付进度。',
  };
}
function automaticOwnsRun() {
  return ['queued', 'running', 'needs_clarification'].includes(automaticStatus()?.status);
}
function automaticClarifying() { return automaticStatus()?.status === 'needs_clarification'; }
function verificationRetryContext() {
  const run = state.run, status = automaticStatus(), maxAttempts = status?.retryVerification?.maxAttempts;
  if (status?.status !== 'failed' || !run.planRevision || typeof status.updatedAt !== 'string' || !status.updatedAt
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 3
    || state.health?.teamAccess?.enabled && state.actorRole !== 'owner') return null;
  return { projectId: state.project.id, runId: run.id, planRevision: run.planRevision, updatedAt: status.updatedAt, maxAttempts };
}
function executionContext() {
  if (state.selectionPending) return { projectId: '', runId: '', specRevision: '', planRevision: '', planningStatus: 'unconfirmed' };
  const run = state.run;
  const confirmed = !historicalRun(run) && run?.workflowVersion === 2 && run.approvals?.spec?.revision === run.specRevision
    && run.approvals?.plan?.revision === run.planRevision && run.approvals?.plan?.specRevision === run.specRevision
    && !!run.specRevision && !!run.planRevision && run.review?.passed === true;
  return { projectId: state.project?.id ?? '', runId: run?.id ?? '', specRevision: run?.specRevision ?? '',
    planRevision: run?.planRevision ?? '', planningStatus: confirmed ? 'confirmed' : 'unconfirmed' };
}
const executionPanel = createExecutionPanel({ api: executionApi, getContext: executionContext, onError: error => showError(error, 'execution'),
  onFailure: ({ message, context }) => notices.error(message, { source: 'execution', context }) });
void executionPanel.mount(document.querySelector('#execution-panel-host'));
let verificationPlans = null, verificationContextKey = '';
let plannedPanel = null, plannedContextKey = '';
let evolutionPanel = null, evolutionContextKey = '';
const evolutionContext = () => ({ ...executionContext(), sourceRevision: state.run?.sourceRevision ?? '', sourceGeneration: state.run?.sourceGeneration ?? 0 });
function syncExecutionPanel() {
  const next = JSON.stringify(executionContext());
  if (next !== executionContextKey) { executionContextKey = next; void executionPanel.refresh(); }
  // A running older server can serve fresh static files before its next restart.
  // Only request the new routes after the server advertises the capability.
  const available = state.health?.verificationPlanning?.available === true && state.health.verificationPlanning.phase === 'definition_only';
  $('#verification-plans-section').hidden = !available;
  $('#verification-plans-unavailable').hidden = !state.health || available;
  if (!available && verificationPlans) { verificationPlans.destroy(); verificationPlans = null; verificationContextKey = ''; }
  if (available && !verificationPlans) {
    verificationPlans = createVerificationPlans({ api: verificationApi, getContext: executionContext, onError: error => showError(error, 'verification'),
      onUpdate: renderDeliveryProgress, onApproved: () => { openDeliveryStage('coding'); void plannedPanel?.refresh(); }, autoRepairOnPropose: true,
      failureRecovery: state.health.verificationPlanning.failureRecovery === true, canEdit: () => !state.health?.teamAccess?.enabled || state.actorRole === 'owner',
      automated: automaticOwnsRun });
    verificationContextKey = next; void verificationPlans.mount($('#verification-plans-host'));
  } else if (verificationPlans && next !== verificationContextKey) { verificationContextKey = next; void verificationPlans.refresh(); }
  const plannedAvailable = available && state.health?.plannedExecution?.available === true && state.health.plannedExecution.profile === 'planned-web-v1';
  $('#planned-execution-section').hidden = !plannedAvailable;
  if (!plannedAvailable && plannedPanel) { plannedPanel.destroy(); plannedPanel = null; plannedContextKey = ''; }
  if (plannedAvailable && !plannedPanel) {
    plannedPanel = createPlannedExecutionPanel({ api: plannedApi, getContext: executionContext, onError: error => showError(error, 'planned'),
      onFailure: ({ message, context }) => notices.error(message, { source: 'planned', context }),
      onUpdate: renderDeliveryProgress, openVerification: () => openDeliveryStage('verification'), reviseChecklist: prepareChecklistRevision,
      automated: automaticOwnsRun,
      canReviseChecklist: () => !state.busy && !state.selectionPending && (!state.health?.teamAccess?.enabled || state.actorRole === 'owner') });
    plannedContextKey = next; void plannedPanel.mount($('#planned-execution-host'));
  } else if (plannedPanel && next !== plannedContextKey) { plannedContextKey = next; void plannedPanel.refresh(); }
  const evolutionAvailable = plannedAvailable && state.health?.localEvolution?.available === true;
  $('#project-evolution-section').hidden = !evolutionAvailable;
  if (!evolutionAvailable && evolutionPanel) { evolutionPanel.destroy(); evolutionPanel = null; evolutionContextKey = ''; }
  const evolutionNext = JSON.stringify(evolutionContext());
  if (evolutionAvailable && !evolutionPanel) {
    evolutionPanel = createProjectEvolution({ api: plannedApi, getContext: evolutionContext, onError: error => showError(error, 'planned') });
    evolutionContextKey = evolutionNext; void evolutionPanel.mount($('#project-evolution-host'));
  } else if (evolutionPanel && evolutionNext !== evolutionContextKey) { evolutionContextKey = evolutionNext; void evolutionPanel.refresh(); }
}
const sourceChanges = createSourceChanges({ api: sourceApi, getContext: () => ({ projectId: state.selectionPending ? '' : state.project?.id ?? '' }),
  onReady: ({ projectId }) => {
    if (state.selectionPending || projectId !== state.project?.id) return;
    sourceReadyProject = projectId; workspaceLayout.restore();
  },
  onApplied: async change => { if (change.projectId !== state.project?.id || state.selectionPending) return; if (await refreshSourceProject(change.projectId, state.epoch)) toast('新需求已应用，请重新编排并确认规格和计划'); },
  onReplan: ({ projectId, revision, generation }) => {
    if (state.selectionPending || projectId !== state.project?.id || revision !== state.project.currentSourceRevision || generation !== state.project.sourceGeneration) throw new Error('需求版本已变化，请刷新核对后再重新规划。');
    if ($('#start-run').disabled) throw new Error('当前不能启动规划，请先核对已有运行状态、规划模式和预算提示。');
    workspaceLayout.show('plan');
    return startRun({ revision, generation });
  },
  onError: error => showError(error, 'source') });
void sourceChanges.mount(document.querySelector('#source-changes-host'));
function syncSourceChanges() {
  $('#source-changes-section').hidden = !state.project || state.selectionPending;
  const next = state.selectionPending ? '' : state.project?.id ?? '';
  if (next !== sourceContextKey) { sourceContextKey = next; sourceReadyProject = ''; void sourceChanges.refresh(); }
}
async function refreshSourceProject(projectId, epoch, expected) {
  const { project } = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  if (epoch !== state.epoch || state.selectionPending || state.project?.id !== projectId) return false;
  if (expected && ((project.sourceGeneration ?? 0) < expected.generation || (project.sourceGeneration === expected.generation && project.currentSourceRevision !== expected.revision))) throw new Error('项目输入版本尚未核对一致，请刷新后继续。');
  const runId = state.run?.id;
  const updatedEpoch = ++state.epoch; clearTimeout(state.pollTimer);
  state.project = { ...project, runs: project.runs || [] };
  state.run = state.project.runs.find(run => run.id === runId) || sortedRuns()[0] || null;
  rememberSelection(); renderAll(); schedulePoll();
  await refreshProjects();
  return updatedEpoch === state.epoch && !state.selectionPending && state.project?.id === projectId;
}
async function sourceApi(url, options) {
  const projectId = state.project?.id, epoch = state.epoch, noticeContext = { projectId, runId: state.run?.id || '' };
  const result = await api(url, options);
  if (options?.method === 'POST' && epoch === state.epoch && projectId === state.project?.id) notices.clear({ source: 'source', context: noticeContext });
  // A different request may apply a source version while this page is open.
  // Re-read persisted project facts before displaying actions for its old runs.
  if ((!options?.method || options.method === 'GET') && projectId && !state.selectionPending && epoch === state.epoch && state.project?.id === projectId
    && url === `/api/projects/${encodeURIComponent(projectId)}/changes` && Number.isSafeInteger(result?.current?.generation)
    && result.current.generation !== (state.project.sourceGeneration ?? 0)) await refreshSourceProject(projectId, epoch, result.current);
  return result;
}
async function executionApi(url, options) {
  const context = { projectId: state.project?.id || '', runId: state.run?.id || '' };
  const result = await api(url, options);
  if (options?.method === 'POST') notices.clear({ source: 'execution', context });
  return result;
}
async function verificationApi(url, options) {
  const context = { projectId: state.project?.id || '', runId: state.run?.id || '' };
  const result = await api(url, options);
  if (options?.method === 'POST') { notices.clear({ source: 'verification', context }); void plannedPanel?.refresh(); }
  return result;
}
async function plannedApi(url, options) {
  const context = { projectId: state.project?.id || '', runId: state.run?.id || '' };
  const result = await api(url, options);
  if (options?.method === 'POST') notices.clear({ source: 'planned', context });
  return result;
}
const ACTIVE = new Set(['running', 'paused', 'awaiting_spec', 'awaiting_review']);
const STATUS = { pending: '待执行', running: '执行中', paused: '已暂停', succeeded: '已完成', failed: '执行失败', blocked: '被阻塞', awaiting_spec: '等待规格确认', awaiting_review: '等待计划确认', idle: '尚未开始' };
const STAGES = [
  { id: 'intake', title: '需求接收', dependsOn: [], x: 1.5, y: 110, description: '读取原始需求，保留本次运行的输入快照，检查文档是否可处理。', output: '需求文本与运行快照' },
  { id: 'spec', title: '规格整理', dependsOn: ['intake'], x: 20, y: 110, description: '整理项目目标、功能要求、约束与待确认事项，并为需求建立可追踪的编号。', output: 'spec.md' },
  { id: 'architecture', title: '架构设计', dependsOn: ['spec'], x: 40, y: 30, description: '规格确认后，根据确认版本形成模块职责、数据流和技术方案建议。', output: 'architecture.md' },
  { id: 'tasks', title: '任务拆解', dependsOn: ['spec'], x: 40, y: 190, description: '规格确认后，将需求转换为带有依赖、验收条件和来源编号的开发任务。', output: 'task.md' },
  { id: 'review', title: '计划校验', dependsOn: ['architecture', 'tasks'], x: 62, y: 110, description: '检查任务依赖与需求覆盖，汇总需要人工检查的内容。校验后等待你确认。', output: 'review.md' },
  { id: 'export', title: '文档导出', dependsOn: ['review'], x: 82, y: 110, description: '在你确认后生成开发交接说明，并准备包含全部产物的文档包。', output: 'handoff.md / plan.json' },
];
const ICONS = {
  document: '<svg viewBox="0 0 20 24" aria-hidden="true"><path d="M3 1h9l5 5v17H3Z"/><path d="M12 1v6h5M6 11h8M6 15h8M6 19h5"/></svg>',
  log: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="4" width="22" height="25" rx="3"/><path d="M10 11h12M10 17h12M10 23h7"/></svg>',
  graph: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="11" width="8" height="10" rx="2"/><rect x="22" y="2" width="8" height="9" rx="2"/><rect x="22" y="22" width="8" height="9" rx="2"/><path d="M10 16h6V6h6M16 16v10h6"/></svg>',
};
const SAMPLE = `# 工单协作系统需求

## 项目目标

为一个 5 至 20 人的软件开发小组提供工单协作工具。成员能够提交问题，负责人能够分派处理，测试人员能够复核结果。系统需要通过网页操作，并保留完整的状态变更记录。

## 用户角色

- 成员可以创建工单、查看自己提交或参与的工单，并追加评论。
- 项目负责人可以查看项目内全部工单、分派负责人，并调整优先级。
- 测试人员可以将待验证工单标为已解决，或退回处理中并填写原因。

## 功能需求

### F01 用户登录

用户通过邮箱和密码登录。未登录访问工单页面时，跳转到登录页面。登录失败应给出提示；退出登录后，不能继续使用原会话访问受保护页面。

### F02 工单创建

成员填写标题、问题描述、优先级和所属项目后创建工单。标题和描述必填。创建成功后展示工单详情，记录提交人和创建时间。空标题应阻止提交并指出缺失字段。

### F03 负责人分派

项目负责人可以给工单指定一名项目成员作为处理人。普通成员不能替别人分派工单。分派完成后，在工单详情中显示处理人，并在变更记录中显示操作者和时间。

### F04 状态流转

工单依次经历待处理、处理中、待验证和已解决。处理人可以将待处理改为处理中，并提交处理结果进入待验证；测试人员可以确认已解决或填写原因退回处理中。非法状态跳转应被拒绝，原状态保持不变。

### F05 评论与变更记录

项目内成员可以追加纯文本评论。工单详情按时间显示评论与状态变更记录，包括操作者、时间和内容。评论内容按文本展示，不能作为网页脚本执行。

### F06 列表筛选

用户能够按状态、处理人和优先级筛选工单，支持按标题关键字搜索。列表分页展示，每页 20 条。没有匹配项时显示空状态，并允许清除筛选条件。

## 非功能约束

- 前端支持桌面和手机浏览器，常用操作可以使用键盘完成。
- 服务端检查角色权限，不能只通过隐藏前端按钮控制访问。
- 工单、评论和变更记录需要持久化，服务重启后仍可查询。
- 错误提示应说明失败原因，日志不能记录用户明文密码。

## 验收场景

1. 成员登录，创建一个高优先级工单，并在列表中搜索到该工单。
2. 负责人分派处理人，处理人提交结果，测试人员确认已解决。
3. 成员尝试替别人分派工单时被拒绝，工单原分派保持不变。
4. 输入包含 HTML 标签的评论，页面显示文本且不执行标签。
5. 重启服务后，原工单及其完整变更记录仍可查看。

## 待确认事项

- 首版是否需要邮件通知和找回密码。
- 项目是否可以包含外部协作者。
- 目标部署环境与数据库选择。
`;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && state.health?.teamAccess?.enabled) window.location.replace('/team.html');
  if (!response.ok) throw new Error(data.error || `服务请求失败（${response.status}）`);
  return data;
}
function basePath() { return `/api/projects/${encodeURIComponent(state.project.id)}/runs/${encodeURIComponent(state.run.id)}`; }
function showError(error, source = 'planning') { notices.error(error, { source }); }
function clearError() { notices.clear(); }
function toast(message) { notices.success(message); }
function formatTime(value, full = false) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...(full ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', ...(full ? {} : { second: '2-digit' }), hour12: false }).format(new Date(value));
}
function duration(stage) {
  if (!stage?.startedAt) return '—';
  const seconds = Math.max(0, ((stage.finishedAt ? new Date(stage.finishedAt) : new Date()) - new Date(stage.startedAt)) / 1000);
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1)} 秒`;
}
function replacePreservingFocus(container, html) {
  const key = container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  const oldScroll = { left: container.scrollLeft, top: container.scrollTop };
  container.innerHTML = html;
  container.scrollLeft = oldScroll.left; container.scrollTop = oldScroll.top;
  if (key) $$('[data-focus-key]', container).find((item) => item.dataset.focusKey === key)?.focus({ preventScroll: true });
}
function sortedRuns(project = state.project) { return [...(project?.runs || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
function stageOf(id) { return state.run?.stages?.find((stage) => stage.id === id); }
function stageTitle(id) { return stageOf(id)?.title || STAGES.find((stage) => stage.id === id)?.title || '运行'; }
function specClarificationPending(run = state.run) {
  return Boolean(run?.workflowVersion === 2 && run.status === 'awaiting_spec'
    && (run.spec?.clarificationRequired || run.specQuestions?.some(item => item.blocking && !item.answer?.trim())));
}
function issueCoversSpecQuestions(run = state.run) {
  return specClarificationPending(run) && run?.planningIssue?.stageId === 'spec' && !run.planningIssue.fromInput;
}
function runStatusLabel(run = state.run) {
  if (!run) return '';
  const automatic = { queued: '自动交付准备中', running: '自动交付中', needs_clarification: '等待补充需求', completed: '已通过验收', failed: '自动交付失败', interrupted: '自动交付已中断' }[run.automaticDelivery?.status];
  return automatic || (specClarificationPending(run) ? '等待补充需求' : STATUS[run.status] || run.status);
}
function workflowSteps() {
  return deliverySteps({ project: state.project, run: state.selectionPending ? null : state.run, historical: historicalRun(),
    verification: verificationPlans?.workflowProgress(), development: plannedPanel?.workflowProgress(), automatic: automaticStatus() });
}
function renderDeliveryProgress() {
  const steps = workflowSteps();
  const automatic = automaticStatus();
  const upcoming = (automatic && automatic.status !== 'completed' ? steps.find(step => step.id === automatic.stage) : null)
    ?? steps.find(step => step.state === 'failed') ?? steps.find(step => step.state === 'working')
    ?? steps.find(step => step.state !== 'done');
  const current = upcoming ?? steps.at(-1);
  $('#delivery-current-title').textContent = current.title;
  if ($('#delivery-current-state').textContent !== current.text) $('#delivery-current-state').textContent = current.text;
  $('#delivery-current-state').dataset.state = current.state;
  $('#delivery-done-count').textContent = `${steps.filter(step => step.state === 'done').length} / ${steps.length} 完成`;
  if (automatic && expandedAutomaticRun !== state.run.id) { expandedAutomaticRun = state.run.id; $('#delivery-workflow').open = true; }
  const markup = steps.map(({ id, title, state: status, text, detail, hasUsage }, index) => `<li><button type="button" class="delivery-step" data-delivery-step="${id}" data-focus-key="delivery-${id}" data-state="${status}" ${hasUsage ? 'data-has-usage' : ''} ${upcoming?.id === id ? 'aria-current="step"' : ''} ${state.selectionPending || !state.project && id !== 'source' ? 'disabled' : ''}><span aria-hidden="true">${index + 1}</span><strong>${title}</strong><span class="delivery-state">${escape(text)}</span><small>${escape(detail)}</small></button></li>`).join('');
  if (deliveryMarkup !== markup) {
    deliveryMarkup = markup;
    replacePreservingFocus($('#delivery-steps'), markup);
  }
  renderExecutionFlow(steps);
  renderWorkspaceContext(steps);
}
function nextExecutionStep(steps) {
  const [preparation, coding, testing, delivery] = steps.slice(-4);
  return delivery.state === 'done' ? delivery : preparation.state !== 'done' ? preparation
    : ['working', 'failed', 'waiting'].includes(testing.state) ? testing : coding;
}
function renderExecutionFlow(steps) {
  const next = nextExecutionStep(steps);
  const markup = steps.slice(-4).map(({ id, title, state: status, text }, index) => `<li>
    <button type="button" class="execution-workspace-step" data-execution-step="${id}" data-focus-key="execution-${id}"
      data-state="${status}" ${id === next.id ? 'aria-current="step"' : ''} ${state.selectionPending ? 'disabled' : ''}>
      <span class="execution-step-marker" aria-hidden="true">${status === 'done' ? '✓' : status === 'failed' ? '!' : index + 1}</span>
      <span class="execution-step-label"><strong>${title}</strong><small>${escape(text)}</small></span>
    </button>
  </li>`).join('');
  if (executionMarkup !== markup) {
    executionMarkup = markup;
    replacePreservingFocus($('#execution-workspace-steps'), markup);
  }
  const failure = next.state === 'failed' && next.id !== 'verification' && plannedPanel?.workflowProgress().failureHelp;
  const hint = historicalRun() ? '所选规划属于历史需求版本。切换到当前规划可继续开发。'
    : next.id === 'delivery' ? '当前候选已通过独立验收。打开交付可查看预览与源码。'
      : next.state === 'failed' ? failure?.nextStep || next.detail || '打开当前步骤查看原因和可用操作。'
        : next.detail || '';
  const hintLine = $('#execution-next-hint');
  if (hintLine.textContent !== hint) hintLine.textContent = hint;
  hintLine.hidden = !hint;
}
function renderWorkspaceContext(steps = workflowSteps()) {
  const run = state.run, historical = historicalRun(), context = $('#workspace-context');
  const automatic = automaticStatus(), download = $('#automatic-download');
  const downloadReady = automatic?.status === 'completed' && automatic.downloadAvailable === true && Boolean(automatic.executionId);
  download.hidden = !downloadReady;
  if (downloadReady) download.href = `${basePath()}/development-executions/${encodeURIComponent(automatic.executionId)}/download`;
  else download.removeAttribute('href');
  let title = '开始整理项目需求', note = '先选择规划模式，再开始编排。模型模式会按显示的预算产生用量。', action = '查看规划控制', kind = 'start';
  if (!$('#start-automatic').hidden && !$('#start-automatic').disabled) {
    title = '从这份需求开始开发'; note = '确认一次模型用量后，系统自动推进开发和独立验收。'; action = '查看启动选项';
  }
  if (historical) { title = '正在查看历史需求版本'; note = '历史内容只读。修改需求和再次规划会创建新的版本，原记录保留。'; action = '查看当前需求'; kind = 'source'; }
  else if (['awaiting_spec', 'awaiting_review'].includes(run?.status) && run.planningIssue) {
    title = '规划还有信息需要确认'; note = '逐题填写，提交后模型会自动核对是否还需要补充。'; action = '查看问题'; kind = 'review';
  } else if (run?.status === 'awaiting_spec') {
    title = specClarificationPending(run) ? '下一步：补充需求信息' : '下一步：核对并确认规格';
    note = specClarificationPending(run) ? '回答当前问题并保存，再根据回答整理规格。已保存的回答会保留。' : '核对功能规则与验收，保存修订后再确认；确认前不会生成开发计划。';
    action = '处理规格'; kind = 'review';
  } else if (run?.status === 'awaiting_review') {
    title = '下一步：核对开发计划'; note = '任务图和编辑放在“开发任务”。保存修订后仍需确认计划，才能导出文档。'; action = '核对计划'; kind = 'review';
  } else if (run?.status === 'failed') {
    const failed = run.stages?.find(stage => stage.status === 'failed');
    const failure = failed?.id === 'spec' ? run.specificationFailure : ['tasks', 'architecture'].includes(failed?.id) ? run.engineeringFailure : null;
    title = `${failed?.title || '本次规划'}未完成`;
    note = String(failure?.message || failed?.error || '查看失败原因，已有输入与历史会保留。').slice(0, 180);
    action = run.planningIssue ? '查看问题' : '查看失败与处理'; kind = 'failure';
  } else if (run?.status === 'succeeded') {
    title = '规划文档已生成'; note = '可以查看任务与文档。真实代码执行和验收在独立工作区，规划完成不代表业务软件已验收。'; action = '查看文档'; kind = 'artifacts';
    if (run.engineeringPlan && plannedPanel && executionContext().planningStatus === 'confirmed') {
      const next = nextExecutionStep(steps);
      kind = `delivery:${next.id}`;
      ({ title, note, action } = ({
        verification: { title: '准备验收清单', note: '确认这次开发要通过哪些接口和浏览器检查，再开始编写代码。', action: '打开验收清单' },
        coding: { title: '编写代码', note: next.detail || next.text, action: '查看开发' },
        testing: { title: '测试与审查', note: next.detail || next.text, action: '查看检查结果' },
        delivery: { title: '当前版本已通过验收', note: '可以查看软件预览和源码交付。', action: '查看交付' },
      })[next.id]);
      const failure = plannedPanel.workflowProgress();
      if (next.state === 'failed' && failure.failureHelp) {
        title = failure.failureHelp.title;
        note = `${failure.failureHelp.detail} ${failure.failureHelp.nextStep}`;
        if (failure.canReviseChecklist) { kind = 'reviseChecklist'; action = '准备清单修订'; }
      }
      $('#run-status').textContent = '规划已确认';
      $('#run-progress').textContent = `${steps.filter(step => step.state === 'done').length} / ${steps.length} 个步骤已完成`;
    }
  } else if (run?.status === 'running') {
    const active = run.stages?.filter(stage => stage.status === 'running').map(stage => stage.title).join('、');
    title = active ? `正在${active}` : '规划正在推进'; note = '可以切换工作区查看内容。进度与失败原因由后端实际结果更新。'; action = '查看规划过程'; kind = 'process';
  } else if (run?.status === 'paused') {
    title = '规划已暂停'; note = '查看已完成阶段和暂停状态，确认后可继续推进。'; action = '查看暂停状态'; kind = 'process';
  }
  let visualStatus = run?.status || 'idle';
  if (automatic) {
    const current = steps.find(step => step.id === automatic.stage) || steps[0];
    const presentation = {
      queued: [state.automatic?.runId === run.id ? '自动交付已启动' : '正在核对自动交付进度', '自动交付', 'running', '查看执行进度'],
      running: [current.text, '自动推进中', 'running', '查看执行进度'],
      needs_clarification: ['等待补充需求', '需要回答', 'awaiting_spec', '查看问题'],
      failed: ['自动交付未通过', '未通过', 'failed', '查看失败阶段'],
      interrupted: ['自动交付已中断', '已中断', 'failed', '查看中断阶段'],
      completed: [downloadReady ? '已通过验收，可下载源码' : '自动验收已通过', '已验收', 'succeeded', '查看交付'],
    }[automatic.status];
    if (presentation) {
      const [caption, label, status, nextAction] = presentation;
      title = caption; action = nextAction; visualStatus = status;
      note = automatic.status === 'completed' && !downloadReady ? '源码暂不可下载。打开交付核对当前版本和预览状态。' : automatic.message || current.detail || current.text;
      kind = automatic.status === 'needs_clarification' ? 'clarify' : `delivery:${current.id}`;
      const retry = verificationRetryContext();
      if (retry) { action = retry.maxAttempts ? '重试验收清单' : '使用已保存清单继续'; kind = 'retry-verification'; }
      $('#run-status').textContent = label;
      $('#run-status').className = `status-tag status-${status}`;
      $('#run-progress').textContent = `${steps.filter(step => step.state === 'done').length} / ${steps.length} 个步骤已完成`;
    }
  }
  context.dataset.status = visualStatus;
  if ($('#workspace-context-title').textContent !== title) $('#workspace-context-title').textContent = title;
  if ($('#workspace-context-note').textContent !== note) $('#workspace-context-note').textContent = note;
  const button = $('[data-workspace-next]'); button.textContent = action; button.dataset.nextKind = kind;
  button.className = `button ${downloadReady ? 'button-outline' : 'button-primary'}`;
  button.disabled = !state.project || state.busy || state.selectionPending;
}
function focusWorkspaceTarget(target) {
  if (!target || !target.getClientRects().length) return;
  if (!target.matches('button, summary, input, select, textarea, a[href]')) target.setAttribute('tabindex', '-1');
  target.scrollIntoView({ block: 'nearest' });
  target.focus({ preventScroll: true });
}
function openDeliveryStage(stage) {
  if (state.selectionPending) return;
  if (!state.project) {
    if (stage === 'source') openProjectDialog();
    return;
  }
  const run = state.run;
  if (stage === 'source') { $('#source-button').click(); return; }
  if (stage === 'spec') { locateWorkspaceProblem({ source: 'planning', stageId: 'spec', target: '#stage-inspector' }); return; }
  if (stage === 'plan' && run?.tasks?.length) { simulatedTasks.showPlan(); workspaceLayout.show('tasks'); focusWorkspaceTarget($('#records-body')); return; }
  if (stage === 'plan') { locateWorkspaceProblem({ source: 'planning', stageId: run?.stages?.find(item => ['architecture', 'tasks', 'review'].includes(item.id) && item.status === 'failed')?.id || 'tasks', target: '#stage-inspector' }); return; }
  if (stage === 'spec-approval' || stage === 'plan-approval') {
    workspaceLayout.show('plan');
    if (stage === 'spec-approval' && specClarificationPending() && planningIssue.open()) { renderControls(); return; }
    if (stage === 'spec-approval' && run?.approvals?.spec?.revision && run.status !== 'awaiting_spec') { showArtifact('spec.md'); focusWorkspaceTarget($('#records-body')); return; }
    focusWorkspaceTarget($('#review-heading') || $('#stage-inspector'));
    return;
  }
  workspaceLayout.show('execution');
  const verification = $('#verification-plans-section');
  verification.open = stage === 'verification' && !verification.hidden;
  if (stage === 'verification') {
    const automatic = automaticStatus();
    if (automatic?.status === 'failed' && automatic.stage === 'verification' && automatic.proposalId) {
      void verificationPlans?.selectProposal(automatic.proposalId);
    }
    focusWorkspaceTarget(!verification.hidden ? $('summary', verification) : $('#verification-plans-unavailable'));
  }
  else focusWorkspaceTarget(plannedPanel?.focusStage(stage) || $('#execution-tools > summary'));
}
function locateWorkspaceProblem({ source = 'planning', stageId, target } = {}) {
  const views = { source: 'source', execution: 'execution', planned: 'execution', verification: 'execution', simulation: 'tasks', tasks: 'tasks' };
  workspaceLayout.show(views[source] || 'plan');
  if (stageId) { state.stageId = stageId; renderWorkflow(); renderInspector(); }
  if (source === 'planning') $('#workflow-details').open = true;
  if (['planning', 'review'].includes(source) && (!stageId || stageId === state.run?.planningIssue?.stageId) && planningIssue.open()) {
    $('#spec-repair-host').hidden = true;
    if (issueCoversSpecQuestions()) $('#review-banner').hidden = true;
    return;
  }
  if (source === 'simulation') $('#simulation-tools').open = true;
  if (source === 'verification') $('#verification-plans-section').open = true;
  if (source === 'execution') $('#execution-tools').open = true;
  let element = typeof target === 'string' ? $(target) : target;
  if (!element?.isConnected) {
    const local = source === 'source' ? $('#source-changes-host') : source === 'execution' ? $('#execution-panel-host') : source === 'planned' ? $('#planned-execution-host') : source === 'verification' ? $('#verification-plans-host') : source === 'simulation' ? $('#simulation-panel-host') : stageId === 'spec' && !$('#spec-repair-host').hidden ? $('#spec-repair-host') : $('#stage-inspector');
    element = [...local.querySelectorAll('[role="alert"]')].find(item => item.getClientRects().length) || local;
  }
  element.setAttribute('tabindex', '-1'); element.scrollIntoView({ block: 'nearest' }); element.focus({ preventScroll: true });
}
function handleWorkspaceNext() {
  const kind = $('[data-workspace-next]').dataset.nextKind;
  if (kind === 'retry-verification') {
    const retry = verificationRetryContext();
    if (retry) showAutomaticConsent(retry);
    return;
  }
  if (kind === 'clarify') {
    locateWorkspaceProblem({ source: 'planning', stageId: state.run?.planningIssue?.stageId ?? 'spec',
      target: $('#spec-repair-host').hidden ? '#review-heading' : '#spec-repair-host' });
    return;
  }
  if (kind === 'reviseChecklist') { void plannedPanel?.reviseCurrentChecklist(); return; }
  if (kind?.startsWith('delivery:')) { openDeliveryStage(kind.slice('delivery:'.length)); return; }
  if (kind === 'source') { workspaceLayout.show('source'); return; }
  if (kind === 'artifacts') { showArtifact('task.md'); return; }
  if (kind === 'failure') { locateWorkspaceProblem({ source: 'planning', stageId: state.run?.stages.find(stage => stage.status === 'failed')?.id }); return; }
  workspaceLayout.show('plan');
  if (kind === 'review' && state.run?.planningIssue) { locateWorkspaceProblem({ source: 'planning', stageId: state.run.planningIssue.stageId }); return; }
  if (kind === 'process') { $('#workflow-details').open = true; $('#stage-inspector').setAttribute('tabindex', '-1'); $('#stage-inspector').focus({ preventScroll: true }); }
  else if (kind === 'review') { const heading = $('#review-heading'); heading?.setAttribute('tabindex', '-1'); heading?.scrollIntoView({ block: 'nearest' }); heading?.focus({ preventScroll: true }); }
  else focusWorkspaceTarget($('#start-automatic').hidden || $('#start-automatic').disabled ? $('#start-run') : $('#start-automatic'));
}
async function prepareChecklistRevision(executionId) {
  if (!state.run || historicalRun() || state.busy || state.selectionPending || !/^[A-Za-z0-9_-]{1,128}$/u.test(executionId)) return;
  const { projectId, runId, specRevision, planRevision } = executionContext();
  const url = `${basePath()}/development-executions/${encodeURIComponent(executionId)}/revise-checklist`;
  setBusy(true); clearError(); clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  try {
    const { run } = await plannedApi(url, { method: 'POST', body: '{}' });
    if (epoch !== state.epoch || state.project?.id !== projectId || state.run?.id !== runId) return;
    if (run?.id !== runId || run.specRevision !== specRevision || !run.planRevision || run.planRevision === planRevision) {
      throw new Error('修订结果还没有确认，刷新后可查看当前方案。');
    }
    updateRun(run); renderHeader(); workspaceLayout.show('plan'); focusWorkspaceTarget($('#review-heading'));
    toast('已保存方案修订。确认方案后，在「验收准备」核对清单。');
  } catch (error) { if (epoch === state.epoch) showError(error, 'planned'); }
  finally { if (epoch === state.epoch) { setBusy(false); schedulePoll(); } }
}
const planningReview = createPlanningReview({
  container: $('#review-banner'), getState: () => ({ ...state, run: historicalRun() ? { ...state.run, sourceSuperseded: true } : state.run,
    busy: state.busy || state.selectionPending || automaticOwnsRun() && !automaticClarifying(),
    taskEditorOpen: $('#task-edit-dialog').open }), submit: reviewAction,
  refresh: async () => {
    const id = state.run?.id; const epoch = state.epoch;
    const { run } = await api(basePath());
    if (id === state.run?.id && epoch === state.epoch) { updateRun(run); schedulePoll(); }
  },
  showArtifact,
  addFeature: openFeatureEditor,
  inspectIssue: () => locateWorkspaceProblem({ source: 'review' }),
  onPlanDraft: () => { if (state.tab === 'tasks') renderRecords(); },
  onPlanRevised: () => { workspaceLayout.closeEditor({ restoreFocus: false }); workspaceLayout.show('plan'); },
  toast,
});
function openSourceEditor() {
  const section = $('#source-changes-section');
  if (!section || section.hidden) { toast('当前项目没有可提交的原始需求修改入口。'); return; }
  workspaceLayout.show('source');
  sourceChanges.closeFeature({ focus: false });
  $('.source-changes textarea.sc-source')?.scrollIntoView({ block: 'center' });
}
async function openFeatureEditor() {
  if (!state.project || state.selectionPending) return;
  workspaceLayout.show('source');
  await sourceChanges.openFeature();
  $('.source-changes .sc-feature')?.scrollIntoView({ block: 'start' });
}
const specRepair = createSpecRepair({
  container: $('#spec-repair-host'), getState: () => ({ run: historicalRun() ? { ...state.run, sourceSuperseded: true } : state.run,
    busy: state.busy || state.selectionPending || automaticOwnsRun() && !automaticClarifying() }),
  submit: reviewAction, refresh: async () => {
    const id = state.run?.id, epoch = state.epoch;
    const { run } = await api(basePath());
    if (id === state.run?.id && epoch === state.epoch) { updateRun(run); schedulePoll(); }
  }, toast, openSourceEditor,
});
const planningIssue = createPlanningIssue({
  container: $('#planning-issue-host'),
  getState: () => ({ run: historicalRun() ? null : state.run, busy: state.busy || state.selectionPending,
    canEdit: (!state.health?.teamAccess?.enabled || state.actorRole === 'owner') && (!automaticOwnsRun() || automaticClarifying()),
    allowModelExplanation: !state.run?.automaticDelivery }),
  submit: reviewAction,
});

const specificationMeeting = createSpecificationMeeting({ container: $('#specification-meeting-host'),
  getState: () => ({ run: historicalRun() ? { ...state.run, sourceSuperseded: true } : state.run,
    busy: state.busy || state.selectionPending, canEdit: !state.health?.teamAccess?.enabled || state.actorRole === 'owner' }),
  submit: reviewAction, inspectIssue: () => { workspaceLayout.show('plan'); planningIssue.open(); }, showArtifact });

function renderProjects() {
  $('#project-count').textContent = state.projects.length;
  $('#project-list').innerHTML = state.projects.length ? state.projects.map(project => {
    const status = project.lastRunStatus;
    const label = status ? STATUS[status] || status : '尚未编排';
    const active = project.id === state.project?.id;
    return `<div class="project-row"><button class="project-item ${active ? 'active' : ''}" data-project="${escape(project.id)}" aria-current="${active ? 'page' : 'false'}"><svg class="project-icon" viewBox="0 0 20 22" aria-hidden="true"><path d="M3 2h9l5 5v13H3Z"/><path d="M12 2v6h5M6 12h8M6 16h5"/></svg><span class="project-info"><span class="project-name">${escape(project.name)}</span><span class="project-meta">${escape(label)} / ${project.runCount || 0} 次运行</span></span><span class="project-state-dot ${escape(status || '')}"></span></button><button type="button" class="project-delete" data-delete-project="${escape(project.id)}" aria-label="删除项目：${escape(project.name)}" title="删除项目">×</button></div>`;
  }).join('') : '<div class="empty-projects">尚无项目<br>从一份需求文档开始</div>';
}
function renderHeader() {
  $('#project-title').textContent = state.project?.name || '需求编排工作台';
  $('#breadcrumb-project').textContent = state.project?.name || '新项目';
  $('#project-description').textContent = state.project ? `${state.project.source?.filename || '需求文档'}　${state.project.source?.content?.length?.toLocaleString('zh-CN') || 0} 字` : '从需求规划到开发验收。';
  $('#source-button').disabled = !state.project;
  $('#onboarding').hidden = !!state.project;
  const runs = sortedRuns();
  const select = $('#run-select');
  select.innerHTML = runs.length ? runs.map((run, i) => `<option value="${escape(run.id)}" ${run.id === state.run?.id ? 'selected' : ''}>运行 ${String(runs.length - i).padStart(2, '0')}　${escape(formatTime(run.createdAt, true))}　${escape(runStatusLabel(run))}${run.workflowVersion === 2 ? '' : '（旧版记录）'}</option>`).join('') : '<option>尚无运行记录</option>';
  select.disabled = !runs.length || state.busy;
}
function renderControls() {
  const run = state.run;
  const modelNotice = $('#planning-model-notice'), modelBudget = state.health?.modelPlanning;
  modelNotice.hidden = run?.mode !== 'model' && $('#mode-select').value !== 'model';
  const unlimitedEngineering = modelBudget?.engineeringCallLimit === false && modelBudget.engineeringMaxCalls === null;
  const unlimitedSpecification = modelBudget?.specificationCallLimit === false && modelBudget.specificationMaxCalls === null;
  const knownBudget = (unlimitedEngineering || modelBudget?.engineeringCallLimit === true && Number.isSafeInteger(modelBudget.engineeringMaxCalls) && modelBudget.engineeringMaxCalls > 0 && modelBudget.engineeringMaxCalls <= 20)
    && Number.isSafeInteger(modelBudget?.engineeringTimeoutMs) && modelBudget.engineeringTimeoutMs > 0
    && Number.isSafeInteger(modelBudget?.engineeringTotalTimeoutMs) && modelBudget.engineeringTotalTimeoutMs > 0;
  const knownSpecBudget = (unlimitedSpecification || Number.isSafeInteger(modelBudget?.specificationMaxCalls) && modelBudget.specificationMaxCalls > 0 && modelBudget.specificationMaxCalls <= 20)
    && Number.isSafeInteger(modelBudget?.specificationTimeoutMs) && modelBudget.specificationTimeoutMs > 0;
  const specLimitText = !knownSpecBudget ? '规格调用次数未知' : unlimitedSpecification ? '规格调用次数不限' : `规格最多调用 ${modelBudget.specificationMaxCalls} 次`;
  const engineeringLimitText = !knownBudget ? '工程调用次数未知' : unlimitedEngineering ? '工程调用次数不限' : `工程最多调用 ${modelBudget.engineeringMaxCalls} 次`;
  modelNotice.textContent = `整理规格以及确认规格后的工程设计会产生模型用量。${specLimitText}。${engineeringLimitText}。`;
  if (knownSpecBudget) modelNotice.textContent += `单次整理规格最多 ${modelBudget.specificationTimeoutMs / 1000} 秒。`;
  if (knownBudget) modelNotice.textContent += `单次工程设计最多 ${modelBudget.engineeringTimeoutMs / 1000} 秒，${unlimitedEngineering ? '每轮自动修正' : '总时长'}最多 ${Math.round(modelBudget.engineeringTotalTimeoutMs / 60000)} 分钟。`;
  const specification = run?.specificationHistory?.at(-1);
  const frozenSpecification = run?.specificationBudget;
  if (run?.mode === 'model' && knownSpecBudget && !unlimitedSpecification && Number.isSafeInteger(frozenSpecification?.maxCalls) && frozenSpecification.maxCalls > 0
    && Number.isSafeInteger(frozenSpecification.timeoutMs) && frozenSpecification.timeoutMs > 0) modelNotice.textContent += ` 当前运行规格整理上限：${Math.min(modelBudget.specificationMaxCalls, frozenSpecification.maxCalls)} 次、每次 ${Math.min(modelBudget.specificationTimeoutMs, frozenSpecification.timeoutMs) / 1000} 秒；已尝试 ${Number.isSafeInteger(run.specificationCalls) ? run.specificationCalls : '未知'} 次。`;
  if (specification) modelNotice.textContent += ` 最近规格模型调用：${({ running: '处理中', succeeded: '规格已整理', failed: '失败', interrupted: '已中断' })[specification.status] || '状态未知'}；输入 ${Number.isSafeInteger(specification.usage?.inputTokens) ? specification.usage.inputTokens : '未知'}、输出 ${Number.isSafeInteger(specification.usage?.outputTokens) ? specification.usage.outputTokens : '未知'} token。`;
  else if (run?.mode === 'model' && run.stages?.some(stage => stage.id === 'spec' && stage.attempt > 0)) modelNotice.textContent += ' 这次规格整理没有可核对的用量记录，用量为未知。';
  if (run?.specificationRevalidations?.at(-1)?.attemptId === specification?.id) modelNotice.textContent += ' 此响应已免费重新校验并恢复为待确认规格；原失败用量记录保留，恢复未新增模型调用。';
  const design = run?.engineeringHistory?.at(-1);
  const frozenEngineering = run?.engineeringBudget;
  if (run?.mode === 'model' && knownBudget && !unlimitedEngineering && Number.isSafeInteger(frozenEngineering?.maxCalls)) modelNotice.textContent += ` 当前运行工程上限：${Math.min(modelBudget.engineeringMaxCalls, frozenEngineering.maxCalls)} 次；已预留 ${Number.isSafeInteger(run.engineeringCalls) ? run.engineeringCalls : '未知'} 次，修订和重启不重置。`;
  const explanation = run?.planningIssueHistory?.at(-1);
  if (explanation) modelNotice.textContent += ` 最近问题说明：输入 ${explanation.usage?.inputTokens ?? '未知'}、输出 ${explanation.usage?.outputTokens ?? '未知'} token。`;
  const planningPending = [...(state.project?.runs ?? []), ...(run ? [run] : [])].some(item => [...(item.specificationHistory ?? []), ...(item.engineeringHistory ?? []), ...(item.planningIssueHistory ?? [])].some(attempt => attempt.coordinationRequired && !attempt.coordination?.resolved));
  if (planningPending) modelNotice.textContent += ' 前次规划请求或私有回执仍待核对，不能重复发起模型、发布新输入或删除项目；本地结束不表示远端已停。';
  if (design) modelNotice.textContent += ` 最近设计：${({ running: '处理中', succeeded: '草案已生成', failed: '失败', interrupted: '已中断' })[design.status] || '状态未知'}；输入 ${Number.isSafeInteger(design.usage?.inputTokens) ? design.usage.inputTokens : '未知'}、输出 ${Number.isSafeInteger(design.usage?.outputTokens) ? design.usage.outputTokens : '未知'} token。`;
  $('.workspace-budget').hidden = modelNotice.hidden;
  const charge = $('#planning-charge-notice');
  charge.hidden = $('#mode-select').value !== 'model';
  charge.textContent = `模型模式会产生用量。${specLimitText}。${engineeringLimitText}。`;
  const automatic = automaticStatus(), automaticActive = automaticOwnsRun();
  const historical = historicalRun(run), active = !historical && (ACTIVE.has(run?.status) || automaticActive);
  const changing = state.busy || state.selectionPending;
  const autoConfig = state.health?.automaticDelivery, autoStart = $('#start-automatic');
  const mayOwn = !state.health?.teamAccess?.enabled || state.actorRole === 'owner';
  const knownAutoBudget = ['specificationMaxCalls', 'engineeringMaxCalls', 'verificationMaxAttempts'].every(key => Number.isSafeInteger(autoConfig?.[key]) && autoConfig[key] > 0);
  autoStart.hidden = !autoConfig || !mayOwn;
  const autoReady = autoConfig?.available === true && autoConfig.ready !== false && knownAutoBudget;
  autoStart.disabled = !state.project || changing || active || planningPending || !autoReady;
  const autoUnavailable = $('#automatic-unavailable');
  autoUnavailable.hidden = autoStart.hidden || autoReady;
  autoUnavailable.textContent = autoConfig?.reason || '自动交付暂不可用。请核对 Agent 角色的模型服务配置。';
  $$('[data-delete-project]').forEach(button => { button.disabled = changing || planningPending && button.dataset.deleteProject === state.project?.id; });
  $('#start-run').disabled = !state.project || changing || active || planningPending || ($('#mode-select').value === 'model' && (!knownSpecBudget || !knownBudget));
  $('#start-run span').textContent = run ? '再次编排' : '开始编排';
  $('#mode-select').disabled = changing || active;
  $('#failure-select').disabled = changing || active;
  $('#pause-button').hidden = historical || automaticActive || !['running', 'paused'].includes(run?.status);
  $('#pause-button').textContent = run?.status === 'paused' ? '恢复执行' : '暂停';
  $('#pause-button').disabled = changing;
  $('#refresh-button').disabled = state.busy;
  $('#run-select').disabled = !state.project?.runs?.length || state.busy;
  $('#download-bundle').hidden = run?.status !== 'succeeded';
  if (run?.status === 'succeeded') $('#download-bundle').href = `${basePath()}/download`;
  const status = run?.status || 'idle';
  $('#run-status').textContent = `${runStatusLabel(run)}${historical ? ' / 历史输入，只读' : run && run.workflowVersion !== 2 ? ' / 旧版记录' : ''}`;
  $('#run-status').className = `status-tag status-${status}`;
  const clarificationPending = specClarificationPending(run);
  const count = run?.stages?.filter((stage) => stage.status === 'succeeded' && !(clarificationPending && stage.id === 'spec')).length || 0;
  $('#run-progress').textContent = run ? `${count} / ${run.stages.length} 个规划阶段已完成${clarificationPending ? '，整理设计规格等待补充' : run.status === 'paused' ? '，当前任务完成后暂停' : ''}` : '导入需求后开始';
  $('#workflow-subtitle').textContent = run ? `${run.automaticDelivery ? '自动交付' : run.mode === 'model' ? '模型规划' : '本地规则规划'}　运行 ${run.id.slice(-8)}${run.automaticDelivery ? '' : run.workflowVersion === 2 ? '　两次人工确认' : '　旧版流程'}` : '六个阶段，保留每版依据';
  $('#workflow-confirmation-legend').textContent = run?.automaticDelivery ? '自动校验规格与计划' : run && run.workflowVersion !== 2 ? '旧版流程：导出前确认' : '先确认规格，再确认计划';
  $('#source-history-notice').hidden = !historical;
  planningReview.render(); specRepair.render(); specificationMeeting.render();
  if (automaticActive && automatic?.status !== 'needs_clarification') $('#review-banner').hidden = true;
  const issueOpen = planningIssue.render();
  if (issueOpen) $('#spec-repair-host').hidden = true;
  if (issueCoversSpecQuestions(run) && (issueOpen || run.planningIssue.qa?.length === 0 || run.planningIssue.qa?.some(item => item.previousAnswer))) $('#review-banner').hidden = true;
  syncSourceChanges();
  $('#event-count').textContent = run?.events?.length || 0;
  $('#task-count').textContent = run?.tasks?.length || 0;
  $('#artifact-count').textContent = run?.artifacts?.length || 0;
}
function renderWorkflow() {
  const edge = (from, to, path) => `<path class="flow-edge ${escape(stageOf(to)?.status || 'pending')}" d="${path}" marker-end="url(#arrow-${escape(stageOf(to)?.status || 'pending')})"/>`;
  const markers = ['pending', 'running', 'succeeded', 'failed', 'blocked'].map((status) => `<marker id="arrow-${status}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z" fill="${({ running: '#6480e5', succeeded: '#7aaea1', failed: '#d4a4ac', blocked: '#d4a4ac' })[status] || '#c4cfdf'}"/></marker>`).join('');
  const html = `<svg class="flow-edges" viewBox="0 0 1000 292" preserveAspectRatio="none" aria-hidden="true"><defs>${markers}</defs>${edge('intake', 'spec', 'M165 149H200')}${edge('spec', 'architecture', 'M350 149H375V69H400')}${edge('spec', 'tasks', 'M350 149H375V229H400')}${edge('architecture', 'review', 'M550 69H590V149H620')}${edge('tasks', 'review', 'M550 229H590V149')}${edge('review', 'export', 'M770 149H820')}</svg>${STAGES.map((fallback, i) => {
    const stage = stageOf(fallback.id) || { ...fallback, status: 'pending', attempt: 0 };
    const specWaiting = fallback.id === 'spec' && specClarificationPending();
    const waiting = specWaiting ? '等待补充需求' : fallback.id === 'export' && state.run?.status === 'awaiting_review' ? '等待计划确认' : ['architecture', 'tasks'].includes(fallback.id) && state.run?.status === 'awaiting_spec' ? specClarificationPending() ? '等待补充需求' : '等待规格确认' : '';
    const visualStatus = specWaiting ? 'awaiting_spec' : stage.status;
    const completed = stage.status === 'succeeded' && !specWaiting;
    return `<button class="flow-node ${escape(visualStatus)} ${waiting ? 'awaiting-confirmation' : ''} ${state.stageId === stage.id ? 'selected' : ''}" style="--x:${fallback.x}%;--y:${fallback.y}px" data-stage="${escape(stage.id)}" data-focus-key="stage-${escape(stage.id)}" aria-pressed="${state.stageId === stage.id}" aria-label="${escape(stage.title)}，${escape(waiting || STATUS[stage.status] || stage.status)}"><span class="node-top"><span class="node-number">${String(i + 1).padStart(2, '0')}</span><span class="node-status-dot">${completed ? '✓' : ''}</span></span><h3>${escape(stage.title)}</h3><span class="node-meta">${escape(waiting || STATUS[stage.status] || stage.status)}${stage.attempt > 1 ? ` / 第 ${stage.attempt} 次` : ''}</span></button>`;
  }).join('')}`;
  replacePreservingFocus($('#workflow-graph'), html);
}
function renderInspector() {
  const fallback = STAGES.find((stage) => stage.id === state.stageId) || STAGES[0];
  const stage = stageOf(fallback.id) || { ...fallback, status: 'pending', attempt: 0 };
  const artifacts = state.run?.artifacts?.filter((artifact) => artifact.stageId === stage.id) || [];
  const specWaiting = stage.id === 'spec' && specClarificationPending();
  const visualStatus = specWaiting ? 'awaiting_spec' : stage.status;
  const visualLabel = specWaiting ? '等待补充需求' : STATUS[stage.status] || stage.status;
  const outputHtml = specWaiting ? '等待补充后生成最终规格' : artifacts.length ? artifacts.map((artifact) => `<button class="inspector-artifact-link" data-artifact="${escape(artifact.name)}" data-focus-key="inspector-${escape(artifact.name)}">${escape(artifact.name)}</button>`).join('') : escape(fallback.output);
  const note = state.run?.status === 'awaiting_spec' && ['spec', 'architecture', 'tasks'].includes(stage.id) ? specClarificationPending() ? '打开「查看问题」处理待确认的信息。' : '确认规格后才会生成架构和任务。' : stage.id === 'export' && state.run?.status === 'awaiting_review' ? `检查下方计划后，点击“${state.run?.workflowVersion === 2 ? '确认计划并导出' : '确认并导出'}”继续。` : stage.status === 'blocked' ? '前置阶段尚未成功。解决失败并重试后，编排器会重新检查依赖。' : stage.status === 'succeeded' ? '本阶段结果已保存。后续重试会保留成功分支。' : '每个阶段成功后发布产物；下游只读取已成功的结果。';
  const failure = stage.id === 'spec' ? state.run?.specificationFailure : ['architecture', 'tasks'].includes(stage.id) ? state.run?.engineeringFailure : null;
  const failureDetail = failure?.detail && failure.detail !== failure.message ? ` ${failure.detail}` : '';
  const failureText = failure ? `${failure.message}${failureDetail} ${failure.nextStep}` : stage.error;
  const retryDisabled = state.busy || failure?.canRetry === false;
  const retryLabel = failure?.pending ? '前次请求待核对' : failure?.canRetry === false ? failure.remaining === 0 ? '调用次数已用尽' : '工程总时长已用尽' : '重试此阶段';
  const recovery = failure?.canRevalidate ? `<button class="button button-primary" ${stage.id === 'spec' ? `data-revalidate-spec="${escape(failure.attemptId)}"` : 'data-revalidate-engineering'} ${state.busy ? 'disabled' : ''}>${stage.id === 'spec' ? '重新校验已保存响应（不调用模型）' : '重新校验保存的工程草案（不调用模型）'}</button>` : '';
  const localRecovery = failure?.canUseLocal ? `<button class="button button-outline" data-use-local-engineering ${state.busy ? 'disabled' : ''}>改用本地规则生成架构与任务（不调用模型）</button>` : '';
  const html = `<div class="inspector-eyebrow"><span>阶段详情</span><span class="status-tag status-${escape(visualStatus)}">${escape(visualLabel)}</span></div><h3 class="inspector-title">${escape(stage.title)}</h3><p class="inspector-description">${escape(fallback.description)}</p><dl class="inspector-info"><dt>前置依赖</dt><dd>${stage.dependsOn.length ? stage.dependsOn.map((id) => escape(stageTitle(id))).join('、') : '无，可直接启动'}</dd><dt>尝试次数</dt><dd>${stage.attempt || '尚未执行'}</dd><dt>执行用时</dt><dd>${duration(stage)}</dd><dt>输出产物</dt><dd>${outputHtml}</dd></dl>${stage.error ? `<div class="stage-error">${escape(failureText)}${recovery}${localRecovery}${state.run?.status === 'failed' && stage.status === 'failed' ? `<button class="button button-outline" data-retry="${escape(stage.id)}" data-focus-key="retry-${escape(stage.id)}" ${retryDisabled ? 'disabled' : ''}>${escape(retryLabel)}</button>` : ''}</div>` : ''}<p class="inspector-note">${escape(note)}</p>`;
  replacePreservingFocus($('#stage-inspector'), html);
  if (historicalRun() || automaticOwnsRun()) $$('[data-retry], [data-revalidate-spec], [data-revalidate-engineering], [data-use-local-engineering]', $('#stage-inspector')).forEach(button => { button.disabled = true; });
}
function emptyContent(icon, title, description) { return `<div class="empty-records">${ICONS[icon] || ICONS.log}<strong>${escape(title)}</strong><p>${escape(description)}</p></div>`; }
function renderEvents() {
  const events = state.run?.events || [];
  if (!events.length) return emptyContent('log', '每一步都将在这里留下记录', '开始编排后，查看阶段执行、失败原因与操作结果。');
  return `<div class="event-list">${events.slice(-200).map((event) => `<div class="event-row"><span class="event-icon ${escape(event.level)}">${event.level === 'success' ? '✓' : event.level === 'error' ? '!' : '·'}</span><time class="event-time" datetime="${escape(event.time)}">${escape(formatTime(event.time))}</time><span class="event-stage">${escape(event.stageId ? stageTitle(event.stageId) : '运行控制')}</span><p class="event-message">${escape(event.message)}</p></div>`).join('')}</div>`;
}
function taskLayout(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const levels = new Map(); const visiting = new Set();
  function getLevel(id) {
    if (levels.has(id)) return levels.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const task = byId.get(id);
    const level = Math.max(0, ...(task?.dependsOn || []).filter((dependency) => byId.has(dependency)).map((dependency) => getLevel(dependency) + 1));
    visiting.delete(id); levels.set(id, level); return level;
  }
  const counts = new Map(); const positions = new Map();
  for (const task of tasks) { const level = getLevel(task.id); const row = counts.get(level) || 0; positions.set(task.id, { x: 24 + level * 230, y: 22 + row * 110 }); counts.set(level, row + 1); }
  return { positions, width: Math.max(750, (Math.max(...levels.values()) + 1) * 230 + 24), height: Math.max(280, Math.max(...counts.values()) * 110 + 26) };
}
function renderTasks() {
  const simulation = simulatedTasks.selection(), preview = simulation ? null : planningReview.taskDraft();
  const owner = !state.health?.teamAccess?.enabled || state.actorRole === 'owner';
  const editable = owner && !simulation && !historicalRun() && !automaticOwnsRun() && canEditPlanTasks(state.run);
  const note = preview ? '蓝色是改动的任务，橙色是需要一起核对的下游任务。' : !owner ? '当前账户只能查看任务。' : simulation ? '正在查看模拟记录。请返回开发任务图修改计划。'
    : historicalRun() ? '历史需求版本只读。' : editable && state.run.status === 'succeeded' ? '修改后保存为新计划版本，再重新确认计划和验收清单。' : editable ? '选中任务即可修改。' : '计划生成并进入审阅后可以修改任务。';
  const toolbar = `<div class="task-change-toolbar"><div><strong>开发任务</strong><p>${note}</p></div><div>${simulation ? '<button type="button" class="button button-outline" data-return-task-plan>返回任务计划</button>' : ''}<button type="button" class="button button-outline" data-edit-selected-task ${!editable || state.busy || state.selectionPending ? 'disabled' : ''}>修改此任务</button><button type="button" class="button button-primary" data-add-feature ${!owner || !state.project || state.busy || state.selectionPending ? 'disabled' : ''}>新增功能</button></div></div>`;
  return toolbar + renderTaskWorkspace();
}
function renderTaskWorkspace() {
  const simulation = simulatedTasks.selection();
  const preview = simulation ? null : planningReview.taskDraft();
  const tasks = simulation ? simulation.tasks.map(task => task.definition) : preview?.tasks || state.run?.tasks || [];
  if (!tasks.length) return emptyContent('graph', '开发任务将在这里展开', '任务拆解完成后，可检查依赖关系、验收条件与需求来源。');
  if (!tasks.some((task) => task.id === state.taskId)) state.taskId = tasks[0].id;
  const selected = tasks.find((task) => task.id === state.taskId);
  const layout = taskLayout(tasks);
  const paths = tasks.flatMap((task) => (task.dependsOn || []).filter((id) => layout.positions.has(id)).map((id) => {
    const from = layout.positions.get(id); const to = layout.positions.get(task.id);
    const x1 = from.x + 196, x2 = to.x, y1 = from.y + 44, y2 = to.y + 44;
    return `<path class="task-edge" d="M${x1} ${y1}C${x1 + 30} ${y1},${x2 - 30} ${y2},${x2} ${y2}" marker-end="url(#task-arrow)"/>`;
  })).join('');
  const nodes = tasks.map((task) => { const pos = layout.positions.get(task.id), changed = preview?.changedIds.includes(task.id), downstream = preview?.downstreamIds.includes(task.id); return `<button class="dev-task ${simulation ? 'sim-' + simulation.tasks.find(item => item.id === task.id)?.status : ''} ${changed ? 'draft-changed' : downstream ? 'draft-downstream' : ''} ${task.id === state.taskId ? 'selected' : ''}" style="left:${pos.x}px;top:${pos.y}px" data-task="${escape(task.id)}" data-focus-key="task-${escape(task.id)}" aria-pressed="${task.id === state.taskId}"><span class="dev-task-top"><span>${escape(task.id)}</span><span>${escape(simulation ? SIM_STATUS[simulation.tasks.find(item => item.id === task.id)?.status] : changed ? '未保存改动' : downstream ? '下游待核对' : task.category || '开发')}</span></span><span class="dev-task-title">${escape(task.title)}</span></button>`; }).join('');
  const sources = (selected.requirementIds || []).map((id) => (simulation?.spec ?? state.run.spec)?.requirements?.find((requirement) => requirement.id === id)).filter(Boolean);
  const boundary = [['计划修改范围', selected.writePaths], ['输入资料', selected.inputs?.length ? selected.inputs : ['当前计划未明确输入资料，请结合前置任务与规格来源核对。']], ['预期产出', selected.outputs?.length ? selected.outputs : ['当前计划未明确输出，请结合目标与验收条件核对。']]]
    .filter(([, values]) => Array.isArray(values) && values.length).map(([label, values]) => `<h4>${label}</h4><ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul>`).join('');
  return `<div class="task-workspace"><div class="task-graph-zone"><div class="task-caption">开发任务依赖图 / ${tasks.length} 个任务 / ${simulation ? '模拟运行 · 不代表真实软件验收' : '待实施计划'} / 点击查看状态、验收与来源</div><div class="task-graph-scroll"><div class="task-graph" style="width:${layout.width}px;height:${layout.height}px"><svg class="task-edges" width="${layout.width}" height="${layout.height}" aria-hidden="true"><defs><marker id="task-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#bfccdf"/></marker></defs>${paths}</svg>${nodes}</div></div></div><aside class="task-detail"><p class="task-detail-id">${escape(selected.id)} / ${escape(selected.category || '开发任务')}</p><h3>${escape(selected.title)}</h3><p>${escape(selected.description)}</p>${simulatedTasks.detail(selected.id)}<h4>前置任务</h4><div>${selected.dependsOn?.length ? selected.dependsOn.map((id) => `<button class="pill" data-task="${escape(id)}">${escape(id)}</button>`).join('') : '<span class="pill">无前置任务</span>'}</div><h4>验收条件</h4><ul>${(selected.acceptance || []).map((item) => `<li>${escape(item)}</li>`).join('')}</ul>${selected.suggestedFiles?.length ? `<h4>建议文件</h4><div>${selected.suggestedFiles.map((file) => `<span class="pill">${escape(file)}</span>`).join('')}</div>` : ''}${boundary}<h4>需求来源</h4>${sources.length ? sources.map((source) => `<div class="task-source-quote"><strong>${escape(source.id)} ${escape(source.title)}</strong><br>${escape(source.sourceQuote || source.description)}</div>`).join('') : '<p>基础工程或集成验证任务</p>'}</aside></div>`;
}
function inlineMarkdown(text) {
  return escape(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function renderMarkdown(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let html = ''; let index = 0;
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const code = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      index++; html += `<pre><code>${escape(code.join('\n'))}</code></pre>`; continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { html += `<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`; index++; continue; }
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[index + 1])) {
      const headers = cells(line); index += 2; const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]));
      html += `<div class="md-table-scroll"><table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, i) => `<td>${inlineMarkdown(row[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        const value = lines[index++].replace(/^\s*[-*+]\s+/, ''); const checkbox = value.match(/^\[([ xX])\]\s*(.*)$/);
        items.push(`<li>${checkbox ? `<span class="md-checkbox ${checkbox[1] !== ' ' ? 'checked' : ''}" aria-label="${checkbox[1] !== ' ' ? '已完成' : '待完成'}">${checkbox[1] !== ' ' ? '✓' : ''}</span>${inlineMarkdown(checkbox[2])}` : inlineMarkdown(value)}</li>`);
      }
      html += `<ul>${items.join('')}</ul>`; continue;
    }
    if (/^\s*\d+[.)、]\s+/.test(line)) {
      const items = []; while (index < lines.length && /^\s*\d+[.)、]\s+/.test(lines[index])) items.push(`<li>${inlineMarkdown(lines[index++].replace(/^\s*\d+[.)、]\s+/, ''))}</li>`);
      html += `<ol>${items.join('')}</ol>`; continue;
    }
    if (/^>\s?/.test(line)) { html += `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`; index++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { index++; continue; }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*```|\s*[-*+]\s|\s*\d+[.)、]\s|>)/.test(lines[index]) && !(lines[index].includes('|') && lines[index + 1]?.includes('---'))) paragraph.push(lines[index++]);
    html += `<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`;
  }
  return html;
}
function renderArtifacts() {
  const artifacts = state.run?.artifacts || [];
  if (!artifacts.length) return emptyContent('document', '生成的文档会保存在这里', '规格、架构、task.md 与校验结果可以预览并单独下载。');
  if (!artifacts.some((artifact) => artifact.name === state.artifactName)) state.artifactName = artifacts[0].name;
  const selected = artifacts.find((artifact) => artifact.name === state.artifactName);
  const isJson = selected.name.endsWith('.json');
  return `<div class="artifact-workspace"><nav class="artifact-list" aria-label="生成文档">${artifacts.map((artifact) => `<button class="artifact-item ${artifact.name === state.artifactName ? 'active' : ''}" data-artifact="${escape(artifact.name)}" data-focus-key="artifact-${escape(artifact.name)}" aria-pressed="${artifact.name === state.artifactName}">${ICONS.document}<div><strong>${escape(artifact.name)}</strong><span>${escape(artifact.title || stageTitle(artifact.stageId))}</span></div></button>`).join('')}</nav><div class="artifact-main"><div class="artifact-toolbar"><span>${escape(selected.title || selected.name)}</span><div class="artifact-actions">${!isJson ? `<button class="text-button" id="toggle-raw" data-focus-key="toggle-raw">${state.raw ? '阅读预览' : 'Markdown 原文'}</button>` : ''}<a href="${basePath()}/artifacts/${encodeURIComponent(selected.name)}?download=1" download="${escape(selected.name)}">下载文件</a></div></div><div class="artifact-content">${state.raw || isJson ? `<pre class="artifact-raw">${escape(selected.content)}</pre>` : `<article class="markdown">${renderMarkdown(selected.content)}</article>`}</div></div></div>`;
}
function renderRecords() {
  for (const button of $$('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
  $('#records-body').setAttribute('aria-labelledby', state.tab === 'tasks' ? 'records-tab-tasks' : `tab-${state.tab}`);
  $('#records-hint').textContent = ({ events: '执行状态与操作记录', tasks: '待实施计划与独立模拟运行（非真实验收）', artifacts: '可阅读、可交接的项目产物' })[state.tab];
  const oldEvents = $('.event-list'); const followEvents = !oldEvents || oldEvents.scrollHeight - oldEvents.scrollTop - oldEvents.clientHeight < 45;
  const savedScroll = {};
  for (const name of ['event-list', 'task-graph-scroll', 'task-detail', 'artifact-content', 'artifact-list']) { const element = $(`.${name}`); if (element) savedScroll[name] = { x: element.scrollLeft, y: element.scrollTop }; }
  replacePreservingFocus($('#records-body'), state.tab === 'tasks' ? renderTasks() : state.tab === 'artifacts' ? renderArtifacts() : renderEvents());
  for (const [name, pos] of Object.entries(savedScroll)) { const element = $(`.${name}`); if (element) { element.scrollLeft = pos.x; element.scrollTop = pos.y; } }
  if (state.tab === 'events' && followEvents && $('.event-list')) $('.event-list').scrollTop = $('.event-list').scrollHeight;
}
function renderRun() { renderControls(); renderWorkflow(); renderInspector(); renderRecords(); syncExecutionPanel(); syncSimulatedTasks(); workspaceLayout.sync(); renderDeliveryProgress(); notices.syncContext(); notices.failure(state.run); }
function renderAll() { renderProjects(); renderHeader(); renderRun(); }

function setBusy(value) { state.busy = value; renderControls(); workspaceLayout.sync(); renderWorkspaceContext(); $('#create-project-button').disabled = value; $('#create-project-button').textContent = value ? '正在创建…' : '创建项目'; $$('[data-close-dialog]', $('#project-dialog')).forEach((button) => { button.disabled = value; }); }
function rememberSelection() {
  try { sessionStorage.setItem('taskflow-selection', JSON.stringify({ projectId: state.project?.id, runId: state.run?.id, taskId: state.taskId })); } catch { /* The current view remains usable without session storage. */ }
}
function selectedSource() { return state.run?.sourceSnapshot ?? state.project?.source; }
function updateRun(run) {
  const previousStatus = state.run?.status;
  const previousAutomaticStatus = state.run?.automaticDelivery?.status;
  state.run = run;
  if (state.project) { const i = state.project.runs.findIndex((item) => item.id === run.id); if (i === -1) state.project.runs.push(run); else state.project.runs[i] = run; }
  rememberSelection();
  if (run.status === 'failed' && previousStatus !== 'failed') state.stageId = run.stages.find((stage) => stage.status === 'failed')?.id || state.stageId;
  if (previousStatus !== run.status || previousAutomaticStatus !== run.automaticDelivery?.status) renderHeader();
  renderRun();
  if (previousStatus !== run.status || previousAutomaticStatus !== run.automaticDelivery?.status) refreshProjects().catch(() => {});
}
function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (state.run && (automaticOwnsRun() || state.run.status === 'running' || state.run.stages?.some((stage) => stage.status === 'running'))) {
    state.pollTimer = setTimeout(pollRun, automaticClarifying() ? 1600 : 650);
  } else {
    const automatic = automaticStatus();
    if (automatic?.status === 'completed' || automatic?.status === 'failed' && automatic.stage === 'verification') state.pollTimer = setTimeout(pollRun, 3000);
  }
}
async function pollRun() {
  const epoch = state.epoch; const id = state.run?.id;
  if (!id || !state.project) return;
  const base = basePath();
  try {
    const [{ run }, automatic] = await Promise.all([api(base), state.run.automaticDelivery && !historicalRun() ? api(`${base}/automatic-delivery`, { cache: 'no-store' }) : null]);
    if (epoch !== state.epoch || id !== state.run?.id) return;
    if (automatic?.enabled === true) state.automatic = { runId: id, result: automatic };
    updateRun(run); schedulePoll();
  } catch (error) { if (epoch !== state.epoch) return; showError(error); state.pollTimer = setTimeout(pollRun, 2500); }
}
async function refreshProjects() { const { projects } = await api('/api/projects'); state.projects = projects; renderProjects(); }
async function deleteProject(id) {
  if (state.busy || state.selectionPending) return;
  const project=state.projects.find(p=>p.id===id); if(!project) return;
  if(!window.confirm(`确认删除项目“${project.name}”？项目将从工作区移除，运行记录不再可访问。本机保留恢复记录；正在运行或预览的项目不能删除。`)) return;
  setBusy(true);clearError();clearTimeout(state.pollTimer);const epoch=++state.epoch;
  try {
    const result=await api(`/api/projects/${encodeURIComponent(id)}`,{method:'DELETE',body:JSON.stringify({confirmationName:project.name})});
    if(epoch!==state.epoch)return;
    try {
      for(const runId of result.runIds || []) {
        for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key?.startsWith(`taskflow-review:${runId}:`))sessionStorage.removeItem(key);}
      }
    } catch { /* Server deletion succeeds even if browser storage is unavailable. */ }
    state.projects=state.projects.filter(p=>p.id!==id);
    if(state.project?.id===id){state.project=null;state.run=null;state.taskId=null;try{sessionStorage.removeItem('taskflow-selection');}catch{}renderAll();if(state.projects.length)await selectProject(state.projects[0].id);}
    else renderProjects();
    $('#project-title').setAttribute('tabindex','-1');$('#project-title').focus();
    toast('项目已删除，本机恢复记录已保留');
  } catch(error) {showError(error);}
  finally {setBusy(false);schedulePoll();}
}

async function selectProject(id, { runId } = {}) {
  clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  state.selectionPending = true; renderControls(); syncExecutionPanel();
  try {
    const { project } = await api(`/api/projects/${encodeURIComponent(id)}`);
    if (epoch !== state.epoch) return;
    state.selectionPending = false; state.automatic = null;
    state.project = { ...project, runs: project.runs || [] }; state.run = state.project.runs.find((run) => run.id === runId) || sortedRuns()[0] || null;
    rememberSelection();
    state.stageId = state.run?.status === 'failed' ? state.run.stages.find((stage) => stage.status === 'failed')?.id || 'spec' : 'spec';
    state.taskId = null; state.artifactName = 'task.md'; clearError(); renderAll(); schedulePoll();
  } catch (error) { if (epoch === state.epoch) showError(error); }
  finally { if (epoch === state.epoch) { state.selectionPending = false; renderHeader(); renderControls(); syncExecutionPanel(); schedulePoll(); } }
}
async function selectRun(id) {
  clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  state.selectionPending = true; renderControls(); syncExecutionPanel();
  try { const { run } = await api(`/api/projects/${encodeURIComponent(state.project.id)}/runs/${encodeURIComponent(id)}`); if (epoch !== state.epoch) return; state.selectionPending = false; state.automatic = null; state.artifactName = 'task.md'; state.taskId = null; updateRun(run); renderHeader(); schedulePoll(); }
  catch (error) { if (epoch === state.epoch) showError(error); }
  finally { if (epoch === state.epoch) { state.selectionPending = false; renderHeader(); renderControls(); syncExecutionPanel(); schedulePoll(); } }
}
async function startRun(expectedSource, { automatic = false } = {}) {
  if (!state.project || state.busy || state.selectionPending || (!historicalRun() && ACTIVE.has(state.run?.status))) return;
  if ($(automatic ? '#start-automatic' : '#start-run').disabled) return;
  workspaceLayout.show('plan');
  clearError(); setBusy(true); clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  state.selectionPending = true; syncExecutionPanel();
  try {
    const source = expectedSource || { revision: state.project.currentSourceRevision, generation: state.project.sourceGeneration };
    const options = { mode: automatic ? 'model' : $('#mode-select').value, expectedSourceRevision: source.revision, expectedSourceGeneration: source.generation };
    if (automatic) options.automaticDelivery = { modelUsageConfirmed: true };
    else if ($('#failure-select').value) options.failOnceStage = $('#failure-select').value;
    const { run } = await api(`/api/projects/${encodeURIComponent(state.project.id)}/runs`, { method: 'POST', body: JSON.stringify(options) });
    if (epoch !== state.epoch) return;
    state.selectionPending = false;
    state.stageId = 'intake'; state.taskId = null; state.artifactName = 'task.md'; state.tab = 'events';
    updateRun(run); renderHeader(); schedulePoll(); toast(automatic ? '已启动自动交付，正在处理需求。' : '编排已启动，可以点击节点查看过程');
  } catch (error) { if (epoch === state.epoch) showError(error); }
  finally { if (epoch === state.epoch) { state.selectionPending = false; syncExecutionPanel(); schedulePoll(); } setBusy(false); }
}
async function retryAutomaticVerification({ planRevision, updatedAt }) {
  if (state.busy || state.selectionPending) return;
  setBusy(true); clearError(); clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  try {
    await api(`${basePath()}/automatic-delivery/retry-verification`, { method: 'POST', body: JSON.stringify({ modelUsageConfirmed: true, planRevision, updatedAt }) });
    if (epoch === state.epoch) toast('已请求在当前计划上继续验收准备。');
  } catch (error) {
    if (epoch === state.epoch) showError(error, 'verification');
  } finally {
    if (epoch === state.epoch) state.automatic = null;
    setBusy(false);
    if (epoch === state.epoch) {
      renderRun();
      void pollRun();
    }
  }
}
async function runAction(action, stageId) {
  if (!state.run || historicalRun() || state.busy || state.selectionPending || automaticOwnsRun()) return;
  setBusy(true); clearError(); clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  try {
    const { run } = await api(`${basePath()}/action`, { method: 'POST', body: JSON.stringify({ action, ...(stageId ? { stageId } : {}), ...(action === 'approve' ? { feedback: state.feedback } : {}) }) });
    if (epoch !== state.epoch) return;
    updateRun(run); schedulePoll();
    toast(({ pause: '已请求暂停，当前阶段完成后暂停推进', resume: '已恢复执行', retry: '已重试失败阶段，成功分支将保留', approve: '已确认计划，正在生成交接文档' })[action]);
  } catch (error) { if (epoch === state.epoch) { showError(error); schedulePoll(); } }
  finally { setBusy(false); renderInspector(); }
}

async function reviewAction(action, payload) {
  if (historicalRun()) throw new Error('这次运行属于历史需求输入，不能再修订或确认。请基于当前输入重新编排。');
  if (!state.run || state.busy || state.selectionPending) throw new Error('上一项操作或运行切换尚未结束，请稍后重试。');
  if (automaticOwnsRun() && (!automaticClarifying() || !['answer_planning_issue', 'clarify_spec', 'revise_spec', 'supplement_spec'].includes(action))) {
    throw new Error('当前运行由自动交付推进。需要补充需求时，请在「查看问题」提交回答。');
  }
  setBusy(true); clearError(); clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  try {
    const { run } = await api(`${basePath()}/action`, { method: 'POST', body: JSON.stringify({ action, ...payload }) });
    if (epoch !== state.epoch) throw new Error('当前运行已切换。草稿已保留，请重新核对所选记录。');
    updateRun(run); renderHeader(); schedulePoll();
    return run;
  } finally { if (epoch === state.epoch) schedulePoll(); setBusy(false); }
}

function openProjectDialog({ sample = false, revise = false } = {}) {
  if (state.busy) return;
  $('#project-form').reset(); state.importFile = null; state.filename = 'requirements.md';
  $('#selected-file').hidden = true; $('#source-input').hidden = false; $('#docx-note').hidden = true; $('#import-error').hidden = true;
  if (revise && state.project) { $('#project-name-input').value = `${state.project.name} 新版本`; $('#source-input').value = selectedSource().content; }
  if (sample) loadSample();
  $('#project-dialog').showModal(); if (!sample && !revise) $('#source-input').focus();
}
function loadSample() {
  state.importFile = null; state.filename = 'issue-tracker.md';
  $('#project-name-input').value = '工单协作系统'; $('#source-input').value = SAMPLE;
  $('#source-input').hidden = false; $('#docx-note').hidden = true; $('#selected-file').hidden = true; $('#file-input').value = ''; $('#import-error').hidden = true;
}
function resetFile() { state.importFile = null; state.filename = 'requirements.md'; $('#file-input').value = ''; $('#selected-file').hidden = true; $('#source-input').hidden = false; $('#docx-note').hidden = true; }
async function importFile(file) {
  if (!file) return;
  $('#import-error').hidden = true;
  if (!/\.(md|txt|docx)$/i.test(file.name)) { $('#import-error').textContent = '请选择 Markdown、TXT 或 DOCX 文件。'; $('#import-error').hidden = false; return; }
  if (file.size > 3 * 1024 * 1024) { $('#import-error').textContent = '文件超过 3 MB，请缩小文件后重新上传。'; $('#import-error').hidden = false; return; }
  try {
    state.filename = file.name; state.importFile = /\.docx$/i.test(file.name) ? file : null;
    if (!$('#project-name-input').value.trim()) $('#project-name-input').value = file.name.replace(/\.[^.]+$/, '');
    const isDocx = !!state.importFile; $('#source-input').hidden = isDocx; $('#docx-note').hidden = !isDocx;
    if (!isDocx) { const text = await file.text(); if (text.length > 100000) throw new Error('正文超过 100000 字符，请拆分需求文档。'); $('#source-input').value = text; }
    $('#selected-file-name').textContent = `${file.name}　${Math.max(1, Math.round(file.size / 1024))} KB`; $('#selected-file').hidden = false;
  } catch (error) { resetFile(); $('#import-error').textContent = error.message; $('#import-error').hidden = false; }
}
async function fileBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('无法读取文件，请重新选择。')); reader.readAsDataURL(file); }); }
async function createProject(event) {
  event.preventDefault(); if (state.busy) return;
  const content = $('#source-input').value;
  if (!state.importFile && !content.trim()) { $('#import-error').textContent = '请上传需求文档，或粘贴需求正文。'; $('#import-error').hidden = false; $('#source-input').focus(); return; }
  setBusy(true); $('#import-error').hidden = true;
  try {
    const payload = { name: $('#project-name-input').value.trim() || undefined, filename: state.filename };
    if (state.importFile) payload.fileBase64 = await fileBase64(state.importFile); else payload.content = content;
    const { project } = await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    $('#project-dialog').close(); await refreshProjects(); await selectProject(project.id);
    toast('需求已保存，可以开始编排。');
  } catch (error) { $('#import-error').textContent = error.message; $('#import-error').hidden = false; }
  finally { setBusy(false); }
}
function showArtifact(name) { workspaceLayout.show('tasks'); state.artifactName = name; state.tab = 'artifacts'; renderRecords(); }

$('#new-project').addEventListener('click', () => openProjectDialog());
$('#onboarding-import').addEventListener('click', () => openProjectDialog());
$('#onboarding-sample').addEventListener('click', () => openProjectDialog({ sample: true }));
$('#load-sample').addEventListener('click', loadSample);
$('#project-form').addEventListener('submit', createProject);
$('#file-input').addEventListener('change', (event) => importFile(event.target.files[0]));
$('#clear-file').addEventListener('click', resetFile);
$('#start-run').addEventListener('click', () => { void startRun(); });
function showAutomaticConsent(retry = null) {
  const { specificationMaxCalls, engineeringMaxCalls, verificationMaxAttempts, developmentTimeoutMs } = state.health.automaticDelivery;
  const budget = $('#automatic-budget');
  automaticRetryConsent = retry;
  $('#automatic-delivery-title').textContent = retry ? '从验收清单继续' : '启动自动交付';
  $('#automatic-delivery-form .dialog-body > p').textContent = retry
    ? '沿用本次已确认的规格和开发计划，保留原提案和用量记录。清单校验通过后，系统自动启动一次开发。'
    : '系统会整理需求、拟订计划与验收清单，再自动编码、测试、审查和返工。遇到必须补充的业务信息时，会在工作台显示具体问题。完成后可下载当前通过验收的源码。';
  budget.textContent = retry
    ? retry.maxAttempts ? `本轮最多新增 ${retry.maxAttempts} 次验收清单模型调用。` : '将使用已保存的合格清单继续，本轮只产生开发和审查的模型用量。'
    : `规格最多 ${specificationMaxCalls} 次，工程设计最多 ${engineeringMaxCalls} 次，验收清单最多 ${verificationMaxAttempts} 次。`;
  budget.textContent += '整体验收的编码及审查合计最多 6 次，按任务开发时合计最多 48 次。';
  if (Number.isSafeInteger(developmentTimeoutMs) && developmentTimeoutMs > 0) {
    const duration = developmentTimeoutMs % 60000 === 0 ? `${developmentTimeoutMs / 60000} 分钟` : `${developmentTimeoutMs / 1000} 秒`;
    budget.textContent += `开发阶段最多 ${duration}，包含测试、审查和返工。`;
  }
  $('#automatic-consent').checked = false;
  $('#confirm-automatic').textContent = retry ? retry.maxAttempts ? '重试验收清单' : '使用已保存清单继续' : '启动自动交付';
  $('#confirm-automatic').disabled = true;
  $('#automatic-delivery-dialog').showModal();
  $('#automatic-consent').focus();
}
$('#start-automatic').addEventListener('click', () => showAutomaticConsent());
$('#automatic-consent').addEventListener('change', event => { $('#confirm-automatic').disabled = !event.target.checked; });
$('#automatic-delivery-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('#automatic-consent').checked) return;
  const retry = automaticRetryConsent;
  if (!retry && $('#start-automatic').disabled) return;
  $('#automatic-delivery-dialog').close();
  if (retry) {
    const current = verificationRetryContext();
    if (!current || Object.entries(retry).some(([key, value]) => current[key] !== value)) {
      showError(new Error('验收轮次或计划版本已变化，请重新核对后再继续。'), 'verification');
      return;
    }
    void retryAutomaticVerification(retry);
    return;
  }
  void startRun(undefined, { automatic: true });
});
$('[data-workspace-next]').addEventListener('click', handleWorkspaceNext);
$('#delivery-steps').addEventListener('click', event => {
  const step = event.target.closest('[data-delivery-step]');
  if (step) openDeliveryStage(step.dataset.deliveryStep);
});
$('#execution-workspace-steps').addEventListener('click', event => {
  const step = event.target.closest('[data-execution-step]');
  if (step) openDeliveryStage(step.dataset.executionStep);
});
$('#task-edit-dialog').addEventListener('close', () => { if (!$('#task-edit-dialog').open) planningReview.render(); });
$('#pause-button').addEventListener('click', () => runAction(state.run?.status === 'paused' ? 'resume' : 'pause'));
$('#run-select').addEventListener('change', (event) => selectRun(event.target.value));
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#source-button').addEventListener('click', () => { if (!state.project) return; $('#source-title').textContent = selectedSource().filename; $('#source-content').textContent = selectedSource().content; $('#source-dialog').showModal(); });
$('#revise-source').addEventListener('click', () => { $('#source-dialog').close(); openSourceEditor(); });
$('#project-dialog').addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
document.addEventListener('click', event => {
  const action = event.target.closest('[data-simulation-action]');
  if (action && !action.disabled) notices.clear({ source: 'simulation' });
}, true);
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-return-task-plan]')) { simulatedTasks.showPlan(); focusWorkspaceTarget($('[data-edit-selected-task]')); return; }
  const editTask = event.target.closest('[data-edit-selected-task]'); if (editTask && !editTask.disabled) { workspaceLayout.openEditor(); if (!planningReview.openTask(state.taskId)) workspaceLayout.closeEditor(); return; }
  const addFeature = event.target.closest('[data-add-feature]'); if (addFeature && !addFeature.disabled) { void openFeatureEditor().catch(showError); return; }
  const close = event.target.closest('[data-close-dialog]'); if (close) close.closest('dialog')?.close();
  const project = event.target.closest('[data-project]'); if (project && !state.busy) selectProject(project.dataset.project);
  const stage = event.target.closest('[data-stage]'); if (stage) { state.stageId = stage.dataset.stage; renderWorkflow(); renderInspector(); }
  const task = event.target.closest('[data-task]'); if (task) { state.taskId = task.dataset.task; renderRecords(); rememberSelection(); }
  const artifact = event.target.closest('[data-artifact]'); if (artifact) showArtifact(artifact.dataset.artifact);
  const tab = event.target.closest('[data-tab]'); if (tab) { state.tab = tab.dataset.tab; renderRecords(); }
  const remove = event.target.closest('[data-delete-project]'); if(remove){ if(!remove.disabled) deleteProject(remove.dataset.deleteProject); return; }
  const recover = event.target.closest('[data-revalidate-spec]'); if (recover && !recover.disabled) { reviewAction('revalidate_spec', { attemptId: recover.dataset.revalidateSpec }).then(() => toast('已免费重新校验，请核对并确认规格')).catch(error => showError(error.message)); return; }
  const recoverEngineering = event.target.closest('[data-revalidate-engineering]'); if (recoverEngineering && !recoverEngineering.disabled) { reviewAction('revalidate_engineering', {}).then(() => toast('已重新校验保存的工程草案，正在继续架构与任务阶段')).catch(error => showError(error.message)); return; }
  const localEngineering = event.target.closest('[data-use-local-engineering]'); if (localEngineering && !localEngineering.disabled) { reviewAction('use_local_engineering', {}).then(() => toast('已改用本地规则生成架构与任务，未调用模型；请继续核对计划')).catch(error => showError(error.message)); return; }
  const retry = event.target.closest('[data-retry]'); if (retry && !retry.disabled) runAction('retry', retry.dataset.retry);
  if (event.target.closest('#toggle-raw')) { state.raw = !state.raw; renderRecords(); }
});
$('.tabs').addEventListener('keydown', (event) => {
  const tabs = $$('[data-tab]'); let index = tabs.indexOf(document.activeElement); if (index < 0) return;
  if (event.key === 'ArrowRight') index = (index + 1) % tabs.length; else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = tabs.length - 1; else return;
  event.preventDefault(); state.tab = tabs[index].dataset.tab; renderRecords(); tabs[index].focus();
});
for (const type of ['dragenter', 'dragover']) $('#drop-zone').addEventListener(type, (event) => { event.preventDefault(); $('#drop-zone').classList.add('drag-over'); });
$('#drop-zone').addEventListener('dragleave', () => $('#drop-zone').classList.remove('drag-over'));
$('#drop-zone').addEventListener('drop', (event) => { event.preventDefault(); $('#drop-zone').classList.remove('drag-over'); importFile(event.dataTransfer.files[0]); });
for (const type of ['dragover', 'drop']) window.addEventListener(type, (event) => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });

async function initialize() {
  if (state.busy) return;
  clearError();
  renderAll();
  try {
    const { model, ...health } = await api('/api/health'); state.health = { ...health, model };
    if (health.teamAccess?.enabled) {
      const session = await api('/api/team/session');
      if (!session.user) { window.location.replace('/team.html'); return; }
      state.actorRole = session.user.role;
      $('#team-link').hidden = false; $('#team-link').textContent = `${session.user.name}（${({ owner: '负责人', reviewer: '评审者', observer: '观察者' })[session.user.role] || '账号'}）`;
      $('#team-link').title = $('#team-link').textContent;
    } else $('#team-link').hidden = true;
    const { projects } = await api('/api/projects'); state.projects = projects;
    syncExecutionPanel();
    $('#connection-status').className = 'connection-status connected'; $('#connection-status').innerHTML = '<span></span>服务已连接';
    const modelOption = $('#mode-select option[value=model]'); modelOption.disabled = !model?.configured; modelOption.textContent = model?.configured ? `模型模式（${model.model || '已配置'}）` : '模型模式（未配置）';
    renderProjects();
    if (projects.length && !state.project) {
      let selection;
      try { selection = JSON.parse(sessionStorage.getItem('taskflow-selection')); } catch { /* Start with the most recently updated project. */ }
      const project = projects.find(item => item.id === selection?.projectId) || projects[0];
      await selectProject(project.id, { runId: selection?.runId });
      if (state.project?.id === selection?.projectId && state.run?.id === selection?.runId && state.run?.tasks?.some(task => task.id === selection?.taskId)) { state.taskId = selection.taskId; renderRecords(); rememberSelection(); }
    }
    else if (state.project) {
      const selectedRun = state.run?.id;
      await selectProject(state.project.id, { runId: selectedRun });
    }
  } catch (error) { $('#connection-status').className = 'connection-status disconnected'; $('#connection-status').innerHTML = '<span></span>服务未连接'; showError(new Error(`无法连接本地服务。请确认项目已启动，然后点击右上角刷新。${error.message ? `（${error.message}）` : ''}`)); }
}
$('#mode-select').addEventListener('change', renderControls);
$('#refresh-button').addEventListener('click', initialize);
initialize();
