const HASH = /^[a-f0-9]{64}$/u, ID = /^[A-Za-z0-9_-]{1,128}$/u;
const WORKING = new Set(['reserved', 'preparing', 'checking_environment', 'generating', 'proposal_rejected', 'self_check', 'validating', 'running', 'merging', 'pause_requested', 'paused', 'paused_recovery_ready', 'recovery_requested']);
const STATES = { reserved: '已受理，等待准备', preparing: '准备工作区', checking_environment: '检查执行环境', generating: '编码与修订', self_check: '运行编码自检', validating: '独立测试与审查', restoring_delivery: '核对同版本历史交付，未调用模型', accepted: '本次检查已结束', diagnostic_passed: '诊断检查通过，未计为软件验收', failed: '开发执行失败', stopped: '已确认停止', timed_out: '已达到时长上限', cancel_requested: '已请求停止，等待确认', reconciliation_required: '状态待核对，尚未确认停止' };
Object.assign(STATES, { running: '按依赖执行真实任务', proposal_rejected: '文件建议未通过，正在预算内纠正', merging: '合并已验收候选', pause_requested: '已请求暂停，等待在途任务保存', paused: '已暂停派发新任务', paused_recovery_ready: '安全暂停点已保存，等待恢复', recovery_requested: '正在核对安全暂停点并恢复任务' });
const PREVIEW_STATES = { preparing: '准备演示副本', starting: '正在启动预览', running: '预览运行中', stopping: '已请求停止预览，等待确认', stopped: '预览已确认停止', reconciliation_required: '预览状态待核对，尚未确认停止' };
const STYLE = `
.planned-execution{margin-top:20px;border:1px solid #e2e9f3;border-radius:12px;background:#fff;color:#344c6d;font:13px/1.8 "Microsoft YaHei",sans-serif;min-width:0}.planned-execution *{box-sizing:border-box;min-width:0}.planned-execution [hidden]{display:none!important}
.planned-execution .pe-head,.planned-execution .pe-body{padding:18px 20px}.planned-execution .pe-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid #e2e9f3}.planned-execution h2{margin:0;font-size:18px}.planned-execution h3{font-size:14px;margin:16px 0 8px}.planned-execution p,.planned-execution summary{overflow-wrap:anywhere;margin:8px 0}
.planned-execution button,.planned-execution .pe-download{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:7px 12px;border:1px solid #ccd8e9;border-radius:6px;background:#fff;color:inherit;font:inherit;white-space:normal;cursor:pointer;text-decoration:none;text-align:center}.planned-execution .pe-primary{background:#315deb;color:#fff;border-color:#315deb}.planned-execution :disabled{opacity:.5;cursor:default}.planned-execution :focus-visible{outline:3px solid #9ab0ef;outline-offset:3px}
.planned-execution label{display:block;margin:12px 0}.planned-execution label>span{display:block;margin-bottom:5px}.planned-execution select{width:100%;max-width:100%;min-height:38px;padding:7px;border:1px solid #ccd8e9;border-radius:6px;background:#fff;color:inherit;font:inherit}.planned-execution .pe-consent{display:flex;align-items:flex-start;gap:8px}.planned-execution .pe-consent input{flex:none;margin-top:7px}.planned-execution .pe-consent>span{margin:0}
.planned-execution textarea{display:block;width:100%;min-height:84px;padding:8px;border:1px solid #ccd8e9;border-radius:6px;background:#fff;color:inherit;font:inherit;resize:vertical}
.planned-execution .pe-note{padding:10px 12px;background:#f5f8ff;border-left:3px solid #92ade8;overflow-wrap:anywhere}.planned-execution .pe-error{background:#fff2f1;border-color:#bd635a;color:#98463e}.planned-execution .pe-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.planned-execution .pe-result[data-accepted=true]{color:#17856c;font-weight:600}.planned-execution details{border:1px solid #e2e8f1;border-radius:6px;padding:9px 12px;margin:12px 0}.planned-execution summary{cursor:pointer;font-weight:500}.planned-execution pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-height:300px;overflow:auto;padding:10px;background:#f7f9fc;font:12px/1.8 Consolas,monospace}.planned-execution ol{max-height:260px;overflow:auto;padding-left:24px}.planned-execution li{padding:5px 0;overflow-wrap:anywhere}.planned-execution time{display:block;font-size:11px;color:#73859f}
.planned-execution .pe-preview{border:1px solid #dce5f3;border-radius:8px;padding:12px;margin:14px 0;background:#fafcff}.planned-execution .pe-preview h3{margin-top:0}.planned-execution .pe-preview-link{color:#315deb;overflow-wrap:anywhere}.planned-execution .pe-graph-scroll,.planned-execution .pe-command-scroll{max-width:100%;overflow:auto;overscroll-behavior-x:contain}.planned-execution .pe-graph-scroll{border:1px solid #e2e8f1;border-radius:6px;background:#f8faff}.planned-execution .pe-graph-canvas{position:relative;margin:0;isolation:isolate}.planned-execution .pe-graph-canvas svg{position:absolute;inset:0;pointer-events:none}.planned-execution .pe-task-node{position:absolute;width:210px;height:126px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:3px;text-align:left;background:#fff;overflow:hidden}.planned-execution .pe-task-node[aria-pressed=true]{border-color:#315deb;background:#eef3ff}.planned-execution .pe-task-node[data-status=completed]{border-left:4px solid #17856c}.planned-execution .pe-task-node[data-status=failed]{border-left:4px solid #bd635a}.planned-execution .pe-task-node span{width:100%;overflow-wrap:anywhere}.planned-execution .pe-graph-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.planned-execution .pe-task-node small{font-size:11px}.planned-execution .pe-command-table{border-collapse:collapse;width:100%;min-width:720px;font-size:12px}.planned-execution .pe-command-table th,.planned-execution .pe-command-table td{padding:7px 9px;border-bottom:1px solid #e2e8f1;text-align:left;overflow-wrap:anywhere;max-width:240px;vertical-align:top}.planned-execution .pe-command-table caption{text-align:left;padding:8px 0;color:#73859f}
@media(max-width:600px){.planned-execution .pe-head,.planned-execution .pe-body{padding:15px 12px}.planned-execution .pe-head{gap:8px}.planned-execution .pe-head button{flex:none;padding:6px 8px}.planned-execution .pe-actions>*{flex:1 1 150px}.planned-execution .pe-primary{width:100%}.planned-execution pre{font-size:11px}}
`;
const contextOf = raw => Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision', 'planningStatus'].map(key => [key, typeof raw?.[key] === 'string' ? raw[key] : '']));
const keyOf = value => JSON.stringify(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '未知';
const printable = value => { if (value == null) return '尚无记录'; if (typeof value === 'string') return value; try { return JSON.stringify(value, null, 2); } catch { return '记录格式待核对'; } };
function previewURL(value) {
  if (typeof value !== 'string' || !/^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]{1,5}\/?$/iu.test(value)) return null;
  try { const url = new URL(value); return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port && Number(url.port) > 0 && Number(url.port) <= 65535 && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash ? url.href : null; } catch { return null; }
}

