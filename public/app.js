import { createPlanningReview } from './planning-review.js';
import { createExecutionPanel } from './execution-panel.js';
import { createSourceChanges } from './source-changes.js';
import { createVerificationPlans } from './verification-plans.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { health: null, projects: [], project: null, run: null, stageId: 'spec', taskId: null, artifactName: 'task.md', tab: 'events', raw: false, busy: false, epoch: 0, selectionPending: false, pollTimer: null, feedback: '', importFile: null, filename: 'requirements.md' };
let executionContextKey = '';
let sourceContextKey = '';
let verificationContextKey = '';
function historicalRun(run = state.run) {
  return !!run && (run.sourceSuperseded === true || (state.project?.currentSourceRevision !== undefined
    && (run.sourceRevision !== state.project.currentSourceRevision || (run.sourceGeneration ?? 0) !== state.project.sourceGeneration)));
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
const executionPanel = createExecutionPanel({ api, getContext: executionContext, onError: error => showError(error) });
void executionPanel.mount(document.querySelector('#execution-panel-host'));
function syncExecutionPanel() {
  const next = JSON.stringify(executionContext());
  if (next !== executionContextKey) { executionContextKey = next; void executionPanel.refresh(); }
}
const verificationPlans = createVerificationPlans({ api, getContext: executionContext, onError: error => showError(error) });
void verificationPlans.mount(document.querySelector('#verification-plans-host'));
function syncVerificationPlans() {
  $('#verification-plans-section').hidden = !state.run || state.selectionPending;
  const next = JSON.stringify(executionContext());
  if (next !== verificationContextKey) { verificationContextKey = next; void verificationPlans.refresh(); }
}
const sourceChanges = createSourceChanges({ api: sourceApi, getContext: () => ({ projectId: state.selectionPending ? '' : state.project?.id ?? '' }),
  onApplied: async change => { if (change.projectId !== state.project?.id || state.selectionPending) return; if (await refreshSourceProject(change.projectId, state.epoch)) toast('新需求已应用，请重新编排并确认规格和计划'); },
  onError: error => showError(error) });
void sourceChanges.mount(document.querySelector('#source-changes-host'));
function syncSourceChanges() {
  $('#source-changes-section').hidden = !state.project || state.selectionPending;
  const next = state.selectionPending ? '' : state.project?.id ?? '';
  if (next !== sourceContextKey) { sourceContextKey = next; void sourceChanges.refresh(); }
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
  const projectId = state.project?.id, epoch = state.epoch;
  const result = await api(url, options);
  // A different request may apply a source version while this page is open.
  // Re-read persisted project facts before displaying actions for its old runs.
  if ((!options?.method || options.method === 'GET') && projectId && !state.selectionPending && epoch === state.epoch && state.project?.id === projectId
    && url === `/api/projects/${encodeURIComponent(projectId)}/changes` && Number.isSafeInteger(result?.current?.generation)
    && result.current.generation !== (state.project.sourceGeneration ?? 0)) await refreshSourceProject(projectId, epoch, result.current);
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
  if (!response.ok) throw new Error(data.error || `服务请求失败（${response.status}）`);
  return data;
}
function basePath() { return `/api/projects/${encodeURIComponent(state.project.id)}/runs/${encodeURIComponent(state.run.id)}`; }
function showError(error) { $('#error-text').textContent = error?.message || String(error); $('#error-banner').hidden = false; }
function clearError() { $('#error-banner').hidden = true; }
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3600); }
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
const planningReview = createPlanningReview({
  container: $('#review-banner'), getState: () => ({ ...state, run: historicalRun() ? { ...state.run, sourceSuperseded: true } : state.run, busy: state.busy || state.selectionPending }), submit: reviewAction,
  refresh: async () => {
    const id = state.run?.id; const epoch = state.epoch;
    const { run } = await api(basePath());
    if (id === state.run?.id && epoch === state.epoch) { updateRun(run); schedulePoll(); }
  },
  showArtifact: (name) => { showArtifact(name); $('#records-body').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); },
  toast,
});

