const STATUS = {
  preparing: '准备工作区', checking_environment: '检查执行环境', coding: '生成与修订代码',
  freezing: '固定代码版本', self_check: '运行自检', self_checking: '运行自检',
  awaiting_acceptance: '独立测试与审查中', accepted: '本次检查已结束',
  running: '执行中', failed: '执行失败', timed_out: '已达到时长上限',
  cancel_requested: '已请求停止，等待确认', cancelling: '正在停止，等待确认',
  stopping: '正在停止，等待确认', stopped: '已确认停止', cancelled: '已确认取消',
  reconciliation_required: '进程状态待核对，尚未确认停止',
  diagnostic_passed: '诊断检查通过，未计为任务验收',
};
const STYLE = `
.execution-panel{min-width:0;margin-top:22px;background:#fff;border:1px solid #e3e9f1;border-radius:12px;color:#344c6d;overflow:hidden;font:12px/1.8 "Microsoft YaHei","DengXian","PingFang SC",sans-serif}
.execution-panel *{box-sizing:border-box;min-width:0}.execution-panel [hidden]{display:none!important}
.execution-panel .ep-heading,.execution-panel .ep-body{padding:20px 22px}.execution-panel .ep-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:1px solid #e3e9f1}
.execution-panel h2{font-size:16px;font-weight:500;margin:0 0 4px}.execution-panel h3{font-size:13px;font-weight:500;margin:16px 0 8px}.execution-panel p{margin:6px 0;overflow-wrap:anywhere}
.execution-panel .ep-muted{color:#70829b;font-size:11px}.execution-panel .ep-controls{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-top:14px}
.execution-panel label{display:block}.execution-panel .ep-field{flex:1 1 240px}.execution-panel label>span{display:block;margin-bottom:6px}
.execution-panel select{width:100%;max-width:100%;min-height:38px;padding:7px 10px;border:1px solid #cedaeb;border-radius:5px;background:#fff;color:#344c6d;font:inherit}
.execution-panel button,.execution-panel .ep-link{display:inline-flex;justify-content:center;align-items:center;min-height:38px;padding:7px 13px;border:1px solid #d5dfed;border-radius:5px;background:#fff;color:#456384;font:inherit;text-decoration:none;cursor:pointer;white-space:normal;text-align:center;overflow-wrap:anywhere}
.execution-panel .ep-primary{background:#315deb;border-color:#315deb;color:#fff}.execution-panel button:disabled,.execution-panel select:disabled{opacity:.5;cursor:not-allowed}
.execution-panel button:focus-visible,.execution-panel select:focus-visible,.execution-panel input:focus-visible,.execution-panel a:focus-visible,.execution-panel summary:focus-visible{outline:3px solid #94aaf3;outline-offset:3px}
.execution-panel .ep-scope{padding:12px 14px;background:#f7f9ff;border:1px solid #e2e9f5;border-radius:6px;overflow-wrap:anywhere}
.execution-panel .ep-consent{display:flex;align-items:flex-start;gap:8px;margin:14px 0}.execution-panel .ep-consent input{margin:5px 0 0;flex:none}.execution-panel .ep-consent>span{margin:0}
.execution-panel .ep-notice{padding:10px 13px;background:#fff7e7;color:#95671f;border-radius:5px;margin:12px 0;overflow-wrap:anywhere}.execution-panel .ep-error{background:#fff0f1;color:#a53f4b}
.execution-panel .ep-history{margin-top:22px;padding-top:18px;border-top:1px solid #e3e9f1}.execution-panel .ep-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.execution-panel .ep-result{font-size:14px;color:#5a7190}.execution-panel .ep-result[data-accepted=true]{color:#16846a}
.execution-panel .ep-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 20px;margin:13px 0}.execution-panel .ep-facts p{margin:0}
.execution-panel details{border:1px solid #e2e8f1;border-radius:5px;margin:10px 0;padding:10px 13px}.execution-panel summary{cursor:pointer;overflow-wrap:anywhere}.execution-panel pre{max-width:100%;max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;background:#f6f8fc;border-radius:4px;padding:12px;font:11px/1.8 Consolas,"Microsoft YaHei",monospace;margin:8px 0}
.execution-panel .ep-event-list{max-height:330px;overflow:auto;padding-left:24px;margin:8px 0}.execution-panel .ep-event-list li{padding:6px 0;border-bottom:1px solid #eef1f5;overflow-wrap:anywhere}.execution-panel time{display:block;color:#8493aa;font-size:10px}
@media(max-width:760px){.execution-panel .ep-heading,.execution-panel .ep-body{padding:17px 15px}.execution-panel .ep-heading{gap:10px}.execution-panel h2{font-size:14px}.execution-panel .ep-heading>button{padding:5px 10px;flex:none}.execution-panel .ep-facts{grid-template-columns:1fr}.execution-panel .ep-controls>.ep-primary{width:100%}.execution-panel .ep-actions>*{flex:1 1 130px}.execution-panel pre{font-size:11px;padding:9px}}
`;