/** Only backend current/accepted facts grant actions; POST responses never grant a pass. */
export function createPlannedExecutionPanel({ api, getContext, onError = () => {}, onFailure = () => {}, onUpdate = () => {}, openVerification, reviseChecklist, canReviseChecklist = () => true, isGuided = () => false }) {
  if (typeof api !== 'function' || typeof getContext !== 'function') throw new TypeError('规划开发面板需要api和当前规划上下文。');
  let root, refs, destroyed = false, mounted = false, timer, epoch = 0, readSerial = 0, action = null, pending = null;
  let context = contextOf(null), key = '', data = null, proposals = null, fresh = false, loading = false, error = '', notice = '', consentKey = '';
  let selectedId = '', proposalId = '', selectionEdits = 0, previewRead = null, graphRecord = '', selectedTask = '', repairNoteKey = ''; const savedSelections = new Map(), notified = new Set(), eventNodes = new Map(), taskNodes = new Map(), graphNodes = new Map();
  const node = (tag, value, cls) => { const element = document.createElement(tag); if (value != null) element.textContent = value; if (cls) element.className = cls; return element; };
  const setText = (element, value) => { const text = printable(value); if (element.textContent !== text) element.textContent = text; };
  function button(label, handler, cls) { const element = node('button', label, cls); element.type = 'button'; element.addEventListener('click', handler); return element; }
  function field(label, control) { const element = node('label'); control.setAttribute('aria-label', label); element.append(node('span', label), control); return element; }
  function section(label, parent) { const details = node('details'), pre = node('pre'); pre.tabIndex = 0; details.append(node('summary', label), pre); parent.append(details); return pre; }
  const base = () => `/api/projects/${encodeURIComponent(context.projectId)}/runs/${encodeURIComponent(context.runId)}/development-executions`;
  const proposalPath = () => `/api/projects/${encodeURIComponent(context.projectId)}/runs/${encodeURIComponent(context.runId)}/verification-plans`;
  const confirmed = () => context.planningStatus === 'confirmed' && HASH.test(context.specRevision) && HASH.test(context.planRevision);
  const currentToken = token => !destroyed && token.epoch === epoch && token.key === key && keyOf(contextOf(getContext())) === key;
  const rows = () => Array.isArray(data?.executions) ? data.executions : [];
  const row = () => rows().find(item => item.id === selectedId && scoped(item));
  const scoped = item => item && ID.test(item.id || '') && item.projectId === context.projectId && item.runId === context.runId && item.kind === 'planned_web';
  const sameBinding = item => item?.binding?.specRevision === context.specRevision && item.binding.planRevision === context.planRevision && HASH.test(item.binding.sourceRevision || '') && Number.isSafeInteger(item.binding.sourceGeneration) && item.binding.sourceGeneration >= 0;
  const currentRow = item => scoped(item) && item.current === true && confirmed() && sameBinding(item);
  const eligible = item => item && ID.test(item.id || '') && item.projectId === context.projectId && item.runId === context.runId && item.current === true && item.approved === true && item.status === 'approved'
    && item.coverage === 'structural_only' && item.executed === false && HASH.test(item.revision || '') && HASH.test(item.manifestHash || '') && sameBinding(item)
    && item.binding.projectId === context.projectId && item.binding.runId === context.runId && item.approval?.phase === 'definition_only'
    && item.proposal?.browser?.version === 1 && Array.isArray(item.proposal.browser.sessions) && item.proposal.browser.sessions.length > 0 && Array.isArray(item.proposal.browser.steps) && item.proposal.browser.steps.length > 0;
  const definitions = () => proposals?.coverage === 'structural_only' && Array.isArray(proposals.proposals) ? proposals.proposals.filter(item => eligible(item)
    && (!Array.isArray(data?.capabilities?.supportedProposalIds) || data.capabilities.supportedProposalIds.includes(item.id))) : [];
  const selectedDefinition = () => definitions().find(item => item.id === proposalId);
  function validBudget() {
    const cap = data?.capabilities, budget = cap?.budget;
    const taskLimit = budget?.taskLimit ?? 1, attemptCalls = budget?.attemptModelCalls ?? (budget?.maxCalls ?? 0) + (budget?.maxReviewCalls ?? 0);
    const validAggregate = budget?.unlimited === true
      ? ['maxAttempts', 'remainingAttempts', 'totalModelCalls', 'remainingModelCalls'].every(field => budget[field] === null)
      : !!budget && (budget.unlimited === undefined || budget.unlimited === false)
        && Number.isSafeInteger(budget.maxAttempts) && budget.maxAttempts >= 1 && budget.maxAttempts <= 20
        && Number.isSafeInteger(budget.remainingAttempts) && budget.remainingAttempts >= 1 && budget.remainingAttempts <= budget.maxAttempts
        && Number.isSafeInteger(budget.totalModelCalls) && budget.totalModelCalls >= 0 && Number.isSafeInteger(budget.remainingModelCalls) && budget.remainingModelCalls >= attemptCalls && budget.remainingModelCalls <= budget.maxAttempts * attemptCalls;
    return !!budget && cap?.canStart === true && HASH.test(cap.contractRevision || '') && typeof cap.model?.name === 'string' && !!cap.model.name.trim() && cap.model.name.length <= 200
      && Number.isSafeInteger(taskLimit) && taskLimit >= 1 && taskLimit <= 8 && Number.isSafeInteger(attemptCalls) && attemptCalls === taskLimit * (budget.maxCalls + budget.maxReviewCalls)
      && (budget.taskLimit === undefined || Number.isSafeInteger(budget.maxConcurrency) && budget.maxConcurrency >= 1 && budget.maxConcurrency <= 2)
      && ['maxCalls', 'maxReviewCalls'].every(name => Number.isSafeInteger(budget?.[name]) && budget[name] >= 1 && budget[name] <= 5)
      && Number.isSafeInteger(budget.timeoutMs) && budget.timeoutMs >= 1 && budget.timeoutMs <= (taskLimit > 1 ? 1200000 : 600000) && validAggregate;
  }
  function failureHelp(item) {
    const help = item?.failureHelp;
    if (!['failed', 'stopped', 'timed_out', 'reconciliation_required'].includes(item?.status) || !help || !['review_checklist', 'inspect', 'retry'].includes(help.action)
      || !['title', 'detail', 'nextStep'].every(field => typeof help[field] === 'string' && help[field].trim())) return null;
    return help;
  }
  function checklistBlocksDefinition() {
    const definition = selectedDefinition();
    if (!definition) return false;
    const previous = rows().findLast(item => currentRow(item) && item.proposalId === definition.id && item.revision === definition.revision);
    return failureHelp(previous)?.action === 'review_checklist';
  }
  const previewOf = item => scoped(item) && item.preview && ID.test(item.preview.id || '') && item.preview.executionId === item.id ? item.preview : null;
  const previewUnsettled = item => item?.preview != null && (!previewOf(item) || previewOf(item).active !== false || previewOf(item).state !== 'stopped');
  const previewsBlock = () => rows().filter(scoped).some(previewUnsettled);
  const previewFresh = () => fresh && !loading && !action && !pending && previewRead && currentToken(previewRead) && previewRead.selectionEdits === selectionEdits;
  const mayStart = () => fresh && !loading && !action && !pending && !previewsBlock() && confirmed() && validBudget() && !!selectedDefinition() && !checklistBlocksDefinition() && refs.consent.checked;
  const accepted = item => fresh && !action && !pending && currentRow(item) && item.status === 'accepted' && item.accepted === true && item.active === false && /^[a-f0-9]{40}$/u.test(item.candidateCommit || '')
    && definitions().some(proposal => proposal.id === item.proposalId && proposal.revision === item.revision);
  const mayCancel = item => fresh && !action && (!pending || pending.kind === 'recover' && pending.id === item?.id && currentToken(pending))
    && currentRow(item) && item.active === true && (WORKING.has(item.status) || item.status === 'reconciliation_required' && item.actions?.canRetryCancellation === true) && item.actions?.canCancel === true;
  const mayTaskControl = (item, kind) => fresh && !action && !pending && currentRow(item) && item.active === true && item.executionMode === 'task_dag'
    && (kind === 'pause' ? item.status === 'running' && item.actions?.canPause === true : ['pause_requested', 'paused'].includes(item.status) && item.actions?.canResume === true);
  const mayRecover = item => fresh && !loading && !action && !pending && currentRow(item) && item.active === true && item.executionMode === 'task_dag'
    && ['paused', 'paused_recovery_ready'].includes(item.status) && item.actions?.canRecover === true;
  const mayRepair = item => fresh && !loading && !action && !pending && !previewsBlock() && currentRow(item) && item.active === false && ['failed', 'stopped', 'timed_out'].includes(item.status)
    && item.actions?.canRepair === true && /^[a-f0-9]{40}$/u.test(item.candidateCommit || '') && validBudget() && !checklistBlocksDefinition() && refs.consent.checked
    && selectedDefinition()?.id === item.proposalId && selectedDefinition()?.revision === item.revision;
  const mayPreview = item => previewFresh() && accepted(item) && !previewsBlock() && item.actions?.canPreview === true;
  const mayStopPreview = item => previewFresh() && scoped(item) && previewOf(item)?.active === true && previewOf(item)?.actions?.canStop === true && item.actions?.canStopPreview === true;
  const mayDownload = item => accepted(item) && !loading && !previewsBlock() && item.actions?.canDownload === true;
  const latestExecution = () => rows().findLast(item => currentRow(item) && item.active) ?? rows().findLast(currentRow);
  const mayReviseChecklist = item => typeof reviseChecklist === 'function' && canReviseChecklist() && fresh && !loading && !action && !pending && !previewsBlock()
    && item === latestExecution() && currentRow(item) && item.active === false && failureHelp(item)?.action === 'review_checklist';
  function workflowProgress() {
    if (!fresh || keyOf(contextOf(getContext())) !== key) return {};
    const execution = latestExecution();
    return { execution, failureHelp: failureHelp(execution), canReviseChecklist: mayReviseChecklist(execution), accepted: Boolean(accepted(execution)), hasDefinition: definitions().length > 0,
      canStart: Boolean(data?.capabilities?.canStart), reason: data?.capabilities?.reason || '' };
  }
  function summarizeFailure(execution) {
    if (execution?.error) return execution.error;
    const firstPageError = execution?.checks?.browser?.find(check => check.passed === false && typeof check.actual === 'string' && check.actual.startsWith('{'));
    if (!firstPageError) return '';
    try {
      const { operation, expected, guardFailures } = JSON.parse(firstPageError.actual);
      if (operation === 'goto' && (guardFailures?.console_error || guardFailures?.page_error)) {
        return /^\/login(?:\.html)?(?:\?|$)/u.test(expected) ? '浏览器打开登录页时遇到页面错误。' : '浏览器打开页面时遇到运行错误。';
      }
    } catch { /* The full observation is still available in technical details. */ }
    return '';
  }
  function guide() {
    if (!refs || !fresh || keyOf(contextOf(getContext())) !== key) return {};
    const execution = latestExecution(), progress = workflowProgress(), cap = data?.capabilities, budget = cap?.budget;
    const active = Boolean(action || pending || execution?.active);
    const locked = active || loading || previewsBlock();
    const selected = execution?.id === selectedId;
    const validStart = !locked && validBudget() && confirmed() && Boolean(selectedDefinition()) && !checklistBlocksDefinition();
    const canRepair = Boolean(validStart && selected && execution?.actions?.canRepair && selectedDefinition()?.id === execution.proposalId
      && selectedDefinition()?.revision === execution.revision);
    const flow = execution?.workflow, reworkCount = flow?.reworkCount ?? 0;
    const checkingDelivery = execution?.status === 'accepted' && !progress.accepted;
    const held = ['paused', 'pause_requested', 'paused_recovery_ready', 'recovery_requested', 'cancel_requested', 'reconciliation_required'].includes(execution?.status);
    const failed = ['failed', 'stopped', 'timed_out'].includes(execution?.status);
    const failedStage = ['testing', 'self_check'].includes(flow?.stage) ? 'testing' : flow?.stage;
    const stage = progress.accepted ? 'delivery' : failed ? failedStage ?? (execution?.checks ? 'testing' : 'coding')
      : flow?.reviewPending ? 'review' : flow?.testing || flow?.selfCheck || ['validating', 'self_check'].includes(execution?.status) ? 'testing' : 'coding';
    const reworking = reworkCount > 0 && active && !held && stage === 'coding';
    const taskCount = execution?.tasks?.length ?? 0;
    const completedTasks = execution?.tasks?.filter(task => task.status === 'completed').length ?? 0;
    const stopDetail = execution?.status === 'timed_out' ? '本次开发时间已用完。你可以打开记录看最后完成了什么。'
      : execution?.status === 'stopped' ? '本次开发已停止，记录和已生成的代码已保留。'
        : flow?.errorCode === 'unchanged_candidate' ? '这轮返工没有产生代码改动。你可以查看上次检查遇到的问题。'
          : summarizeFailure(execution) || (stage === 'review' ? '最后一版仍有审查问题待解决。' : stage === 'testing' ? '最后一版还有测试没通过。' : '这次没有生成可继续检查的版本。');
    const help = progress.failureHelp;
    return { accepted: progress.accepted, active, canStart: validStart, canRepair, failed, stage, reworkCount, checkingDelivery,
      failureAction: help?.action, nextStep: help?.nextStep, canReviseChecklist: progress.canReviseChecklist,
      held, taskCount, completedTasks,
      canStop: selected && mayCancel(execution), canResume: selected && mayTaskControl(execution, 'resume'), canRecover: selected && mayRecover(execution),
      title: held ? STATES[execution.status] : reworking ? '正在自动返工' : stage === 'review' ? '正在独立审查' : stage === 'testing' ? '正在运行测试'
        : execution?.status === 'generating' ? '正在写代码' : execution?.status === 'proposal_rejected' ? '正在调整实现' : '正在准备开发',
      detail: held ? help?.detail || '你的需求和本次进度已保留。' : reworking ? `${({ review: '审查发现了需要修改的问题', proposal: '这一轮代码草稿需要调整' })[flow?.cause] ?? '测试发现了需要修改的问题'}。改完会重新测试和审查。`
        : stage === 'review' ? '功能和页面测试已通过。审查会核对代码有没有遗漏。'
          : stage === 'testing' ? '系统正在打开软件、操作页面并检查功能。'
            : active ? '代码准备好后，会自动开始测试。' : cap?.canStart ? '' : '正在核对启动开发的条件。',
      failureTitle: help?.title ?? (execution?.status === 'timed_out' ? '这次开发超时了' : execution?.status === 'stopped' ? '这次开发已停止'
        : execution?.checks?.http?.length || execution?.checks?.browser?.length ? '这一版没有通过检查' : '这次开发未完成'),
      failureDetail: help?.detail || stopDetail,
      ...(validStart ? { cost: `包含自动返工，本次最多调用模型 ${budget.attemptModelCalls ?? budget.maxCalls + budget.maxReviewCalls} 次。` } : {}),
      previewHref: selected ? previewLink(execution) : null, canPreview: selected && mayPreview(execution), canStopPreview: selected && mayStopPreview(execution),
      downloadHref: selected && mayDownload(execution) ? `${base()}/${encodeURIComponent(execution.id)}/download` : null };
  }
  function guideAct(kind) {
    const status = guide();
    if (kind === 'revise-checklist') {
      const item = latestExecution();
      if (mayReviseChecklist(item)) return reviseChecklist(item.id);
      return;
    }
    if (!({ start: status.canStart, repair: status.canRepair, preview: status.canPreview, 'stop-preview': status.canStopPreview,
      cancel: status.canStop, resume: status.canResume, recover: status.canRecover })[kind]) return;
    if (kind === 'start' || kind === 'repair') refs.consent.checked = true;
    return perform(kind);
  }
  function focusStage(stage) {
    if (!refs) return null;
    const execution = latestExecution();
    if (execution && execution.id !== selectedId && !action && !pending) {
      selectedId = execution.id; selectionEdits++; previewRead = null; remember(); render(); void refresh();
    }
    if (stage === 'testing' && !refs.detail.hidden) {
      if (!refs.failureHelp.hidden) return refs.failureTitle;
      refs.checks.closest('details').open = true;
      refs.review.closest('details').open = true;
      return refs.checks.closest('details').querySelector('summary');
    }
    if (stage === 'delivery' && !refs.detail.hidden && !refs.previewBox.hidden) return refs.previewBox.querySelector('h3');
    if (stage === 'coding' && !refs.detail.hidden && row()?.active) return refs.status;
    return refs.state;
  }
  function previewLink(item) { const preview = previewOf(item); return previewFresh() && accepted(item) && preview?.state === 'running' && preview.active === true && Number.isFinite(Date.parse(preview.expiresAt)) && Date.parse(preview.expiresAt) > Date.now() ? previewURL(preview.url) : null; }
  function report(failure) { error = failure instanceof Error ? failure.message : printable(failure); try { Promise.resolve(onError(failure instanceof Error ? failure : new Error(error))).catch(() => {}); } catch { /* A notification cannot alter an action. */ } }
  function remember() { if (context.projectId && context.runId) savedSelections.set(key, { selectedId, proposalId }); while (savedSelections.size > 30) savedSelections.delete(savedSelections.keys().next().value); }
  function syncContext() {
    const next = contextOf(getContext()), nextKey = keyOf(next); if (nextKey === key) return false;
    remember(); context = next; key = nextKey; epoch++; readSerial++; action = null; pending = null; data = null; proposals = null; fresh = false; loading = false; error = ''; notice = ''; consentKey = ''; previewRead = null;
    ({ selectedId = '', proposalId = '' } = savedSelections.get(key) ?? {}); if (refs) refs.consent.checked = false; return true;
  }
  function notifyFailures() {
    if (!fresh || !currentToken({ key, epoch })) return;
    for (const item of row() ? [row()] : []) {
      if (!currentRow(item) || !['failed', 'timed_out', 'reconciliation_required'].includes(item.status)) continue;
      const message = failureHelp(item)?.title || (typeof item.error === 'string' && item.error.trim() ? item.error : item.status === 'reconciliation_required' ? '开发状态待核对，请查看执行记录及停止证据' : '当前规划开发未完成，请查看失败检查和阻塞问题');
      const signature = keyOf([key, item.id, item.status, message]); if (notified.has(signature)) continue; notified.add(signature); if (notified.size > 200) notified.delete(notified.values().next().value);
      try { Promise.resolve(onFailure({ message, context: { projectId: context.projectId, runId: context.runId } })).catch(() => {}); } catch { /* Parent notices cannot create acceptance. */ }
    }
  }
  function options(select, entries, chosen, placeholder) {
    const nodes = new Map([...select.options].map(option => [option.value, option]));
    const items = entries.length ? entries : [{ id: '', label: placeholder }], kept = new Set();
    for (const item of items) { let option = nodes.get(item.id); if (!option) { option = node('option'); option.value = item.id; select.append(option); } setText(option, item.label); kept.add(item.id); }
    for (const option of [...select.options]) if (!kept.has(option.value)) option.remove();
    select.value = items.some(item => item.id === chosen) ? chosen : items[0].id; return select.value;
  }
  function build(host) {
    root = node('section', null, 'planned-execution'); root.append(node('style', STYLE)); const head = node('div', null, 'pe-head'), intro = node('div'); intro.append(node('h2', '按当前规划开发'));
    const refreshButton = button('刷新开发状态', () => { void refresh(); }); head.append(intro, refreshButton); root.append(head);
    const body = node('div', null, 'pe-body'), state = node('p', null, 'pe-note'), errorBox = node('p', null, 'pe-note pe-error'), noticeBox = node('p', null, 'pe-note pe-notice'); errorBox.setAttribute('role', 'alert'); noticeBox.setAttribute('role', 'status');
    const prepare = button('去准备验收清单', () => openVerification?.(), 'pe-primary');
    body.append(state, prepare, errorBox, noticeBox);
    const setup = node('div'); body.append(setup);
    const cost = node('p', null, 'pe-note'), definitionSelect = node('select'), consent = node('input'); consent.type = 'checkbox'; const label = node('label', null, 'pe-consent'); label.append(consent, node('span', '我已核对当前规格、联合验收定义、所选执行、模型和冻结预算，同意本次开发或保留代码修复产生模型用量。'));
    const start = button('按当前规划开始开发', () => { void perform('start'); }, 'pe-primary'); setup.append(cost, field('已认可的联合验收定义', definitionSelect), label, start);
    const monetary = node('p', '费用估算：未知。实际调用和token用量单独记录。', 'pe-note'); setup.append(monetary);
    const scope = section('规格、来源和预算', setup), executionSelect = node('select');
    const recordSelect = field('开发执行记录', executionSelect); body.append(recordSelect);
    const empty = node('p', '尚无开发执行记录。'), detail = node('div'), result = node('p', null, 'pe-result'), status = node('p'), failure = node('p', null, 'pe-note pe-error'), facts = node('p'), actions = node('div', null, 'pe-actions');
    const failureHelpBox = node('div', null, 'pe-note pe-error'), failureTitle = node('strong'), failureDetail = node('p'), failureNext = node('p');
    const prepareRevision = button('准备清单修订', () => { const item = row(); if (mayReviseChecklist(item)) void reviseChecklist(item.id); }, 'pe-primary');
    const technicalFailure = button('展开技术检查', () => {
      const evidence = refs.checks.closest('details');
      evidence.open = true; refs.review.closest('details').open = true;
      evidence.querySelector('summary').focus();
    });
    const failureActions = node('div', null, 'pe-actions'); failureActions.append(prepareRevision, technicalFailure);
    failureHelpBox.append(failureTitle, failureDetail, failureNext, failureActions);
    const repairNote = node('textarea'), repairNoteField = field('修复说明（选填）', repairNote);
    repairNote.maxLength = 2000; repairNote.placeholder = '写明已观察到的症状或代码位置。说明会随修复请求发送给编码模型，请避免填写凭据。';
    const repairInfo = node('p', '修复会复用所选执行的源码。新代码会重新跑测试与审查。', 'pe-note');
    const repair = button('保留代码并修复', () => { void perform('repair'); }), cancel = button('请求停止本次开发', () => { void perform('cancel'); }), download = node('a', '下载当前已验收源码', 'pe-download'); download.rel = 'noreferrer'; actions.append(repair, cancel, download); detail.append(result, status, failureHelpBox, failure, facts, repairInfo, repairNoteField, actions);
    const pause = button('暂停派发新任务', () => { void perform('pause'); }), resume = button('继续任务开发', () => { void perform('resume'); }), recover = button('从安全暂停点恢复', () => { void perform('recover'); }); actions.append(pause, resume, recover);
    const recoveryNote = node('p', '恢复会保留已完成任务和原有用量，只继续未完成任务；仍使用本次剩余额度和原时限。尚未确认停止的执行不能据此重新启动。', 'pe-note'); detail.append(recoveryNote);
    const previewBox = node('div', null, 'pe-preview'), previewStatus = node('p', null, 'pe-preview-status'), previewInfo = node('p', null, 'pe-note'), previewActions = node('div', null, 'pe-actions');
    const previewStart = button('启动已验收软件预览', () => { void perform('preview'); }), previewStop = button('停止软件预览', () => { void perform('stop-preview'); }), previewAnchor = node('a', '打开软件预览', 'pe-preview-link');
    previewAnchor.target = '_blank'; previewAnchor.rel = 'noopener noreferrer'; previewActions.append(previewStart, previewStop, previewAnchor); previewBox.append(node('h3', '软件预览'), previewStatus, previewInfo, previewActions); detail.append(previewBox);
    const taskSection = node('details'), taskList = node('div'), graphNote = node('p', null, 'pe-note'), graphScroll = node('div', null, 'pe-graph-scroll'), graphCanvas = node('div', null, 'pe-graph-canvas'); graphScroll.tabIndex = 0; graphScroll.setAttribute('role', 'region'); graphScroll.setAttribute('aria-label', '真实任务依赖图，可横向滚动'); graphScroll.append(graphCanvas);
    taskSection.open = true; taskSection.append(node('summary', '真实任务、依赖与验收证据'), graphNote, graphScroll, taskList); detail.append(taskSection);
    const commands = node('details', null, 'pe-commands'), commandScroll = node('div', null, 'pe-command-scroll'), commandTable = node('table', null, 'pe-command-table'), commandHead = node('tr'), commandBody = node('tbody');
    commandTable.append(node('caption', '仅展示后端提供的脱敏工具结果；未知值保留为未知。'));
    for (const title of ['记录 / 任务', '阶段 / 工具', '开始时间', '用时', '退出码', '停止确认', '状态']) { const th = node('th', title); th.scope = 'col'; commandHead.append(th); }
    const thead = node('thead'); thead.append(commandHead); commandTable.append(thead, commandBody); commandScroll.append(commandTable); commands.append(node('summary', '真实工具执行结果'), commandScroll); detail.append(commands);
    const binding = section('本次冻结预算与代码版本', detail), diff = section('本次代码差异', detail), checks = section('自检、HTTP与浏览器实际检查', detail), review = section('Review与阻塞问题', detail), calls = section('模型请求与实际用量', detail);
    const events = node('details'), list = node('ol'); events.open = !openVerification; events.append(node('summary', '真实执行日志'), list); detail.append(events); body.append(empty, detail); root.append(body); host.append(root);
    refs = { refreshButton, state, errorBox, noticeBox, prepare, setup, recordSelect, cost, monetary, definitionSelect, consent, start, scope, executionSelect, empty, detail, result, status, failure, failureHelp: failureHelpBox, failureTitle, failureDetail, failureNext, prepareRevision, facts, repair, repairInfo, repairNote, repairNoteField, cancel, pause, resume, recover, recoveryNote, download, previewBox, previewStatus, previewInfo, previewStart, previewStop, previewAnchor, taskSection, taskList, graphNote, graphScroll, graphCanvas, commands, commandBody, binding, diff, checks, review, calls, list };
    definitionSelect.addEventListener('change', () => { if (syncContext()) { render(); void refresh(); return; } if (action) return; proposalId = definitionSelect.value; consent.checked = false; remember(); render(); });
    executionSelect.addEventListener('change', () => { if (syncContext()) { render(); void refresh(); return; } if (action) return; selectedId = executionSelect.value; selectionEdits++; previewRead = null; remember(); render(); notifyFailures(); void refresh(); });
    consent.addEventListener('change', () => { if (syncContext()) { render(); void refresh(); return; } render(); });
    repairNote.addEventListener('input', () => { consent.checked = false; if (syncContext()) void refresh(); render(); });
    download.addEventListener('click', event => { if (syncContext() || !mayDownload(row())) { event.preventDefault(); render(); void refresh(); } });
    previewAnchor.addEventListener('click', event => { if (syncContext() || !previewLink(row()) || previewAnchor.href !== previewLink(row())) { event.preventDefault(); render(); void refresh(); } });
  }
  function taskState(task) { return task.status === 'completed' ? '本任务已验收并集成' : task.status === 'pending' ? '等待依赖或派发' : STATES[task.stage] || STATES[task.status] || '正在核对'; }
  function renderGraph(item) {
    if (graphRecord !== item.id) { graphRecord = item.id; selectedTask = ''; }
    const tasks = Array.isArray(item.tasks) ? item.tasks : [], byId = new Map(tasks.map(task => [task.id, task])), levels = new Map();
    let valid = tasks.length >= 1 && tasks.length <= 8 && byId.size === tasks.length && tasks.every(task => ID.test(task.id || '') && Array.isArray(task.dependsOn) && new Set(task.dependsOn).size === task.dependsOn.length && task.dependsOn.every(id => byId.has(id) && id !== task.id));
    if (valid) for (let pass = 0; pass < tasks.length; pass++) for (const task of tasks) if (!levels.has(task.id) && task.dependsOn.every(id => levels.has(id))) levels.set(task.id, task.dependsOn.length ? Math.max(...task.dependsOn.map(id => levels.get(id))) + 1 : 0);
    valid &&= levels.size === tasks.length;
    setText(refs.graphNote, valid ? '依赖来自本次实际任务，状态来自后端执行记录。选择节点查看检查与历史意见；依赖关系本身不代表功能已实现。' : '任务依赖记录尚不完整，暂不绘制关系；请核对下方实际任务证据。'); refs.graphScroll.hidden = !valid;
    if (!valid) { for (const view of graphNodes.values()) view.button.remove(); graphNodes.clear(); refs.graphCanvas.querySelector('svg')?.remove(); return; }
    const places = new Map(), columns = new Map();
    for (const task of tasks) { const level = levels.get(task.id), row = columns.get(level) || 0; columns.set(level, row + 1); places.set(task.id, { x: 20 + level * 270, y: 20 + row * 150 }); }
    const width = (Math.max(...levels.values()) + 1) * 270 - 20, height = Math.max(...columns.values()) * 150 + 16;
    refs.graphCanvas.style.width = `${width}px`; refs.graphCanvas.style.height = `${height}px`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', width); svg.setAttribute('height', height); svg.setAttribute('aria-hidden', 'true');
    for (const task of tasks) for (const dependency of task.dependsOn) {
      const from = places.get(dependency), to = places.get(task.id), path = document.createElementNS(svg.namespaceURI, 'path'), x = from.x + 210, y = from.y + 63, endX = to.x - 4, endY = to.y + 63;
      path.dataset.from = dependency; path.dataset.to = task.id; path.setAttribute('d', `M${x},${y} C${x + 28},${y} ${endX - 28},${endY} ${endX},${endY} M${endX - 6},${endY - 4} L${endX},${endY} L${endX - 6},${endY + 4}`); path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#8ba0c0'); path.setAttribute('stroke-width', '1.5'); svg.append(path);
    }
    const oldSvg = refs.graphCanvas.querySelector('svg'); if (oldSvg) oldSvg.replaceWith(svg); else refs.graphCanvas.prepend(svg);
    const kept = new Set();
    for (const task of tasks) {
      kept.add(task.id); let view = graphNodes.get(task.id);
      if (!view) { const control = button('', () => { selectedTask = task.id; const card = taskNodes.get(task.id); if (card) { card.card.open = true; card.summary.tabIndex = -1; card.summary.focus({ preventScroll: true }); card.card.scrollIntoView({ block: 'nearest' }); } for (const [id, entry] of graphNodes) entry.button.setAttribute('aria-pressed', String(id === selectedTask)); }, 'pe-task-node'), id = node('small'), title = node('span', null, 'pe-graph-title'), status = node('small'); control.append(id, title, status); refs.graphCanvas.append(control); view = { button: control, id, title, status }; graphNodes.set(task.id, view); }
      const position = places.get(task.id); view.button.style.left = `${position.x}px`; view.button.style.top = `${position.y}px`; view.button.dataset.taskId = task.id; view.button.dataset.status = task.status; view.button.setAttribute('aria-pressed', String(task.id === selectedTask)); view.button.title = `${task.title || task.id}；依赖：${task.dependsOn.join('、') || '无'}`;
      view.button.setAttribute('aria-label', `${task.id}：${view.button.title}；${taskState(task)}`);
      setText(view.id, task.id); setText(view.title, task.title || task.id); setText(view.status, taskState(task));
    }
    for (const [id, view] of graphNodes) if (!kept.has(id)) { view.button.remove(); graphNodes.delete(id); }
  }
  function renderCommands(item) {
    const commands = Array.isArray(item.commands) ? item.commands.filter(command => command && typeof command === 'object') : []; refs.commandBody.replaceChildren();
    if (!commands.length) { const cell = node('td', '尚无工具结果记录。'); cell.colSpan = 7; const tr = node('tr'); tr.append(cell); refs.commandBody.append(tr); }
    for (const command of commands) {
      const text = value => typeof value === 'string' && value ? value : '未知', tr = node('tr');
      for (const value of [`${text(command.id)} / ${text(command.taskId)}`, `${text(command.phase)} / ${text(command.tool)}`, text(command.startedAt), Number.isSafeInteger(command.durationMs) && command.durationMs >= 0 ? `${command.durationMs} ms` : '未知', Number.isSafeInteger(command.exitCode) ? String(command.exitCode) : '未知', command.terminationConfirmed === true ? '已确认' : command.terminationConfirmed === false ? '未确认' : '未知', text(command.status)]) tr.append(node('td', value));
      refs.commandBody.append(tr);
    }
  }
  function render() {
    if (!refs || destroyed) return;
    const cap = data?.capabilities, budget = cap?.budget, candidates = definitions();
    refs.prepare.hidden = !openVerification || !fresh || !confirmed() || candidates.length > 0;
    refs.setup.hidden = Boolean(openVerification) && (!confirmed() || !candidates.length);
    refs.recordSelect.hidden = Boolean(openVerification) && !rows().length;
    proposalId = options(refs.definitionSelect, candidates.map(item => ({ id: item.id, label: `${item.proposal.name || item.id} · ${item.revision.slice(0, 12)}` })), proposalId, '尚无当前认可的联合验收定义');
    const latest = latestExecution();
    const preferredExecution = !action && !pending && (isGuided() || !selectedId && latest?.createdAt) ? latest?.id : null;
    selectedId = options(refs.executionSelect, rows().filter(scoped).map(item => ({ id: item.id, label: `${STATES[item.status] || '未知状态'} · ${item.id}` })), preferredExecution ?? selectedId, '尚无执行记录'); refs.executionSelect.disabled = !!action || !rows().filter(scoped).length;
    const signature = keyOf([key, cap?.contractRevision, cap?.model, cap?.budget, proposalId, selectedDefinition()?.revision, selectedId, row()?.candidateCommit, row()?.revision, row()?.actions?.canRepair]);
    if (signature !== consentKey) { consentKey = signature; refs.consent.checked = false; }
    const checklistBlocked = checklistBlocksDefinition();
    setText(refs.state, !context.projectId || !context.runId ? '请先选择项目与规划运行。' : !confirmed() ? '请先确认当前规格与开发计划；历史运行只读。' : loading && !data ? '正在读取开发状态与验收定义…' : error ? '读取或操作未确认，请保留选择并刷新核对。' : checklistBlocked ? '当前验收清单需要修订。请查看下方的失败原因与下一步。' : cap?.reason || '只有后端当前版本验收通过后才开放源码下载。');
    refs.errorBox.hidden = !error; setText(refs.errorBox, error); refs.noticeBox.hidden = !notice; setText(refs.noticeBox, notice);
    const attemptLimit = budget?.unlimited === true ? '整份计划可以不限次执行。' : `剩余开发尝试${count(budget?.remainingAttempts)}/${count(budget?.maxAttempts)}，剩余模型调用${count(budget?.remainingModelCalls)}，共享调用总额度${count(budget?.totalModelCalls)}。`;
    setText(refs.cost, `模型：${cap?.model?.name || '尚未确认'}。${budget?.taskLimit ? `最多${count(budget.taskLimit)}项真实任务，每项` : '每次'}编码最多${count(budget?.maxCalls)}次、独立Review最多${count(budget?.maxReviewCalls)}次；${budget?.taskLimit ? `本次最多${count(budget.attemptModelCalls)}次模型调用，并发最多${count(budget.maxConcurrency)}项；` : ''}总时限${Number.isSafeInteger(budget?.timeoutMs) ? `${budget.timeoutMs / 1000}秒` : '未知'}。${attemptLimit}`);
    refs.definitionSelect.disabled = !!action || !fresh || !candidates.length; refs.consent.disabled = !!action || !!pending || !fresh || !confirmed() || !validBudget() || !selectedDefinition() || checklistBlocked; refs.start.disabled = !mayStart(); refs.refreshButton.disabled = !!action;
    setText(refs.monetary, cap?.costEstimate?.known === false ? `费用估算：未知。${cap.costEstimate.reason || '实际调用和token用量单独记录。'}` : '费用估算：尚未确认。实际调用和token用量单独记录。');
    setText(refs.scope, { specRevision: context.specRevision, planRevision: context.planRevision, definition: selectedDefinition() ? { id: proposalId, revision: selectedDefinition().revision, binding: selectedDefinition().binding } : null, budget });
    const item = row();
    const noteTarget = keyOf([key, item?.id, item?.candidateCommit, item?.revision, item?.binding?.sourceRevision, item?.binding?.sourceGeneration, proposalId, cap?.contractRevision]);
    if (noteTarget !== repairNoteKey) { repairNoteKey = noteTarget; refs.repairNote.value = ''; }
    refs.repairNoteField.hidden = checklistBlocked || !(currentRow(item) && ['failed', 'stopped', 'timed_out'].includes(item.status) && item.actions?.canRepair === true
      && selectedDefinition()?.id === item.proposalId && selectedDefinition()?.revision === item.revision);
    refs.repairNote.disabled = !!action || !!pending || refs.repairNoteField.hidden;
    refs.repairInfo.hidden = refs.repairNoteField.hidden;
    refs.empty.hidden = !!item; refs.detail.hidden = !item; if (!item) return;
    const passed = accepted(item); refs.result.dataset.accepted = String(passed); setText(refs.result, passed ? item.checkpoint?.restored === true ? '同版本历史验收已核对，交付资格已恢复；未重新运行测试。' : '当前规格的软件已通过本次验收' : item.status === 'accepted' ? '历史通过记录仅供查看；当前验收许可尚未确认。' : item.status === 'diagnostic_passed' ? '诊断检查通过，不代表当前软件通过验收。' : '当前软件尚未获得完整验收结论。');
    setText(refs.status, item.checkpoint?.restored === true ? '同版本历史交付已恢复' : STATES[item.status] || '未知执行状态，请刷新核对');
    const help = failureHelp(item);
    refs.failure.hidden = !!help || (!item.error && (!item.checkpoint?.message || item.checkpoint.restored === true)); setText(refs.failure, item.error || item.checkpoint?.message);
    refs.failureHelp.hidden = !help;
    if (help) {
      setText(refs.failureTitle, help.title); setText(refs.failureDetail, help.detail); setText(refs.failureNext, help.nextStep);
      refs.prepareRevision.hidden = !mayReviseChecklist(item);
    }
    setText(refs.facts, `代码提交：${item.candidateCommit || '尚未固定'}；模型调用${count(item.totalModelCalls)}；输入${count(item.usage?.inputTokens)}、输出${count(item.usage?.outputTokens)} token。`);
    refs.repair.disabled = !mayRepair(item); refs.cancel.disabled = !mayCancel(item); refs.download.hidden = !mayDownload(item); if (!refs.download.hidden) refs.download.href = `${base()}/${encodeURIComponent(item.id)}/download`; else refs.download.removeAttribute('href');
    if (openVerification) { refs.repair.hidden = refs.repairNoteField.hidden; refs.cancel.hidden = !item.active; refs.previewBox.hidden = !passed && !item.preview; }
    const preview = previewOf(item), link = previewLink(item), previewKnown = preview && Object.hasOwn(PREVIEW_STATES, preview.state);
    setText(refs.previewStatus, !previewFresh() ? '预览状态尚未确认，请等待本次读取或刷新核对。' : !item.preview ? '尚未启动软件预览。' : previewKnown ? PREVIEW_STATES[preview.state] : '预览状态未知，请刷新核对；不会据此启动或下载。');
    setText(refs.previewInfo, preview?.error || (preview ? `开始时间：${typeof preview.startedAt === 'string' ? preview.startedAt : '未知'}；到期时间：${typeof preview.expiresAt === 'string' ? preview.expiresAt : '未知'}。仅使用独立演示数据，停止后才能继续开发或下载。` : '预览只开放当前已验收版本，由后端确认启动与停止，不消耗模型用量。'));
    refs.previewStart.disabled = !mayPreview(item); refs.previewStop.disabled = !mayStopPreview(item); refs.previewAnchor.hidden = !link; if (link) refs.previewAnchor.href = link; else refs.previewAnchor.removeAttribute('href');
    refs.pause.hidden = refs.resume.hidden = item.executionMode !== 'task_dag'; refs.pause.disabled = !mayTaskControl(item, 'pause'); refs.resume.disabled = !mayTaskControl(item, 'resume');
    refs.recover.hidden = refs.recoveryNote.hidden = item.executionMode !== 'task_dag' || item.actions?.canRecover === undefined; refs.recover.disabled = !mayRecover(item);
    refs.taskSection.hidden = item.executionMode !== 'task_dag';
    const currentTasks = new Set();
    for (const task of Array.isArray(item.tasks) ? item.tasks : []) {
      if (!ID.test(task.id || '')) continue; currentTasks.add(task.id); let view = taskNodes.get(task.id);
      if (!view) { const card = node('details'), summary = node('summary'), info = node('p'), evidence = node('pre'); evidence.tabIndex = 0; card.append(summary, info, evidence); refs.taskList.append(card); view = { card, summary, info, evidence }; taskNodes.set(task.id, view); }
      setText(view.summary, `${task.title || task.id} · ${taskState(task)}`); setText(view.info, `任务 ${task.id}；依赖：${Array.isArray(task.dependsOn) && task.dependsOn.length ? task.dependsOn.join('、') : '无'}；代码：${task.candidateCommit ? task.candidateCommit.slice(0, 12) : '尚未固定'}。${task.error ? ` ${printable(task.error)}` : ''}`);
      setText(view.evidence, { baseCommit: task.baseCommit, candidateCommit: task.candidateCommit, attemptId: task.attemptId, errorCode: task.errorCode ?? null, error: task.error ?? null, usage: task.usage, checks: task.checks, diff: task.diff, history: task.history ?? [] });
    }
    for (const [id, view] of taskNodes) if (!currentTasks.has(id)) { view.card.remove(); taskNodes.delete(id); }
    renderGraph(item); renderCommands(item);
    setText(refs.binding, { binding: item.binding, budget: item.budget, baseCommit: item.baseCommit, candidateCommit: item.candidateCommit, proposalId: item.proposalId, revision: item.revision }); setText(refs.diff, item.diff || '尚无代码差异。');
    setText(refs.checks, { self: item.checks?.self ?? null, http: item.checks?.http ?? null, browser: item.checks?.browser ?? null }); setText(refs.review, { status: item.checks?.review ?? '尚未检查', issues: item.checks?.issues ?? [], history: item.reviewHistory ?? [] }); setText(refs.calls, item.modelCalls ?? []);
    const present = new Set(); for (const [index, event] of (Array.isArray(item.events) ? item.events : []).entries()) { const id = `${item.id}:${event.sequence ?? index}`; present.add(id); let eventNode = eventNodes.get(id); if (!eventNode) { const li = node('li'), time = node('time'), message = node('span'); li.append(time, message); refs.list.append(li); eventNode = { li, time, message }; eventNodes.set(id, eventNode); } setText(eventNode.time, `#${event.sequence ?? index + 1} ${event.at || '时间未知'}`); setText(eventNode.message, event.message); }
    for (const [id, eventNode] of eventNodes) if (!present.has(id)) { eventNode.li.remove(); eventNodes.delete(id); }
  }
  function reconcile() {
    if (!pending || !currentToken(pending)) return;
    const item = rows().find(entry => entry.id === pending.id);
    if (['preview', 'stop-preview'].includes(pending.kind)) {
      const preview = previewOf(item);
      if (!scoped(item) || !preview || preview.id !== pending.previewId || !Object.hasOwn(PREVIEW_STATES, preview.state)) return;
      if (pending.kind === 'preview' && (!currentRow(item) || item.proposalId !== pending.proposalId || item.revision !== pending.revision)) return;
      if (pending.kind === 'stop-preview' && ['preparing', 'starting', 'running'].includes(preview.state)) return;
      if (pending.selectionEdits === selectionEdits) selectedId = item.id;
      notice = preview.state === 'running' && preview.active === true ? '后续读取已确认预览运行；地址仍须符合当前版本与安全限制。' : preview.state === 'stopped' && preview.active === false ? '后续读取已确认软件预览停止。' : preview.state === 'reconciliation_required' ? '预览停止状态待核对，请保留记录；不会自动重新启动。' : '后续读取已核对预览请求，请以实际状态为准。';
      pending = null; remember(); return;
    }
    if (!scoped(item) || item.proposalId !== pending.proposalId || item.revision !== pending.revision || !sameBinding(item) || !Object.hasOwn(STATES, item.status)) return;
    if (pending.kind === 'recover' && (item.binding.sourceRevision !== pending.sourceRevision || item.binding.sourceGeneration !== pending.sourceGeneration
      || ['pause_requested', 'paused', 'paused_recovery_ready', 'recovery_requested'].includes(item.status))) return;
    if (pending.kind === 'cancel' && WORKING.has(item.status)) return;
    if (pending.kind === 'pause' && item.status === 'running' || pending.kind === 'resume' && ['pause_requested', 'paused'].includes(item.status)) return;
    if (pending.selectionEdits === selectionEdits) selectedId = item.id;
    notice = ['start', 'repair'].includes(pending.kind) ? pending.kind === 'repair' ? '后端已核对新的修复执行记录；原失败保留，新执行须重新独立验收。' : '后端已核对本次执行记录；开发仍以实际状态和独立验收为准。' : item.status === 'cancel_requested' ? '后端已记录停止请求，尚未确认停止。' : item.status === 'reconciliation_required' ? '停止状态待核对，尚未确认停止。' : item.status === 'stopped' ? '后端已确认本次开发停止。' : '已核对后端当前执行状态，请以实际结果为准。';
    if (pending.kind === 'pause') notice = item.status === 'paused' ? '后端已暂停派发新任务，已保存本批结果。' : item.status === 'pause_requested' ? '后端已记录暂停请求，在途任务结束后保存。' : '已核对本次任务状态，请查看实际结果。';
    if (pending.kind === 'resume') notice = item.status === 'running' ? '后端已恢复按依赖派发任务。' : '已核对本次任务状态，请查看实际结果。';
    if (pending.kind === 'recover') notice = item.status === 'running' ? '后端已从安全暂停点继续未完成任务；已完成任务和原有用量保留。' : item.status === 'reconciliation_required' ? '恢复状态待核对，原记录与额度保留；不会自动重复恢复。' : '已核对恢复后的实际任务状态，请查看验收结果。';
    pending = null; remember();
  }
  function schedule() { clearTimeout(timer); if (!destroyed && mounted && context.projectId && context.runId) timer = setTimeout(() => { void refresh(); }, 3000); }
  async function refresh() {
    if (!mounted || destroyed) return false; syncContext(); clearTimeout(timer); if (!context.projectId || !context.runId) { render(); return false; }
    const token = { epoch, key, read: ++readSerial, selectionEdits }; loading = true; previewRead = null; render();
    try {
      const [next, definitions] = await Promise.all([api(base(), { cache: 'no-store' }), api(proposalPath(), { cache: 'no-store' })]);
      if (!currentToken(token) || token.read !== readSerial) return false;
      if (!next?.capabilities || !Array.isArray(next.executions) || !Array.isArray(definitions?.proposals)) throw new Error('开发或验收定义记录不完整，请刷新核对。');
      if (new Set(next.executions.map(item => item?.id)).size !== next.executions.length || new Set(definitions.proposals.map(item => item?.id)).size !== definitions.proposals.length) throw new Error('记录编号存在冲突，请刷新核对；不会据此授权开发或下载。');
      data = next; proposals = definitions; fresh = true; error = ''; previewRead = token; reconcile(); return true;
    } catch (failure) { if (currentToken(token) && token.read === readSerial) { fresh = false; refs.consent.checked = false; report(failure); } return false; }
    finally { if (currentToken(token) && token.read === readSerial) { loading = false; render(); onUpdate(); notifyFailures(); schedule(); } }
  }
  async function perform(kind) {
    if (destroyed) return; if (syncContext()) { render(); void refresh(); return; }
    const selected = row(), definition = selectedDefinition(), isPreview = ['preview', 'stop-preview'].includes(kind); if (kind === 'start' ? !mayStart() : kind === 'repair' ? !mayRepair(selected) : kind === 'preview' ? !mayPreview(selected) : kind === 'stop-preview' ? !mayStopPreview(selected) : kind === 'recover' ? !mayRecover(selected) : ['pause', 'resume'].includes(kind) ? !mayTaskControl(selected, kind) : !mayCancel(selected)) return;
    const token = { epoch, key, kind, selectionEdits, proposalId: kind === 'start' ? definition.id : selected.proposalId, revision: kind === 'start' ? definition.revision : selected.revision,
      ...(kind === 'recover' ? { sourceRevision: selected.binding.sourceRevision, sourceGeneration: selected.binding.sourceGeneration } : {}) };
    const path = kind === 'start' ? `${base()}/start` : `${base()}/${encodeURIComponent(selected.id)}/${kind}`, body = kind === 'start' ? { proposalId: definition.id, revision: definition.revision, contractRevision: data.capabilities.contractRevision } : kind === 'repair' ? { contractRevision: data.capabilities.contractRevision } : {};
    if (kind === 'repair' && !refs.repairNoteField.hidden && refs.repairNote.value.trim()) body.repairNote = refs.repairNote.value.trim();
    action = token; pending = null; fresh = false; previewRead = null; readSerial++; clearTimeout(timer); error = ''; notice = ''; if (!isPreview) refs.consent.checked = false; render();
    try {
      const result = await api(path, { method: 'POST', body: JSON.stringify(body) }); if (!currentToken(token) || action !== token) return;
      if (!scoped(result?.execution) || ['cancel', 'pause', 'resume', 'recover', 'preview', 'stop-preview'].includes(kind) && result.execution.id !== selected.id
        || kind === 'recover' && (!sameBinding(result.execution) || result.execution.proposalId !== token.proposalId || result.execution.revision !== token.revision
          || result.execution.binding.sourceRevision !== token.sourceRevision || result.execution.binding.sourceGeneration !== token.sourceGeneration)
        || kind === 'repair' && (result.execution.id === selected.id || result.execution.proposalId !== token.proposalId || result.execution.revision !== token.revision)) throw new Error('操作返回未包含本次完整记录，请刷新核对；不会自动重新发起开发。');
      if (isPreview && (!result.preview || !ID.test(result.preview.id || '') || result.preview.executionId !== selected.id || kind === 'stop-preview' && result.preview.id !== previewOf(selected)?.id)) throw new Error('预览请求返回未能关联当前执行，请刷新核对。');
      pending = { ...token, id: result.execution.id, ...(isPreview ? { previewId: result.preview.id } : {}) }; notice = isPreview ? '预览请求已受理，等待后续读取确认；尚不开放地址或认定停止。' : '请求已受理，正在读取后端记录；尚未确认执行完成。'; await refresh();
    } catch (failure) { if (currentToken(token) && action === token) { fresh = false; report(failure); notice = '操作结果未确认，选择已保留。请刷新核对后再决定下一步；不会自动重复收费请求。'; } }
    finally { if (currentToken(token) && action === token) { action = null; render(); onUpdate(); schedule(); } else if (!destroyed && syncContext()) { render(); void refresh(); } }
  }
  return { async mount(host) { if (destroyed || mounted || !host?.append) throw new Error('规划开发面板只能挂载一次。'); mounted = true; build(host); return refresh(); }, refresh, workflowProgress, focusStage, guide, guideAct,
    destroy() { if (destroyed) return; remember(); destroyed = true; mounted = false; epoch++; readSerial++; action = null; pending = null; previewRead = null; clearTimeout(timer); root?.remove(); refs = null; eventNodes.clear(); taskNodes.clear(); graphNodes.clear(); savedSelections.clear(); notified.clear(); } };
}