function renderProjects() {
  $('#project-count').textContent = state.projects.length;
  $('#project-list').innerHTML = state.projects.length ? state.projects.map((project) => `<button class="project-item ${project.id === state.project?.id ? 'active' : ''}" data-project="${escape(project.id)}" aria-current="${project.id === state.project?.id ? 'page' : 'false'}"><svg class="project-icon" viewBox="0 0 20 22" aria-hidden="true"><path d="M3 2h9l5 5v13H3Z"/><path d="M12 2v6h5M6 12h8M6 16h5"/></svg><span class="project-info"><span class="project-name">${escape(project.name)}</span><span class="project-meta">${escape(project.lastRunStatus ? STATUS[project.lastRunStatus] || project.lastRunStatus : '尚未编排')} / ${project.runCount || 0} 次运行</span></span><span class="project-state-dot ${escape(project.lastRunStatus || '')}"></span></button>`).join('') : '<div class="empty-projects">尚无项目<br>从一份需求文档开始</div>';
}
function renderHeader() {
  $('#project-title').textContent = state.project?.name || '需求编排工作台';
  $('#breadcrumb-project').textContent = state.project?.name || '新项目';
  $('#project-description').textContent = state.project ? `${state.project.source?.filename || '需求文档'}　${state.project.source?.content?.length?.toLocaleString('zh-CN') || 0} 字　每次编排保留独立运行记录` : '把需求整理成清晰的规格、开发任务与交接文档。';
  $('#source-button').disabled = !state.project;
  $('#onboarding').hidden = !!state.project;
  const runs = sortedRuns();
  const select = $('#run-select');
  select.innerHTML = runs.length ? runs.map((run, i) => `<option value="${escape(run.id)}" ${run.id === state.run?.id ? 'selected' : ''}>运行 ${String(runs.length - i).padStart(2, '0')}　${escape(formatTime(run.createdAt, true))}　${escape(STATUS[run.status] || run.status)}${run.workflowVersion === 2 ? '' : '（旧版记录）'}</option>`).join('') : '<option>尚无运行记录</option>';
  select.disabled = !runs.length || state.busy;
}
function renderControls() {
  const run = state.run;
  const modelNotice = $('#planning-model-notice'), modelBudget = state.health?.modelPlanning;
  modelNotice.hidden = run?.mode !== 'model' && $('#mode-select').value !== 'model';
  const knownBudget = Number.isSafeInteger(modelBudget?.engineeringMaxCalls) && modelBudget.engineeringMaxCalls > 0
    && Number.isSafeInteger(modelBudget?.engineeringTimeoutMs) && modelBudget.engineeringTimeoutMs > 0;
  const knownSpecBudget = Number.isSafeInteger(modelBudget?.specificationMaxCalls) && modelBudget.specificationMaxCalls > 0
    && Number.isSafeInteger(modelBudget?.specificationTimeoutMs) && modelBudget.specificationTimeoutMs > 0;
  modelNotice.textContent = `${run?.mode === 'model' && run.workflowVersion !== 2 ? '当前显示旧版运行，按原流程仅整理规格。' : ''}新版模型运行会发送需求以整理规格；确认规格后，还会请求工程设计并产生用量。${knownSpecBudget ? `每次运行规格整理最多尝试 ${modelBudget.specificationMaxCalls} 次，单次最多 ${modelBudget.specificationTimeoutMs / 1000} 秒。` : '当前服务未提供规格调用预算，请重启本地服务并刷新核对。'}${knownBudget ? `每次运行工程设计最多尝试 ${modelBudget.engineeringMaxCalls} 次，单次最多 ${modelBudget.engineeringTimeoutMs / 1000} 秒。` : '工程设计预算尚未获取，请刷新核对。'}架构与任务共用一次设计请求，结果仍需你审阅。`;
  const specification = run?.specificationHistory?.at(-1);
  const frozenSpecification = run?.specificationBudget;
  if (run?.mode === 'model' && knownSpecBudget && Number.isSafeInteger(frozenSpecification?.maxCalls) && frozenSpecification.maxCalls > 0
    && Number.isSafeInteger(frozenSpecification.timeoutMs) && frozenSpecification.timeoutMs > 0) modelNotice.textContent += ` 当前运行规格整理上限：${Math.min(modelBudget.specificationMaxCalls, frozenSpecification.maxCalls)} 次、每次 ${Math.min(modelBudget.specificationTimeoutMs, frozenSpecification.timeoutMs) / 1000} 秒；已尝试 ${Number.isSafeInteger(run.specificationCalls) ? run.specificationCalls : '未知'} 次。`;
  if (specification) modelNotice.textContent += ` 最近规格：${({ running: '处理中', succeeded: '规格已整理', failed: '失败', interrupted: '已中断' })[specification.status] || '状态未知'}；输入 ${Number.isSafeInteger(specification.usage?.inputTokens) ? specification.usage.inputTokens : '未知'}、输出 ${Number.isSafeInteger(specification.usage?.outputTokens) ? specification.usage.outputTokens : '未知'} token。`;
  else if (run?.mode === 'model' && run.stages?.some(stage => stage.id === 'spec' && stage.attempt > 0)) modelNotice.textContent += ' 这次规格整理没有可核对的用量记录，用量为未知。';
  const design = run?.engineeringHistory?.at(-1);
  if (design) modelNotice.textContent += ` 最近设计：${({ running: '处理中', succeeded: '草案已生成', failed: '失败', interrupted: '已中断' })[design.status] || '状态未知'}；输入 ${Number.isSafeInteger(design.usage?.inputTokens) ? design.usage.inputTokens : '未知'}、输出 ${Number.isSafeInteger(design.usage?.outputTokens) ? design.usage.outputTokens : '未知'} token。`;
  const historical = historicalRun(run), active = !historical && ACTIVE.has(run?.status);
  const changing = state.busy || state.selectionPending;
  $('#start-run').disabled = !state.project || changing || active || ($('#mode-select').value === 'model' && (!knownSpecBudget || !knownBudget));
  $('#start-run span').textContent = run ? '再次编排' : '开始编排';
  $('#mode-select').disabled = changing || active;
  $('#failure-select').disabled = changing || active;
  $('#pause-button').hidden = historical || !['running', 'paused'].includes(run?.status);
  $('#pause-button').textContent = run?.status === 'paused' ? '恢复执行' : '暂停';
  $('#pause-button').disabled = changing;
  $('#refresh-button').disabled = state.busy;
  $('#run-select').disabled = !state.project?.runs?.length || state.busy;
  $('#download-bundle').hidden = run?.status !== 'succeeded';
  if (run?.status === 'succeeded') $('#download-bundle').href = `${basePath()}/download`;
  const status = run?.status || 'idle';
  $('#run-status').textContent = `${STATUS[status] || status}${historical ? ' / 历史输入，只读' : run && run.workflowVersion !== 2 ? ' / 旧版记录' : ''}`;
  $('#run-status').className = `status-tag status-${status}`;
  const count = run?.stages?.filter((stage) => stage.status === 'succeeded').length || 0;
  $('#run-progress').textContent = run ? `${count} / ${run.stages.length} 个阶段已完成${run.status === 'paused' ? '，当前任务完成后暂停' : ''}` : '导入需求后开始';
  $('#workflow-subtitle').textContent = run ? `${run.mode === 'model' ? '模型规划' : '本地规则规划'}　运行 ${run.id.slice(-8)}${run.workflowVersion === 2 ? '　两次人工确认' : '　旧版流程'}` : '六个阶段，两次确认，保留每版依据';
  $('#workflow-confirmation-legend').textContent = run && run.workflowVersion !== 2 ? '旧版流程：导出前确认' : '先确认规格，再确认计划';
  $('#source-history-notice').hidden = !historical;
  planningReview.render(); syncSourceChanges(); syncVerificationPlans();
  $('#event-count').textContent = run?.events?.length || 0;
  $('#task-count').textContent = run?.tasks?.length || 0;
  $('#artifact-count').textContent = run?.artifacts?.length || 0;
}
function renderWorkflow() {
  const edge = (from, to, path) => `<path class="flow-edge ${escape(stageOf(to)?.status || 'pending')}" d="${path}" marker-end="url(#arrow-${escape(stageOf(to)?.status || 'pending')})"/>`;
  const markers = ['pending', 'running', 'succeeded', 'failed', 'blocked'].map((status) => `<marker id="arrow-${status}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z" fill="${({ running: '#6480e5', succeeded: '#7aaea1', failed: '#d4a4ac', blocked: '#d4a4ac' })[status] || '#c4cfdf'}"/></marker>`).join('');
  const html = `<svg class="flow-edges" viewBox="0 0 1000 292" preserveAspectRatio="none" aria-hidden="true"><defs>${markers}</defs>${edge('intake', 'spec', 'M165 149H200')}${edge('spec', 'architecture', 'M350 149H375V69H400')}${edge('spec', 'tasks', 'M350 149H375V229H400')}${edge('architecture', 'review', 'M550 69H590V149H620')}${edge('tasks', 'review', 'M550 229H590V149')}${edge('review', 'export', 'M770 149H820')}</svg>${STAGES.map((fallback, i) => {
    const stage = stageOf(fallback.id) || { ...fallback, status: 'pending', attempt: 0 };
    const waiting = fallback.id === 'export' && state.run?.status === 'awaiting_review' ? '等待计划确认' : ['architecture', 'tasks'].includes(fallback.id) && state.run?.status === 'awaiting_spec' ? '等待规格确认' : '';
    return `<button class="flow-node ${escape(stage.status)} ${waiting ? 'awaiting-confirmation' : ''} ${state.stageId === stage.id ? 'selected' : ''}" style="--x:${fallback.x}%;--y:${fallback.y}px" data-stage="${escape(stage.id)}" data-focus-key="stage-${escape(stage.id)}" aria-pressed="${state.stageId === stage.id}" aria-label="${escape(stage.title)}，${escape(waiting || STATUS[stage.status] || stage.status)}"><span class="node-top"><span class="node-number">${String(i + 1).padStart(2, '0')}</span><span class="node-status-dot">${stage.status === 'succeeded' ? '✓' : ''}</span></span><h3>${escape(stage.title)}</h3><span class="node-meta">${escape(waiting || STATUS[stage.status] || stage.status)}${stage.attempt > 1 ? ` / 第 ${stage.attempt} 次` : ''}</span></button>`;
  }).join('')}`;
  replacePreservingFocus($('#workflow-graph'), html);
}
function renderInspector() {
  const fallback = STAGES.find((stage) => stage.id === state.stageId) || STAGES[0];
  const stage = stageOf(fallback.id) || { ...fallback, status: 'pending', attempt: 0 };
  const artifacts = state.run?.artifacts?.filter((artifact) => artifact.stageId === stage.id) || [];
  const note = state.run?.status === 'awaiting_spec' && ['spec', 'architecture', 'tasks'].includes(stage.id) ? '请在下方答复待确认问题并保存修订；确认规格后才会生成架构和任务。' : stage.id === 'export' && state.run?.status === 'awaiting_review' ? `检查下方计划后，点击“${state.run?.workflowVersion === 2 ? '确认计划并导出' : '确认并导出'}”继续。` : stage.status === 'blocked' ? '前置阶段尚未成功。解决失败并重试后，编排器会重新检查依赖。' : stage.status === 'succeeded' ? '本阶段结果已保存。后续重试会保留成功分支。' : '每个阶段成功后发布产物；下游只读取已成功的结果。';
  const html = `<div class="inspector-eyebrow"><span>阶段详情</span><span class="status-tag status-${escape(stage.status)}">${escape(STATUS[stage.status] || stage.status)}</span></div><h3 class="inspector-title">${escape(stage.title)}</h3><p class="inspector-description">${escape(fallback.description)}</p><dl class="inspector-info"><dt>前置依赖</dt><dd>${stage.dependsOn.length ? stage.dependsOn.map((id) => escape(stageTitle(id))).join('、') : '无，可直接启动'}</dd><dt>尝试次数</dt><dd>${stage.attempt || '尚未执行'}</dd><dt>执行用时</dt><dd>${duration(stage)}</dd><dt>输出产物</dt><dd>${artifacts.length ? artifacts.map((artifact) => `<button class="inspector-artifact-link" data-artifact="${escape(artifact.name)}" data-focus-key="inspector-${escape(artifact.name)}">${escape(artifact.name)}</button>`).join('') : escape(fallback.output)}</dd></dl>${stage.error ? `<div class="stage-error">${escape(stage.error)}${state.run?.status === 'failed' && stage.status === 'failed' ? `<button class="button button-outline" data-retry="${escape(stage.id)}" data-focus-key="retry-${escape(stage.id)}" ${state.busy ? 'disabled' : ''}>重试此阶段</button>` : ''}</div>` : ''}<p class="inspector-note">${escape(note)}</p>`;
  replacePreservingFocus($('#stage-inspector'), html);
  if (historicalRun()) $$('[data-retry]', $('#stage-inspector')).forEach(button => { button.disabled = true; });
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
  const tasks = state.run?.tasks || [];
  if (!tasks.length) return emptyContent('graph', '开发任务将在这里展开', '任务拆解完成后，可检查依赖关系、验收条件与需求来源。');
  if (!tasks.some((task) => task.id === state.taskId)) state.taskId = tasks[0].id;
  const selected = tasks.find((task) => task.id === state.taskId);
  const layout = taskLayout(tasks);
  const paths = tasks.flatMap((task) => (task.dependsOn || []).filter((id) => layout.positions.has(id)).map((id) => {
    const from = layout.positions.get(id); const to = layout.positions.get(task.id);
    const x1 = from.x + 196, x2 = to.x, y1 = from.y + 44, y2 = to.y + 44;
    return `<path class="task-edge" d="M${x1} ${y1}C${x1 + 30} ${y1},${x2 - 30} ${y2},${x2} ${y2}" marker-end="url(#task-arrow)"/>`;
  })).join('');
  const nodes = tasks.map((task) => { const pos = layout.positions.get(task.id); return `<button class="dev-task ${task.id === state.taskId ? 'selected' : ''}" style="left:${pos.x}px;top:${pos.y}px" data-task="${escape(task.id)}" data-focus-key="task-${escape(task.id)}" aria-pressed="${task.id === state.taskId}"><span class="dev-task-top"><span>${escape(task.id)}</span><span>${escape(task.category || '开发')}</span></span><span class="dev-task-title">${escape(task.title)}</span></button>`; }).join('');
  const sources = (selected.requirementIds || []).map((id) => state.run.spec?.requirements?.find((requirement) => requirement.id === id)).filter(Boolean);
  const boundary = [['计划修改范围', selected.writePaths], ['输入资料', selected.inputs], ['预期产出', selected.outputs]]
    .filter(([, values]) => Array.isArray(values) && values.length).map(([label, values]) => `<h4>${label}</h4><ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul>`).join('');
  return `<div class="task-workspace"><div class="task-graph-zone"><div class="task-caption">开发任务依赖图 / ${tasks.length} 个任务待开发 / 点击查看验收与来源</div><div class="task-graph-scroll"><div class="task-graph" style="width:${layout.width}px;height:${layout.height}px"><svg class="task-edges" width="${layout.width}" height="${layout.height}" aria-hidden="true"><defs><marker id="task-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#bfccdf"/></marker></defs>${paths}</svg>${nodes}</div></div></div><aside class="task-detail"><p class="task-detail-id">${escape(selected.id)} / ${escape(selected.category || '开发任务')}</p><h3>${escape(selected.title)}</h3><p>${escape(selected.description)}</p><h4>前置任务</h4><div>${selected.dependsOn?.length ? selected.dependsOn.map((id) => `<button class="pill" data-task="${escape(id)}">${escape(id)}</button>`).join('') : '<span class="pill">无前置任务</span>'}</div><h4>验收条件</h4><ul>${(selected.acceptance || []).map((item) => `<li>${escape(item)}</li>`).join('')}</ul>${selected.suggestedFiles?.length ? `<h4>建议文件</h4><div>${selected.suggestedFiles.map((file) => `<span class="pill">${escape(file)}</span>`).join('')}</div>` : ''}${boundary}<h4>需求来源</h4>${sources.length ? sources.map((source) => `<div class="task-source-quote"><strong>${escape(source.id)} ${escape(source.title)}</strong><br>${escape(source.sourceQuote || source.description)}</div>`).join('') : '<p>基础工程或集成验证任务</p>'}</aside></div>`;
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
  $('#records-body').setAttribute('aria-labelledby', `tab-${state.tab}`);
  $('#records-hint').textContent = ({ events: '执行状态与操作记录', tasks: '开发任务用于后续编码', artifacts: '可阅读、可交接的项目产物' })[state.tab];
  const oldEvents = $('.event-list'); const followEvents = !oldEvents || oldEvents.scrollHeight - oldEvents.scrollTop - oldEvents.clientHeight < 45;
  const savedScroll = {};
  for (const name of ['event-list', 'task-graph-scroll', 'task-detail', 'artifact-content', 'artifact-list']) { const element = $(`.${name}`); if (element) savedScroll[name] = { x: element.scrollLeft, y: element.scrollTop }; }
  replacePreservingFocus($('#records-body'), state.tab === 'tasks' ? renderTasks() : state.tab === 'artifacts' ? renderArtifacts() : renderEvents());
  for (const [name, pos] of Object.entries(savedScroll)) { const element = $(`.${name}`); if (element) { element.scrollLeft = pos.x; element.scrollTop = pos.y; } }
  if (state.tab === 'events' && followEvents && $('.event-list')) $('.event-list').scrollTop = $('.event-list').scrollHeight;
}
function renderRun() { renderControls(); renderWorkflow(); renderInspector(); renderRecords(); syncExecutionPanel(); }
function renderAll() { renderProjects(); renderHeader(); renderRun(); }