const text = value => value == null ? '未知' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const count = value => Number.isFinite(value) && value >= 0 ? String(value) : '未知';
const snapshotKey = context => JSON.stringify([context.projectId, context.runId, context.planningStatus, context.specRevision, context.planRevision]);
const confirmed = context => context.planningStatus === 'confirmed' && !!context.specRevision && !!context.planRevision;
const displayStatus = status => STATUS[status] || (status ? `服务状态：${status}` : '等待服务状态');
const pretty = value => value == null ? '尚无记录' : text(value);
const checkStatus = status => ({ passed: '通过', failed: '未通过', checking: '检查中', completed: '审查完成',
  changes_requested: '需要修订', error: '检查未完成', cancelled: '已取消', resolved: '已解决', open: '待解决' })[status] || displayStatus(status);

function evidenceSummary(name, value) {
  if (value == null) return '尚无记录';
  if (name === 'issues') {
    const issues = Array.isArray(value.issues) ? value.issues : [];
    return `已记录 ${issues.length} 项问题；尚未关闭的阻塞问题 ${Array.isArray(value.openIssues) ? value.openIssues.length : '未知'} 项。`;
  }
  const checks = Array.isArray(value.checks) ? value.checks : null;
  return `${checkStatus(value.status)}${checks ? `；通过 ${checks.filter(item => item.passed === true).length} / ${checks.length} 项` : ''}${value.summary ? `。${text(value.summary)}` : ''}${value.error ? `。${text(value.error)}` : ''}`;
}

function budgetText(budget) {
  const milliseconds = budget?.maxDurationMs ?? budget?.timeoutMs;
  return `编码最多 ${count(budget?.maxCalls)} 次；独立审查最多 ${count(budget?.maxReviewCalls)} 次；总时长 ${Number.isFinite(milliseconds) && milliseconds > 0 ? `${Math.round(milliseconds / 1000)} 秒` : '未知'}`;
}