function setBusy(value) { state.busy = value; renderControls(); $('#create-project-button').disabled = value; $('#create-project-button').textContent = value ? '正在创建…' : '创建项目'; $$('[data-close-dialog]', $('#project-dialog')).forEach((button) => { button.disabled = value; }); }
function rememberSelection() {
  try { sessionStorage.setItem('taskflow-selection', JSON.stringify({ projectId: state.project?.id, runId: state.run?.id })); } catch { /* The current view remains usable without session storage. */ }
}
function selectedSource() { return state.run?.sourceSnapshot ?? state.project?.source; }
function updateRun(run) {
  const previousStatus = state.run?.status;
  state.run = run;
  if (state.project) { const i = state.project.runs.findIndex((item) => item.id === run.id); if (i === -1) state.project.runs.push(run); else state.project.runs[i] = run; }
  rememberSelection();
  if (run.status === 'failed' && previousStatus !== 'failed') state.stageId = run.stages.find((stage) => stage.status === 'failed')?.id || state.stageId;
  if (previousStatus !== run.status) renderHeader();
  renderRun();
  if (previousStatus !== run.status) refreshProjects().catch(() => {});
}
function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (state.run && (state.run.status === 'running' || state.run.stages?.some((stage) => stage.status === 'running'))) state.pollTimer = setTimeout(pollRun, 650);
}
async function pollRun() {
  const epoch = state.epoch; const id = state.run?.id;
  if (!id || !state.project) return;
  try { const { run } = await api(`${basePath()}`); if (epoch !== state.epoch || id !== state.run?.id) return; updateRun(run); schedulePoll(); }
  catch (error) { if (epoch !== state.epoch) return; showError(error); state.pollTimer = setTimeout(pollRun, 2500); }
}
async function refreshProjects() { const { projects } = await api('/api/projects'); state.projects = projects; renderProjects(); }
async function selectProject(id, { runId } = {}) {
  clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  state.selectionPending = true; renderControls(); syncExecutionPanel();
  try {
    const { project } = await api(`/api/projects/${encodeURIComponent(id)}`);
    if (epoch !== state.epoch) return;
    state.selectionPending = false;
    state.project = { ...project, runs: project.runs || [] }; state.run = state.project.runs.find((run) => run.id === runId) || sortedRuns()[0] || null;
    rememberSelection();
    state.stageId = state.run?.status === 'failed' ? state.run.stages.find((stage) => stage.status === 'failed')?.id || 'spec' : 'spec';
    state.taskId = null; state.artifactName = 'task.md'; clearError(); renderAll(); schedulePoll();
  } catch (error) { if (epoch === state.epoch) showError(error); }
  finally { if (epoch === state.epoch) { state.selectionPending = false; renderHeader(); renderControls(); syncExecutionPanel(); } }
}
async function selectRun(id) {
  clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  state.selectionPending = true; renderControls(); syncExecutionPanel();
  try { const { run } = await api(`/api/projects/${encodeURIComponent(state.project.id)}/runs/${encodeURIComponent(id)}`); if (epoch !== state.epoch) return; state.selectionPending = false; state.artifactName = 'task.md'; state.taskId = null; updateRun(run); renderHeader(); schedulePoll(); }
  catch (error) { if (epoch === state.epoch) showError(error); }
  finally { if (epoch === state.epoch) { state.selectionPending = false; renderHeader(); renderControls(); syncExecutionPanel(); } }
}
async function startRun() {
  if (!state.project || state.busy || state.selectionPending || (!historicalRun() && ACTIVE.has(state.run?.status))) return;
  if ($('#start-run').disabled) return;
  clearError(); setBusy(true); clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  state.selectionPending = true; syncExecutionPanel();
  try {
    const options = { mode: $('#mode-select').value }; if ($('#failure-select').value) options.failOnceStage = $('#failure-select').value;
    const { run } = await api(`/api/projects/${encodeURIComponent(state.project.id)}/runs`, { method: 'POST', body: JSON.stringify(options) });
    if (epoch !== state.epoch) return;
    state.selectionPending = false;
    state.stageId = 'intake'; state.taskId = null; state.artifactName = 'task.md'; state.tab = 'events';
    updateRun(run); renderHeader(); schedulePoll(); toast('编排已启动，可以点击节点查看过程');
  } catch (error) { if (epoch === state.epoch) showError(error); }
  finally { if (epoch === state.epoch) { state.selectionPending = false; syncExecutionPanel(); } setBusy(false); }
}
async function runAction(action, stageId) {
  if (!state.run || historicalRun() || state.busy || state.selectionPending) return;
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
  setBusy(true); clearError(); clearTimeout(state.pollTimer); const epoch = ++state.epoch;
  try {
    const { run } = await api(`${basePath()}/action`, { method: 'POST', body: JSON.stringify({ action, ...payload }) });
    if (epoch !== state.epoch) throw new Error('当前运行已切换。草稿已保留，请重新核对所选记录。');
    updateRun(run); renderHeader(); schedulePoll();
    return run;
  } finally { setBusy(false); }
}