function previewURL(preview) {
  if (!preview || typeof preview.url !== 'string') return null;
  const match = /^http:\/\/(localhost|127\.0\.0\.1):([0-9]{1,5})(?=\/|[?#]|$)/i.exec(preview.url);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 || /[\s\\]/.test(preview.url)) return null;
  try {
    const url = new URL(preview.url);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password) return null;
    if (preview.expiresAt != null && (!Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= Date.now())) return null;
    return url.href;
  } catch { return null; }
}

/** Backend facts control every action; model and log strings are always text nodes. */
export function createExecutionPanel({ api, getContext, onError = () => {} }) {
  if (typeof api !== 'function' || typeof getContext !== 'function') throw new TypeError('执行面板需要api和getContext。');
  let root, refs, mounted = false, destroyed = false, timer, request = 0, context = {}, key = '';
  let data = null, loadState = 'idle', error = '', activeAction = null, selectedId = '', preview = null, profileSignature = '';
  let inFlight = null, inFlightKey = '', inFlightSerial = 0, contentId = '', versionNodes = new Map(), eventNodes = new Map();

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content != null) element.textContent = content;
    return element;
  }
  function button(label, handler, primary = false) {
    const element = node('button', primary ? 'ep-primary' : '', label);
    element.type = 'button'; element.addEventListener('click', handler); return element;
  }
  function field(label, control) {
    const element = node('label', 'ep-field'); element.append(node('span', '', label), control); return element;
  }
  function section(title, parent, open = false) {
    const details = node('details'); details.open = open;
    details.append(node('summary', '', title)); const body = node('div'); details.append(body); parent.append(details);
    return { details, body };
  }
  function setError(value, report = true) {
    error = value instanceof Error ? value.message : String(value || '');
    if (report && value) { try { onError(value instanceof Error ? value : new Error(error)); } catch { /* Host notices cannot change execution facts. */ } }
  }
  function basePath() { return `/api/projects/${encodeURIComponent(context.projectId)}/runs/${encodeURIComponent(context.runId)}/executions`; }
  function currentExecution() { return data?.executions?.find(item => item.id === selectedId) || null; }
  function syncContext() {
    const next = getContext() || {}, nextKey = snapshotKey(next);
    if (key === nextKey) return false;
    context = { ...next }; key = nextKey; request++; activeAction = null; data = null; loadState = 'idle'; error = ''; selectedId = ''; preview = null;
    profileSignature = ''; if (refs) refs.consent.checked = false;
    return true;
  }
  function isCurrent(savedKey) { return !destroyed && key === savedKey && snapshotKey(getContext() || {}) === savedKey; }
  function schedule() {
    clearTimeout(timer);
    if (mounted && !destroyed && context.projectId && context.runId && loadState !== 'unavailable') timer = setTimeout(() => { void refresh(); }, 3000);
  }
  function build(element) {
    root = node('section', 'execution-panel'); root.setAttribute('aria-label', '代码执行与验收');
    const style = node('style', '', STYLE); root.append(style);
    const heading = node('header', 'ep-heading'), title = node('div');
    title.append(node('h2', '', '代码执行与验收'), node('p', 'ep-muted', '查看真实代码版本、独立检查和每轮修订依据。文档完成不代表软件通过验收。'));
    const refreshButton = button('刷新状态', () => { void refresh(); }); heading.append(title, refreshButton); root.append(heading);
    const body = node('div', 'ep-body'); root.append(body);
    const notice = node('p', 'ep-notice'); notice.setAttribute('role', 'status');
    const errorBox = node('p', 'ep-notice ep-error'); errorBox.setAttribute('role', 'alert');
    const scope = node('div', 'ep-scope');
    scope.append(node('p', '', '首版仅开放服务端列出的固定示例，不支持将任意需求直接生成软件。执行使用服务端已配置的模型，会产生正常用量。'));
    const profileDescription = node('p'), model = node('p', 'ep-muted'), budget = node('p', 'ep-muted'), recheckBudget = node('p', 'ep-muted'), repairBudget = node('p', 'ep-muted'); scope.append(profileDescription, model, budget, recheckBudget, repairBudget);
    const profiles = node('select'); profiles.setAttribute('aria-label', '执行范围');
    const startButton = button('使用配置模型开始执行', () => { void perform('start'); }, true);
    const controls = node('div', 'ep-controls'); controls.append(field('执行范围', profiles), startButton);
    const consentLabel = node('label', 'ep-consent'), consent = node('input'); consent.type = 'checkbox';
    consentLabel.append(consent, node('span', '', '我确认按上述范围和预算调用配置模型。'));
    const revisions = node('p', 'ep-muted'); body.append(notice, errorBox, scope, controls, consentLabel, revisions);
    const history = node('div', 'ep-history'), executions = node('select'); executions.setAttribute('aria-label', '执行记录');
    history.append(field('执行记录', executions)); body.append(history);
    const empty = node('p', 'ep-muted'), detail = node('div'); history.append(empty, detail);
    const result = node('p', 'ep-result'), state = node('p'), failure = node('p', 'ep-notice ep-error'), facts = node('div', 'ep-facts');
    const identity = node('p'), calls = node('p'), usage = node('p'), executionBudget = node('p'); facts.append(identity, calls, usage, executionBudget);
    const actions = node('div', 'ep-actions');
    const cancel = button('请求停止', () => { void perform('cancel'); }), retry = button('重新执行', () => { void perform('retry'); });
    const recheck = button('重新检查固定代码', () => { void perform('recheck'); });
    const repair = button('保留代码并修复', () => { void perform('repair'); });
    const showPreview = button('启动本地预览', () => { void perform('preview'); }), stopPreview = button('停止预览', () => { void perform('stop_preview'); });
    const previewLink = node('a', 'ep-link', '打开本地预览'); previewLink.target = '_blank'; previewLink.rel = 'noopener noreferrer';
    const download = node('a', 'ep-link', '下载已验收源码'); download.setAttribute('download', '');
    actions.append(cancel, retry, recheck, repair, showPreview, stopPreview, previewLink, download);
    const recheckNotice = node('p', 'ep-muted'), repairNotice = node('p', 'ep-muted'), previewNotice = node('p', 'ep-muted'), versions = node('div');
    const diff = section('本次代码差异', detail), diffText = node('pre'); diff.body.append(diffText);
    const eventSection = section('真实执行事件', detail, true), eventList = node('ol', 'ep-event-list'), noEvents = node('p', 'ep-muted', '尚无执行事件。');
    eventSection.body.append(noEvents, eventList);
    detail.prepend(result, state, failure, facts, recheckNotice, repairNotice, actions, previewNotice, node('h3', '', '代码版本与独立检查'), versions);
    refs = { refreshButton, notice, errorBox, profileDescription, model, budget, recheckBudget, repairBudget, profiles, startButton, consent, revisions, executions, empty, detail,
      result, state, failure, identity, calls, usage, executionBudget, cancel, retry, recheck, repair, recheckNotice, repairNotice, showPreview, stopPreview, previewLink, download, previewNotice, versions, diffText, eventList, noEvents };
    profiles.addEventListener('change', () => { consent.checked = false; render(); });
    consent.addEventListener('change', render);
    executions.addEventListener('change', () => { selectedId = executions.value; consent.checked = false; preview = null; render(); });
    element.append(root);
  }

  function updateOptions(select, items, selected, emptyLabel) {
    const signature = JSON.stringify(items);
    if (select.dataset.options !== signature) {
      select.replaceChildren(...(items.length ? items.map(item => { const option = node('option', '', item.label); option.value = item.id; return option; }) : [node('option', '', emptyLabel)]));
      select.dataset.options = signature;
    }
    if (items.some(item => item.id === selected)) select.value = selected;
    return items.length ? select.value : '';
  }
  function renderVersions(execution) {
    const versions = Array.isArray(execution.versions) ? execution.versions : [];
    const retained = new Set();
    versions.forEach((version, index) => {
      const id = `${index}:${version.commit || ''}`; retained.add(id);
      let card = versionNodes.get(id);
      if (!card) {
        const main = section('', refs.versions, index === versions.length - 1), title = main.details.firstChild;
        const identity = node('p', 'ep-muted'); main.body.append(identity);
        const blocks = {};
        for (const [name, label] of [['diff', '代码差异'], ['selfCheck', '编码自检'], ['http', '独立HTTP与SQLite检查'], ['browser', '独立浏览器检查'], ['review', '独立Review'], ['issues', '问题与处理历史']]) {
          const item = section(label, main.body), summary = node('p'), findings = node('div');
          item.body.append(summary, findings);
          const raw = name === 'diff' ? item : section('原始检查证据', item.body), pre = node('pre'); raw.body.append(pre);
          blocks[name] = { ...item, pre, summary, findings, findingNodes: new Map() };
        }
        card = { ...main, title, identity, blocks }; versionNodes.set(id, card);
      }
      card.title.textContent = `版本 ${index + 1} · ${version.commit || '尚未固定提交'}`;
      card.identity.textContent = `代码摘要：${text(version.sourceHash)}；独立门禁：${version.acceptance ? checkStatus(version.acceptance.status) : '尚无记录'}`;
      const values = { diff: version.diff, selfCheck: version.selfCheck, http: version.httpChecks ?? version.acceptance?.test,
        browser: version.browserChecks ?? version.acceptance?.browser, review: version.review ?? version.acceptance?.review,
        issues: version.acceptance ? { issues: version.acceptance.issues ?? [], openIssues: version.acceptance.openIssues ?? [] } : null };
      for (const [name, value] of Object.entries(values)) {
        const block = card.blocks[name]; block.pre.textContent = pretty(value);
        block.summary.hidden = name === 'diff'; block.summary.textContent = evidenceSummary(name, value);
        const findings = name === 'issues' ? value?.issues : value?.checks?.filter(item => item.passed !== true);
        const retainedFindings = new Set();
        for (const [index, finding] of (Array.isArray(findings) ? findings : []).entries()) {
          const findingId = String(finding.id ?? index); retainedFindings.add(findingId);
          let p = block.findingNodes.get(findingId);
          if (!p) { p = node('p', 'ep-muted'); block.findings.append(p); block.findingNodes.set(findingId, p); }
          p.textContent = `${finding.id || `检查 ${index + 1}`} · ${name === 'issues' ? checkStatus(finding.status) : '未通过'}${finding.severity === 'blocking' ? ' · 阻塞问题' : ''}${finding.file ? ` · ${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''}：${text(finding.message ?? finding.title ?? finding.name ?? finding.error ?? '服务端未提供说明')}${finding.expected ? `；预期：${text(finding.expected)}` : ''}${finding.actual ? `；实际：${text(finding.actual)}` : ''}${finding.resolution ? `；处理依据：${text(finding.resolution)}` : ''}`;
        }
        for (const [findingId, p] of block.findingNodes) if (!retainedFindings.has(findingId)) { p.remove(); block.findingNodes.delete(findingId); }
      }
    });
    for (const [id, card] of versionNodes) if (!retained.has(id)) { card.details.remove(); versionNodes.delete(id); }
    if (!versions.length) refs.versions.textContent = '尚无固定代码版本。';
    else if (refs.versions.firstChild?.nodeType === Node.TEXT_NODE) refs.versions.firstChild.remove();
  }
  function renderEvents(execution) {
    const events = Array.isArray(execution.events) ? execution.events : [], retained = new Set();
    events.forEach((event, index) => {
      const id = `${event.sequence ?? index}`; retained.add(id); let item = eventNodes.get(id);
      if (!item) { const li = node('li'), time = node('time'), message = node('span'); li.append(time, message); refs.eventList.append(li); item = { li, time, message }; eventNodes.set(id, item); }
      item.time.textContent = `#${event.sequence ?? index + 1} ${event.time || '时间未知'}`;
      item.message.textContent = text(event.message);
    });
    for (const [id, item] of eventNodes) if (!retained.has(id)) { item.li.remove(); eventNodes.delete(id); }
    refs.noEvents.hidden = events.length > 0;
  }
  function render() {
    if (!refs || destroyed) return;
    const busy = activeAction !== null;
    const ready = loadState === 'ready', capabilities = data?.capabilities || {}, profiles = Array.isArray(capabilities.profiles) ? capabilities.profiles : [];
    const selectedRepair = data?.executions?.find(item => item.id === selectedId) ?? data?.executions?.[0];
    const signature = JSON.stringify([profiles, capabilities.model, capabilities.budget, capabilities.recheckBudget, capabilities.repairBudget, selectedRepair?.repairBudget, selectedRepair?.repairContractRevision]);
    if (signature !== profileSignature) { refs.consent.checked = false; profileSignature = signature; }
    const profileId = updateOptions(refs.profiles, profiles.map(item => ({ id: item.id, label: item.title || item.id })), refs.profiles.value, '暂无可执行范围');
    const profile = profiles.find(item => item.id === profileId);
    refs.profileDescription.textContent = profile ? `${profile.description || '服务端尚未提供范围说明。'}（范围版本：${text(profile.contractRevision)}）` : '服务端尚未提供可执行范围。';
    refs.model.textContent = `配置模型：${capabilities.model?.name || '名称未知，以服务端配置为准'}`;
    refs.budget.textContent = `本轮预算：${budgetText(capabilities.budget)}`;
    refs.recheckBudget.hidden = !capabilities.recheckBudget;
    refs.recheckBudget.textContent = capabilities.recheckBudget ? `固定代码重新检查的独立预算：${budgetText(capabilities.recheckBudget)}。保留原提交，全部检查和Review重新执行，旧失败和用量保留。` : '';
    refs.repairBudget.hidden = !capabilities.repairBudget;
    refs.repairBudget.textContent = capabilities.repairBudget ? `保留代码并修复的本轮预算：${budgetText(capabilities.repairBudget)}。模型根据原代码及有效阻塞意见生成新版本，全部检查和Review重新执行，旧失败和用量保留。` : '';
    refs.revisions.textContent = `当前规格版本：${text(context.specRevision)}；计划版本：${text(context.planRevision)}`;
    refs.notice.hidden = false;
    refs.notice.textContent = !context.projectId || !context.runId ? '选择一个已确认规格与计划的运行后查看执行。'
      : loadState === 'unavailable' ? '当前版本尚未开放网页执行。'
        : !confirmed(context) ? '当前规格与计划尚未同时确认，暂不能启动代码执行。'
          : !ready ? loadState === 'loading' ? '正在读取执行能力与记录…' : '暂未取得最新执行状态，可刷新后重试。'
            : capabilities.canStart !== true ? capabilities.reason || '服务端暂未开放本次执行。' : '';
    refs.notice.hidden = !refs.notice.textContent;
    refs.errorBox.textContent = error; refs.errorBox.hidden = !error;
    refs.refreshButton.disabled = busy;
    refs.startButton.disabled = busy || !ready || !confirmed(context) || capabilities.canStart !== true || !profile?.id || !profile.contractRevision || !refs.consent.checked;
    refs.profiles.disabled = busy || !ready || !profiles.length; refs.consent.disabled = busy || !ready;
    const executions = Array.isArray(data?.executions) ? data.executions : [];
    if (!executions.some(item => item.id === selectedId)) { selectedId = executions[0]?.id || ''; preview = null; }
    updateOptions(refs.executions, executions.map(item => ({ id: item.id, label: `${item.id} · ${displayStatus(item.status)}` })), selectedId, '尚无代码执行记录');
    refs.executions.disabled = busy || !executions.length;
    const execution = currentExecution(); refs.detail.hidden = !execution; refs.empty.hidden = !!execution;
    refs.empty.textContent = loadState === 'unavailable' ? '现有文档产物仍是规划文档，尚无网页代码执行记录。' : '启动后可在这里查看真实执行记录。';
    if (!execution) return;
    if (contentId !== execution.id) { contentId = execution.id; refs.versions.replaceChildren(); refs.eventList.replaceChildren(); versionNodes = new Map(); eventNodes = new Map(); }
    refs.result.textContent = execution.taskAccepted === true ? '当前固定示例已通过验收' : '本次任务尚未通过验收';
    refs.result.dataset.accepted = String(execution.taskAccepted === true);
    refs.state.textContent = `${displayStatus(execution.status)}${execution.stage ? ` · 当前阶段：${text(execution.stage)}` : ''}`;
    refs.failure.textContent = execution.error ? text(execution.error) : ''; refs.failure.hidden = !execution.error;
    refs.identity.textContent = `执行编号：${execution.id}`;
    refs.calls.textContent = `编码调用：${count(execution.calls)} 次；独立审查：${count(execution.reviewCalls)} 次`;
    refs.usage.textContent = `输入用量：${count(execution.usage?.inputTokens)} token；输出用量：${count(execution.usage?.outputTokens)} token`;
    refs.executionBudget.textContent = `执行预算：${budgetText(execution.budget)}`;
    const actions = execution.actions || {};
    for (const [element, permission] of [[refs.cancel, 'canCancel'], [refs.retry, 'canRetry'], [refs.recheck, 'canRecheck'], [refs.repair, 'canRepair'], [refs.showPreview, 'canPreview'], [refs.stopPreview, 'canStopPreview']]) {
      element.hidden = actions[permission] !== true; element.disabled = busy || !ready || actions[permission] !== true;
    }
    refs.retry.disabled ||= !confirmed(context) || !refs.consent.checked || !profile?.id || !profile.contractRevision || profile.id !== execution.profileId;
    const checkBudget = execution.recheckBudget ?? capabilities.recheckBudget;
    const recheckScope = profile?.id === execution.profileId && profile?.contractRevision === (execution.recheckContractRevision ?? execution.contractRevision);
    const recheckBudgetKnown = checkBudget?.maxCalls === 0 && Number.isInteger(checkBudget.maxReviewCalls) && checkBudget.maxReviewCalls >= 1 && checkBudget.maxReviewCalls <= 2
      && Number.isInteger(checkBudget.timeoutMs) && checkBudget.timeoutMs > 0;
    refs.recheck.disabled ||= !confirmed(context) || !refs.consent.checked || !recheckScope || !recheckBudgetKnown;
    const repairBudget = execution.repairBudget ?? capabilities.repairBudget;
    const repairScope = profile?.id === execution.profileId && profile?.contractRevision === execution.repairContractRevision;
    const repairBudgetKnown = Number.isInteger(repairBudget?.maxCalls) && repairBudget.maxCalls >= 1 && repairBudget.maxCalls <= 3
      && Number.isInteger(repairBudget.maxReviewCalls) && repairBudget.maxReviewCalls >= 1 && repairBudget.maxReviewCalls <= 3
      && Number.isInteger(repairBudget.timeoutMs) && repairBudget.timeoutMs > 0 && repairBudget.timeoutMs <= 600000;
    refs.repair.disabled ||= !confirmed(context) || !refs.consent.checked || !repairScope || !repairBudgetKnown;
    refs.repairNotice.hidden = execution.operation !== 'repair' && actions.canRepair !== true;
    refs.repairNotice.textContent = execution.operation === 'repair'
      ? `本次从原提交 ${text(execution.repairSourceCommit)} 修复；原编码记录 ${text(execution.repairSourceExecutionId)}，阻塞意见记录 ${text(execution.repairFindingExecutionId)}。会保留该代码历史中的全部已知有效阻塞意见。新代码与全部检查归本次尝试，旧失败和用量保留。`
      : `保留提交 ${text(execution.versions?.at(-1)?.commit)} 的代码及其历史中的全部已知有效阻塞意见，由模型修复形成新版本。${budgetText(repairBudget)}。所有问题必须逐项复核关闭，检查和Review全新执行。`;
    refs.recheckNotice.hidden = execution.kind !== 'web_recheck' && actions.canRecheck !== true;
    refs.recheckNotice.textContent = execution.kind === 'web_recheck'
      ? `本次固定原提交 ${text(execution.sourceCommit)}；来源记录 ${text(execution.sourceExecutionId)}。本次编码调用：${count(execution.calls)} 次；检查和Review均为本次全新执行，旧记录及用量保留。`
      : `重新检查固定代码会保留提交 ${text(execution.versions?.at(-1)?.commit)}，不修改源码；${budgetText(checkBudget)}。全部检查与Review重新执行，原记录不覆盖。`;
    refs.download.hidden = !ready || actions.canDownload !== true || execution.taskAccepted !== true;
    if (refs.download.hidden) refs.download.removeAttribute('href'); else refs.download.href = `${basePath()}/${encodeURIComponent(execution.id)}/download`;
    const previewValue = Object.hasOwn(execution, 'preview') ? execution.preview : preview, url = previewURL(previewValue);
    refs.previewLink.hidden = !ready || !url;
    if (refs.previewLink.hidden) refs.previewLink.removeAttribute('href'); else refs.previewLink.href = url;
    refs.previewNotice.textContent = previewValue ? url ? `本地预览${previewValue.expiresAt ? `有效至 ${previewValue.expiresAt}` : '有效期未知'}，停止后需重新启动。` : '预览地址不符合本机安全范围或已过期，请重新启动预览。' : '';
    refs.diffText.textContent = pretty(execution.diff); renderVersions(execution); renderEvents(execution);
  }

  async function refresh() {
    if (!mounted || destroyed) return;
    clearTimeout(timer); syncContext();
    if (!context.projectId || !context.runId) { render(); return; }
    if (activeAction) { render(); schedule(); return; }
    if (inFlight && inFlightKey === key && inFlightSerial === request) return inFlight;
    const savedKey = key, serial = ++request;
    if (!data) loadState = 'loading'; render();
    const pending = (async () => {
      try {
        const response = await api(basePath(), { cache: 'no-store' });
        if (!isCurrent(savedKey) || serial !== request) return;
        if (!response || !response.capabilities || !Array.isArray(response.executions)) throw new Error('执行状态格式无效，请刷新后重试。');
        data = response; loadState = 'ready'; error = '';
      } catch (cause) {
        if (!isCurrent(savedKey) || serial !== request) return;
        loadState = Number(cause?.status ?? cause?.statusCode) === 404 ? 'unavailable' : 'error';
        if (loadState === 'unavailable') error = ''; else setError(cause);
      } finally {
        if (isCurrent(savedKey) && serial === request) { render(); schedule(); }
      }
    })();
    inFlight = pending; inFlightKey = savedKey; inFlightSerial = serial;
    try { await pending; } finally { if (inFlight === pending) { inFlight = null; inFlightKey = ''; } }
  }
  async function perform(action) {
    if (destroyed) return;
    if (syncContext()) { render(); void refresh(); return; }
    if (activeAction) return;
    const execution = currentExecution(), profile = data?.capabilities?.profiles?.find(item => item.id === refs.profiles.value);
    const permitted = action === 'start' ? !refs.startButton.disabled
      : loadState === 'ready' && execution?.actions?.[{ cancel: 'canCancel', retry: 'canRetry', recheck: 'canRecheck', repair: 'canRepair', preview: 'canPreview', stop_preview: 'canStopPreview' }[action]] === true;
    if (!permitted || (['retry', 'recheck', 'repair'].includes(action) && (!confirmed(context) || !refs.consent.checked))
      || (action === 'retry' && refs.retry.disabled) || (action === 'recheck' && refs.recheck.disabled) || (action === 'repair' && refs.repair.disabled)) return;
    const savedKey = key, path = action === 'start' ? `${basePath()}/start` : `${basePath()}/${encodeURIComponent(execution.id)}/action`;
    const payload = action === 'start' ? { profileId: profile.id, contractRevision: profile.contractRevision }
      : { action, ...(['retry', 'recheck', 'repair'].includes(action) ? { profileId: profile.id, contractRevision: profile.contractRevision } : {}) };
    // Context changes detach the pending action without claiming its backend
    // work stopped. A unique token also rejects stale replies after A→B→A.
    const token = { key: savedKey }; activeAction = token;
    request++; error = ''; clearTimeout(timer); render();
    try {
      const response = await api(path, { method: 'POST', body: JSON.stringify(payload) });
      if (activeAction !== token || !isCurrent(savedKey)) return;
      if (!response?.execution?.id) throw new Error('服务端未返回执行记录，请刷新核对状态后再操作。');
      const next = response.execution, executions = data?.executions || [], index = executions.findIndex(item => item.id === next.id);
      data.executions = index < 0 ? [next, ...executions] : executions.map(item => item.id === next.id ? next : item);
      selectedId = next.id; loadState = 'ready';
      if (action === 'repair') refs.consent.checked = false;
      if (action === 'stop_preview' || action === 'cancel' || action === 'retry' || action === 'recheck' || action === 'repair' || action === 'start') preview = null;
      if (response.preview) { next.preview = response.preview; preview = response.preview; if (!previewURL(preview)) setError('服务端返回的预览地址不符合本机安全范围或已过期。'); }
    } catch (cause) {
      if (activeAction === token && isCurrent(savedKey)) { loadState = Number(cause?.status ?? cause?.statusCode) === 404 ? 'unavailable' : 'error'; setError(cause); }
    }
    finally {
      if (activeAction === token) {
        activeAction = null;
        if (isCurrent(savedKey)) { render(); schedule(); } else if (!destroyed) { syncContext(); render(); void refresh(); }
      }
    }
  }

  return {
    mount(element) {
      if (mounted || destroyed || !element?.append) throw new Error('执行面板只能挂载一次。');
      mounted = true; build(element); syncContext(); render(); return refresh();
    },
    refresh,
    destroy() { destroyed = true; mounted = false; request++; activeAction = null; clearTimeout(timer); root?.remove(); refs = null; },
  };
}