function openProjectDialog({ sample = false, revise = false } = {}) {
  if (state.busy) return;
  $('#project-form').reset(); state.importFile = null; state.filename = 'requirements.md';
  $('#selected-file').hidden = true; $('#source-input').hidden = false; $('#docx-note').hidden = true; $('#import-error').hidden = true;
  if (revise && state.project) { $('#project-name-input').value = `${state.project.name} 新版本`; $('#source-input').value = selectedSource().content; }
  if (sample) loadSample();
  $('#project-dialog').showModal(); if (!sample && !revise) $('#project-name-input').focus();
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
    $('#project-dialog').close(); await refreshProjects(); await selectProject(project.id); toast('项目已创建，点击“开始编排”生成开发计划');
  } catch (error) { $('#import-error').textContent = error.message; $('#import-error').hidden = false; }
  finally { setBusy(false); }
}
function showArtifact(name) { state.artifactName = name; state.tab = 'artifacts'; renderRecords(); }

$('#new-project').addEventListener('click', () => openProjectDialog());
$('#onboarding-import').addEventListener('click', () => openProjectDialog());
$('#onboarding-sample').addEventListener('click', () => openProjectDialog({ sample: true }));
$('#load-sample').addEventListener('click', loadSample);
$('#project-form').addEventListener('submit', createProject);
$('#file-input').addEventListener('change', (event) => importFile(event.target.files[0]));
$('#clear-file').addEventListener('click', resetFile);
$('#start-run').addEventListener('click', startRun);
$('#pause-button').addEventListener('click', () => runAction(state.run?.status === 'paused' ? 'resume' : 'pause'));
$('#run-select').addEventListener('change', (event) => selectRun(event.target.value));
$('#dismiss-error').addEventListener('click', clearError);
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#source-button').addEventListener('click', () => { if (!state.project) return; $('#source-title').textContent = selectedSource().filename; $('#source-content').textContent = selectedSource().content; $('#source-dialog').showModal(); });
$('#revise-source').addEventListener('click', () => { $('#source-dialog').close(); const section = $('#source-changes-section'); section.open = true; section.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
$('#project-dialog').addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-dialog]'); if (close) close.closest('dialog')?.close();
  const project = event.target.closest('[data-project]'); if (project && !state.busy) selectProject(project.dataset.project);
  const stage = event.target.closest('[data-stage]'); if (stage) { state.stageId = stage.dataset.stage; renderWorkflow(); renderInspector(); }
  const task = event.target.closest('[data-task]'); if (task) { state.taskId = task.dataset.task; renderRecords(); }
  const artifact = event.target.closest('[data-artifact]'); if (artifact) showArtifact(artifact.dataset.artifact);
  const tab = event.target.closest('[data-tab]'); if (tab) { state.tab = tab.dataset.tab; renderRecords(); }
  const retry = event.target.closest('[data-retry]'); if (retry) runAction('retry', retry.dataset.retry);
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
    const [{ model, ...health }, { projects }] = await Promise.all([api('/api/health'), api('/api/projects')]);
    state.health = { ...health, model }; state.projects = projects;
    $('#connection-status').className = 'connection-status connected'; $('#connection-status').innerHTML = '<span></span>服务已连接';
    const modelOption = $('#mode-select option[value=model]'); modelOption.disabled = !model?.configured; modelOption.textContent = model?.configured ? `模型模式（${model.model || '已配置'}）` : '模型模式（未配置）';
    renderProjects();
    if (projects.length && !state.project) {
      let selection;
      try { selection = JSON.parse(sessionStorage.getItem('taskflow-selection')); } catch { /* Start with the most recently updated project. */ }
      const project = projects.find(item => item.id === selection?.projectId) || projects[0];
      await selectProject(project.id, { runId: selection?.runId });
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
