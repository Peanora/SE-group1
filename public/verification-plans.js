import { repeatedCounterSteps } from './verification-draft.js';

const HASH = /^[a-f0-9]{64}$/u;
const STATUSES = { generating: '正在生成提案', cancel_requested: '已请求停止，等待确认', draft: '待审阅定义', rejected: '已驳回定义', approved: '已认可定义（尚未运行）', superseded: '历史定义已被替代', cancelled: '已确认取消', timed_out: '生成超时', stale: '规划版本已失效', failed: '提案生成失败', reconciliation_required: '停止或回执状态待核对' };
const STYLE = `
.verification-plans{margin-top:20px;min-width:0;padding:20px 22px;border:1px solid #e3e9f1;border-radius:12px;background:#fff;color:#344c6d;font:13px/1.8 "Microsoft YaHei",sans-serif}
.verification-plans *{box-sizing:border-box;min-width:0}.verification-plans [hidden]{display:none!important}.verification-plans h2{margin:0;font-size:19px}.verification-plans h3{font-size:15px}
.verification-plans p,.verification-plans summary{overflow-wrap:anywhere}.verification-plans label{display:grid;gap:5px;margin:12px 0}.verification-plans textarea,.verification-plans select{width:100%;max-width:100%;padding:8px;border:1px solid #cfd9e6;border-radius:6px;background:#fff;color:inherit;font:inherit}
.verification-plans textarea{min-height:90px;resize:vertical}.verification-plans .vp-json{min-height:270px;font:12px/1.7 monospace}.verification-plans .vp-consent{display:flex;align-items:flex-start;gap:8px}.verification-plans .vp-consent input{flex:none;margin-top:7px}
.verification-plans button{padding:8px 13px;margin:4px 8px 4px 0;border:1px solid #cbd7e7;border-radius:6px;background:#f8fafc;color:#344c6d;font:inherit;cursor:pointer;white-space:normal}.verification-plans button:disabled{opacity:.5;cursor:default}.verification-plans .vp-primary{background:#2469b0;border-color:#2469b0;color:white}
.verification-plans .vp-note{padding:10px 12px;border-left:3px solid #90b6dc;background:#f3f7fc}.verification-plans .vp-error{border-color:#c25b4f;background:#fff4f2;color:#983c35}.verification-plans pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;padding:10px;background:#f4f6f9;font:12px/1.7 monospace}.verification-plans details{margin:12px 0}.verification-plans summary{cursor:pointer;font-weight:600}
@media(max-width:600px){.verification-plans{padding:16px 12px}.verification-plans button{width:100%;margin:5px 0}}
`;
const text = value => value == null ? '未知' : String(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '未知';
const pretty = value => JSON.stringify(value, null, 2) ?? '';
const contextValue = value => Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision', 'planningStatus'].map(key => [key, typeof value?.[key] === 'string' ? value[key] : '']));
const contextKey = value => JSON.stringify(value);
const bindingKey = value => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const sessionKey = value => `taskflow.verificationPlans.${JSON.stringify([value.projectId, value.runId, value.specRevision, value.planRevision])}`;
const httpStepOverflow = detail => Number.isSafeInteger(detail?.httpSteps) && Number.isSafeInteger(detail?.maxHttpSteps) && detail.httpSteps > detail.maxHttpSteps
  ? `这份草案有 ${detail.httpSteps} 个接口步骤，上限是 ${detail.maxHttpSteps} 个。` : '';

/** HTTP test definitions only. Server facts never become software acceptance in this component. */
export function createVerificationPlans({ api, getContext, onError = () => {}, onUpdate = () => {}, onApproved = () => {}, failureRecovery = false, canEdit = () => true, autoRepairOnPropose = false }) {
  if (typeof api !== 'function' || typeof getContext !== 'function') throw new TypeError('测试提案面板需要api和运行上下文。');
  let root, refs, mounted = false, destroyed = false, timer, epoch = 0, readId = 0, action = null, pending = null;
  let context = contextValue(null), key = '', data = null, fresh = false, loading = false, error = '', errorKind = '', notice = '', consentKey = '';
  let saved = { selectedId: '', loadedKey: '', drafts: {}, importJSON: '', importFeedback: '' }, draft = null;
  let diagnosticKey = '', diagnosticRead = 0, diagnosis = null, openingDraft = false;
  let automaticRepairId = '';
  const sessions = new Map();
  const loginRecoveries = new Map();
  const node = (tag, value, className) => { const element = document.createElement(tag); if (value != null) element.textContent = value; if (className) element.className = className; return element; };
  function button(label, handler, primary = false) { const element = node('button', label, primary ? 'vp-primary' : ''); element.type = 'button'; element.addEventListener('click', handler); return element; }
  function field(label, control) { const wrapper = node('label'); control.setAttribute('aria-label', label); wrapper.append(node('span', label), control); return wrapper; }
  const rows = () => Array.isArray(data?.proposals) ? data.proposals : [];
  const selected = () => rows().find(row => row.id === saved.selectedId);
  const base = () => `/api/projects/${encodeURIComponent(context.projectId)}/runs/${encodeURIComponent(context.runId)}/verification-plans`;
  const repairPath = row => `${base()}/${encodeURIComponent(row.id)}/repair-draft`;
  const hasRecovery = row => failureRecovery && row?.status === 'failed' && row.origin === 'model' && row.receiptState === 'saved'
    && row.finishReason === 'stop' && ['invalid_proposal', 'invalid_model_response'].includes(row.errorCode);
  const counterDraft = row => failureRecovery && row?.status === 'draft' && repeatedCounterSteps(row.proposal).length > 0;
  const diagnosticIdentity = row => hasRecovery(row) ? JSON.stringify([row.id, 'receipt', row.receipt?.sha256])
    : counterDraft(row) ? JSON.stringify([row.id, 'counter', row.revision]) : '';
  const diagnosticFor = row => diagnosticKey === diagnosticIdentity(row) ? diagnosis : null;
  const counterReviewPending = row => counterDraft(row) && (!diagnosticFor(row) || !!diagnosticFor(row).suggestedRepair);
  const repairKey = row => JSON.stringify([row.id, 'repair']);
  const isCurrent = token => !destroyed && token.epoch === epoch && token.key === key && contextKey(contextValue(getContext())) === key;
  const confirmed = () => context.planningStatus === 'confirmed' && HASH.test(context.specRevision) && HASH.test(context.planRevision);
  const scope = row => row && row.projectId === context.projectId && row.runId === context.runId && row.coverage === 'structural_only' && row.executed === false;
  function currentRow(row) {
    const binding = row?.binding;
    return scope(row) && row.current === true && confirmed() && HASH.test(row.revision || '') && HASH.test(row.manifestHash || '') && HASH.test(row.policyHash || '')
      && binding?.projectId === context.projectId && binding?.runId === context.runId && binding.specRevision === context.specRevision && binding.planRevision === context.planRevision
      && ['sourceRevision', 'engineeringHash', 'contextHash', 'policyHash'].every(name => HASH.test(binding[name] || '')) && binding.policyHash === row.policyHash
      && Number.isSafeInteger(binding.sourceGeneration) && binding.sourceGeneration >= 0 && row.proposal?.version === 1;
  }
  const boundRows = () => rows().filter(row => scope(row) && row.binding?.specRevision === context.specRevision && row.binding?.planRevision === context.planRevision);
  const currentRows = () => boundRows().filter(row => row.current === true);
  const inProgress = row => ['generating', 'cancel_requested'].includes(row?.status);
  const jointDraft = () => currentRows().findLast(row => currentRow(row) && row.status === 'draft' && row.proposal?.browser?.steps?.length && row.actions?.canApprove === true && !counterReviewPending(row));
  function workflowProgress() {
    if (contextKey(contextValue(getContext())) !== key) return { state: 'waiting', text: '正在读取清单' };
    if (action?.kind === 'recover-login' || shouldRecoverLogin()) return { state: 'working', text: '正在补上测试账号的登录步骤' };
    if (!fresh) return { state: 'waiting', text: error ? '状态待核对' : '正在读取清单' };
    const current = currentRows();
    const joint = current.findLast(row => currentRow(row) && row.status === 'approved' && row.approved && row.proposal?.browser?.steps?.length);
    if (joint) return { state: 'done', text: '清单已确认', detail: `HTTP ${joint.proposal.steps?.length ?? 0} 步 · 浏览器 ${joint.proposal.browser.steps.length} 步` };
    const bound = boundRows(), working = bound.findLast(inProgress);
    if (working) return { state: 'working', text: STATUSES[working.status] };
    const latest = current.at(-1);
    if (jointDraft() || latest?.status === 'draft' && latest.proposal?.browser?.steps?.length) return { state: 'waiting', text: '待确认清单' };
    if (['reconciliation_required', 'failed', 'timed_out'].includes(latest?.status)) return { state: 'failed', text: '清单准备未完成', detail: STATUSES[latest.status] };
    if (latest?.proposal && !latest.proposal.browser) return { state: 'waiting', text: '缺少浏览器清单' };
    if (bound.length && !current.length && !data.capabilities?.canPropose && !data.capabilities?.canImportDefinition) {
      return { state: 'waiting', blocked: true, text: '正在核对当前进度' };
    }
    return { state: 'waiting', text: '待准备清单' };
  }
  function validCost() {
    const cap = data?.capabilities, budget = cap?.budget;
    return fresh && !shouldRecoverLogin() && action?.kind !== 'recover-login' && pending?.kind !== 'recover-login'
      && data?.coverage === 'structural_only' && confirmed() && cap?.canPropose === true && HASH.test(cap.contractRevision || '')
      && typeof cap.model === 'string' && !!cap.model.trim() && cap.model.length <= 200
      && Number.isInteger(budget?.maxAttempts) && budget.maxAttempts >= 1 && budget.maxAttempts <= 3
      && Number.isInteger(budget.remainingAttempts) && budget.remainingAttempts >= 1 && budget.remainingAttempts <= budget.maxAttempts
      && Number.isInteger(budget.timeoutMs) && budget.timeoutMs >= 1 && budget.timeoutMs <= 60000;
  }
  const canImport = () => canEdit() && fresh && confirmed() && data?.coverage === 'structural_only' && data.capabilities?.canImportDefinition === true && HASH.test(data.capabilities.contractRevision || '');
  function shouldRecoverLogin() {
    return !action && !pending && !openingDraft && canImport() && data.capabilities.canRecoverLogin === true
      && !loginRecoveries.has(sessionKey(context)) && !draft?.touched && !saved.importJSON.trim() && !saved.importFeedback.trim()
      && !boundRows().some(inProgress) && !currentRows().some(row => ['draft', 'approved', 'reconciliation_required'].includes(row.status));
  }
  const savesDefinition = kind => ['import', 'repair', 'quickRepair', 'recover-login'].includes(kind);
  const creates = kind => kind === 'propose' || savesDefinition(kind);
  function report(failure, kind = 'action') { error = failure instanceof Error ? failure.message : String(failure); errorKind = kind; try { Promise.resolve(onError(failure instanceof Error ? failure : new Error(error))).catch(() => {}); } catch { /* Parent notices cannot alter approval. */ } }
  function persist() {
    if (!context.projectId || !context.runId) return;
    let value = JSON.stringify(saved);
    for (const name of Object.keys(saved.drafts)) { if (value.length <= 1024 * 1024) break; if (name !== saved.loadedKey) { delete saved.drafts[name]; value = JSON.stringify(saved); } }
    sessions.set(sessionKey(context), saved); try { sessionStorage.setItem(sessionKey(context), value); } catch { /* In-memory edits still remain. */ }
  }
  function restore() {
    if (sessions.has(sessionKey(context))) return sessions.get(sessionKey(context));
    try {
      const value = sessionStorage.getItem(sessionKey(context)); if (!value || value.length > 1024 * 1024) throw new Error(); const parsed = JSON.parse(value);
      if (typeof parsed?.selectedId !== 'string' || typeof parsed.loadedKey !== 'string' || !parsed.drafts || typeof parsed.drafts !== 'object' || Array.isArray(parsed.drafts)) throw new Error();
      const restored = { selectedId: parsed.selectedId, loadedKey: parsed.loadedKey, drafts: {}, importJSON: typeof parsed.importJSON === 'string' && parsed.importJSON.length <= 262144 ? parsed.importJSON : '', importFeedback: typeof parsed.importFeedback === 'string' && parsed.importFeedback.length <= 5000 ? parsed.importFeedback : '' };
      for (const [id, item] of Object.entries(parsed.drafts).slice(-12)) if ((HASH.test(item?.revision || '') || item?.repair === true && item.revision === null) && typeof item.json === 'string' && item.json.length <= 262144 && typeof item.feedback === 'string' && item.feedback.length <= 5000) restored.drafts[id] = { revision: item.revision, json: item.json, feedback: item.feedback, touched: item.touched === true, edits: 0, ...(item.repair === true ? { repair: true } : {}) };
      return restored;
    } catch { return { selectedId: '', loadedKey: '', drafts: {}, importJSON: '', importFeedback: '' }; }
  }
  function syncContext() {
    const next = contextValue(getContext()), nextKey = contextKey(next); if (key === nextKey) return false;
    persist(); context = next; key = nextKey; epoch++; readId++; data = null; fresh = false; action = null; pending = null; loading = false; error = ''; notice = ''; consentKey = '';
    diagnosticKey = ''; diagnosis = null; openingDraft = false; automaticRepairId = '';
    saved = restore(); draft = saved.drafts[saved.loadedKey] ?? null;
    if (refs) { refs.consent.checked = false; fill(); } return true;
  }
  function fill() { refs.json.value = draft?.json ?? ''; refs.feedback.value = draft?.feedback ?? ''; if (refs.importJSON.value !== saved.importJSON) refs.importJSON.value = saved.importJSON; if (refs.importFeedback.value !== saved.importFeedback) refs.importFeedback.value = saved.importFeedback; }
  function loadRow(row, feedback = '') {
    if (!row || !HASH.test(row.revision || '') || !row.proposal) { draft = null; saved.loadedKey = ''; fill(); return; }
    const id = JSON.stringify([row.id, row.revision]);
    saved.loadedKey = id; draft = { revision: row.revision, json: pretty(row.proposal), feedback, touched: false, edits: 0 }; saved.drafts[id] = draft;
    const names = Object.keys(saved.drafts); for (const name of names.slice(0, Math.max(0, names.length - 12))) if (name !== id) delete saved.drafts[name];
    fill(); persist();
  }
  function chooseRow() {
    const row = selected(); if (!row) { draft = null; saved.loadedKey = ''; fill(); return; }
    const prefix = JSON.stringify([row.id]).slice(0, -1) + ',';
    if (saved.loadedKey.startsWith(prefix) && draft) return;
    const id = hasRecovery(row) ? repairKey(row) : JSON.stringify([row.id, row.revision]);
    if (saved.drafts[id]) { saved.loadedKey = id; draft = saved.drafts[id]; fill(); } else loadRow(row);
  }
  const staleDraft = row => !draft || draft.revision !== row?.revision;
  const dirtyDefinition = row => !!draft && draft.json !== pretty(row?.proposal);
  function finishAutomaticRepair() {
    if (!automaticRepairId || action || loading || !fresh) return;
    const row = currentRows().find(item => item.id === automaticRepairId);
    if (!row || inProgress(row) || (hasRecovery(row) || counterDraft(row)) && !diagnosticFor(row)) return;
    automaticRepairId = '';
    if (selected()?.id === row.id && !jointDraft() && !draft?.touched && allowed('quickRepair')) void perform('quickRepair');
  }
  function loadDiagnostic(row) {
    const next = diagnosticIdentity(row);
    if (diagnosticKey === next) return;
    diagnosticKey = next; diagnosis = null;
    if (!next) return;
    const token = { key, epoch, read: ++diagnosticRead };
    void api(repairPath(row), { cache: 'no-store' }).then(result => {
      if (isCurrent(token) && token.read === diagnosticRead && diagnosticKey === next && result?.proposalId === row.id) { diagnosis = result.diagnostic; finishAutomaticRepair(); render(); onUpdate(); }
    }).catch(failure => {
      if (isCurrent(token) && token.read === diagnosticRead && diagnosticKey === next) { diagnosis = { message: failure.message, missing: [], canLoad: false }; finishAutomaticRepair(); render(); onUpdate(); }
    });
  }
  async function openRecovery() {
    if (syncContext()) { render(); void refresh(); return; }
    const row = selected();
    if (openingDraft || action || !hasRecovery(row) || !diagnosis?.canLoad || !canImport()) return;
    if (draft?.repair) { refs.json.focus(); return; }
    const token = { key, epoch, id: row.id };
    openingDraft = true; render();
    try {
      const result = await api(`${repairPath(row)}?edit=1`, { cache: 'no-store' });
      if (!isCurrent(token) || selected()?.id !== token.id) return;
      if (result?.proposalId !== row.id || !result.draft || Array.isArray(result.draft)) throw new Error('未取得可编辑的失败草案。');
      let json = pretty(result.draft);
      if (new TextEncoder().encode(json).length > 262144) json = JSON.stringify(result.draft);
      saved.loadedKey = repairKey(row);
      draft = { revision: null, json, feedback: `修订第 ${row.attempt} 次生成的验收清单`, touched: false, edits: 0, repair: true };
      saved.drafts[saved.loadedKey] = draft; fill(); persist(); render();
      refs.json.focus();
    } catch (failure) { if (isCurrent(token) && selected()?.id === token.id) report(failure); }
    finally { if (isCurrent(token)) { openingDraft = false; render(); } }
  }
  function allowed(kind) {
    const row = selected(); if (action || !fresh) return false;
    if (kind === 'propose') return validCost() && refs.consent.checked;
    if (kind === 'recover-login') return shouldRecoverLogin();
    if (kind === 'import') return canImport() && !!saved.importJSON.trim() && !!saved.importFeedback.trim();
    if (kind === 'quickRepair') return (hasRecovery(row) || counterDraft(row)) && canImport() && Boolean(diagnosticFor(row)?.suggestedRepair);
    if (kind === 'repair') return hasRecovery(row) && canImport() && diagnosis?.canLoad && draft?.repair === true && !!draft.json.trim() && !!draft.feedback.trim();
    if (kind === 'cancel') return scope(row) && row.status === 'generating' && row.actions?.canCancel === true;
    if (!currentRow(row) || staleDraft(row) || !draft.feedback.trim()) return false;
    if (kind === 'approve' && counterReviewPending(row)) return false;
    if (kind === 'revise' && !dirtyDefinition(row)) return false;
    if (kind !== 'revise' && dirtyDefinition(row)) return false;
    return ({ revise: ['draft', 'rejected', 'approved'], approve: ['draft'], reject: ['draft', 'approved'] })[kind]?.includes(row.status)
      && row.actions?.[{ revise: 'canRevise', approve: 'canApprove', reject: 'canReject' }[kind]] === true;
  }
  function build(element) {
    root = node('section', null, 'verification-plans'); root.setAttribute('aria-label', '独立测试提案'); root.append(node('style', STYLE), node('h2', '独立测试提案（尚未运行）'),
      node('p', '生成或导入包含接口和浏览器检查的清单。审阅检查项并确认后，即可进入编码。', 'vp-note'));
    const refreshButton = button('刷新测试提案', () => { diagnosticKey = ''; void refresh(); }), state = node('p'), errorBox = node('p', '', 'vp-note vp-error'), noticeBox = node('p', '', 'vp-note');
    state.setAttribute('role', 'status'); errorBox.setAttribute('role', 'alert'); noticeBox.setAttribute('role', 'status'); root.append(refreshButton, state, errorBox, noticeBox);
    const body = node('div'), cost = node('p', '', 'vp-note'), consent = node('input'); consent.type = 'checkbox';
    const consentLabel = node('label', null, 'vp-consent'); consentLabel.append(consent, node('span', '我已核对当前模型、HTTP结构范围及尝试预算，同意生成新测试提案产生用量。'));
    const propose = button('生成独立测试提案', () => { void perform('propose', { automaticRepair: autoRepairOnPropose }); }, true); body.append(cost, consentLabel, propose);
    const importDetails = node('details'), importJSON = node('textarea', null, 'vp-json'), importFeedback = node('textarea'), importButton = button('保存为待审阅定义', () => { void perform('import'); });
    importJSON.maxLength = 262144; importJSON.spellcheck = false; importFeedback.maxLength = 5000;
    importDetails.append(node('summary', '导入已有测试定义（不调用模型）'), node('p', '将已有定义保存为人工草稿，保留原模型尝试与费用。导入后仍须单独审阅和认可，尚未运行测试。'), field('待导入测试定义 JSON', importJSON), field('导入依据（必填，最多5000字）', importFeedback), importButton); body.append(importDetails);
    for (const [name, control] of [['importJSON', importJSON], ['importFeedback', importFeedback]]) control.addEventListener('input', () => { if (syncContext()) { render(); void refresh(); return; } saved[name] = control.value; persist(); render(); });
    const select = node('select'); select.addEventListener('change', () => { if (syncContext()) { render(); void refresh(); return; } if (action) return; saved.selectedId = select.value; saved.loadedKey = ''; draft = null; chooseRow(); persist(); render(); });
    body.append(field('测试提案记录', select));
    const detail = node('div'), identity = node('p'), status = node('p', '', 'vp-note'), facts = node('p'), failure = node('div', '', 'vp-note vp-error'), failureText = node('p'), missing = node('ul'), capacity = node('p'), openDraft = button('载入失败草案并修改', () => { void openRecovery(); }, true), binding = node('details'), bindingText = node('pre'), coverage = node('p'), goToCode = button('去开始开发', onApproved, true);
    const quickHint = node('p'), quickRepair = button('修复并保存待审阅清单', () => { void perform('quickRepair'); }, true);
    failure.append(failureText, missing, capacity, quickHint, quickRepair, openDraft);
    binding.append(node('summary', '提案版本与绑定'), bindingText); detail.append(identity, status, facts, failure, binding);
    const stale = node('p', '', 'vp-note'), load = button('载入当前提案版本', () => { if (syncContext()) { render(); void refresh(); return; } if (!action && currentRow(selected())) { loadRow(selected()); notice = '已载入当前提案版本。保存修订与认可定义是两个操作。'; render(); } });
    const json = node('textarea', null, 'vp-json'), feedback = node('textarea'); json.maxLength = 262144; json.spellcheck = false; feedback.maxLength = 5000;
    for (const [name, control] of [['json', json], ['feedback', feedback]]) control.addEventListener('input', () => {
      if (syncContext()) { render(); void refresh(); return; } if (!draft) return; draft[name] = control.value; draft.touched = true; draft.edits++; persist(); render();
    });
    const editor = node('div'), editorHelp = node('p');
    editor.append(editorHelp, field('HTTP测试定义 JSON', json), field('修订或审阅依据（必填，最多5000字）', feedback));
    detail.append(stale, load, editor);
    const revise = button('保存提案修订', () => { void perform('revise'); }), approve = button('认可测试定义（尚未运行）', () => { void perform('approve'); }), reject = button('驳回测试定义', () => { void perform('reject'); }), cancel = button('请求停止提案生成', () => { void perform('cancel'); });
    const saveRepair = button('保存为新待审阅清单', () => { void perform('repair'); }, true);
    detail.append(coverage, saveRepair, revise, approve, reject, cancel, goToCode);
    const history = node('details'), historyBody = node('div'); history.append(node('summary', '提案修订与审阅历史'), historyBody); detail.append(history); body.append(detail); root.append(body); element.append(root);
    refs = { refreshButton, state, errorBox, noticeBox, body, cost, consent, propose, importDetails, importJSON, importFeedback, importButton, select, detail, identity, status, facts, failure, failureText, missing, capacity, quickHint, quickRepair, openDraft, bindingText, stale, load, editor, editorHelp, json, feedback, saveRepair, revise, approve, reject, cancel, historyBody, coverage, goToCode };
    consent.addEventListener('change', render);
  }
  function render() {
    if (!refs || destroyed) return;
    refs.body.hidden = !context.projectId || !context.runId;
    refs.state.textContent = refs.body.hidden ? '请先选择项目和规划运行。' : action?.kind === 'recover-login' ? '正在补上测试账号的登录步骤…'
      : loading && !data ? '正在读取测试提案…' : !fresh ? '尚未取得当前提案许可，请刷新核对。' : data?.capabilities?.reason || '仅审阅HTTP结构测试定义，尚未运行。';
    refs.errorBox.hidden = !error; refs.errorBox.textContent = error; refs.noticeBox.hidden = !notice; refs.noticeBox.textContent = notice;
    const cap = data?.capabilities, budget = cap?.budget;
    const signature = JSON.stringify([key, cap?.contractRevision, cap?.budget, cap?.model]);
    if (signature !== consentKey) { consentKey = signature; refs.consent.checked = false; }
    refs.cost.textContent = `模型：${text(cap?.model)}。每次生成最多一次新模型请求；本运行最多 ${count(budget?.maxAttempts)} 次，剩余 ${count(budget?.remainingAttempts)} 次，单次总时限 ${Number.isSafeInteger(budget?.timeoutMs) && budget.timeoutMs > 0 ? `${budget.timeoutMs / 1000} 秒` : '未知'}。仅生成HTTP结构提案，不运行测试。`;
    refs.consent.disabled = !!action || !validCost(); refs.propose.disabled = !allowed('propose'); refs.propose.textContent = action?.kind === 'propose' ? '正在请求生成，等待后端…' : '生成独立测试提案';
    refs.importJSON.disabled = refs.importFeedback.disabled = !!action || !canImport(); refs.importButton.disabled = !allowed('import');
    const list = rows(), listSignature = JSON.stringify(list.map(row => [row.id, row.status, row.revision]));
    if (refs.select.dataset.signature !== listSignature) { refs.select.replaceChildren(); for (const row of list) { const option = node('option', `${STATUSES[row.status] ?? '未知状态'} · ${row.origin === 'manual' ? `人工定义记录${count(row.attempt)}` : `第${count(row.attempt)}次`} · ${row.id}`); option.value = row.id; refs.select.append(option); } refs.select.dataset.signature = listSignature; }
    if (!list.some(row => row.id === saved.selectedId)) {
      saved.selectedId = (jointDraft() ?? list.at(-1))?.id ?? ''; saved.loadedKey = ''; draft = null;
    }
    refs.select.value = saved.selectedId; refs.select.disabled = !!action || !list.length;
    const row = selected(); refs.detail.hidden = !row; loadDiagnostic(row); if (!row) return; chooseRow();
    refs.identity.textContent = `提案 ${row.id} · 记录序号${count(row.attempt)} · ${text(row.startedAt)}`;
    refs.coverage.hidden = !row.proposal;
    refs.coverage.textContent = row.proposal?.browser?.steps?.length ? `清单包含 ${row.proposal.steps?.length ?? 0} 个接口步骤和 ${row.proposal.browser.steps.length} 个浏览器步骤。` : '这份清单缺少浏览器步骤。请生成或导入一份包含浏览器检查的清单后再开始开发。';
    refs.goToCode.hidden = workflowProgress().state !== 'done';
    refs.status.textContent = `${STATUSES[row.status] ?? '未知状态，不可操作'}。${text(row.notice)} 测试尚未运行，软件通过状态未产生。`;
    refs.facts.textContent = row.origin === 'manual' ? '来源：人工导入。本条定义模型请求为0，原模型失败及费用仍在各自历史记录中。' : `模型：${text(row.model)}；输入 ${count(row.usage?.inputTokens)} / 输出 ${count(row.usage?.outputTokens)} token。请求发送：${row.dispatched === true ? '已发送' : row.dispatched === false ? '尚未发送' : '未知'}；回执：${text(row.receiptState)}；结束原因：${text(row.finishReason)}。`;
    refs.failure.hidden = !row.error && !row.errorCode && !(counterDraft(row) && diagnosticFor(row)?.suggestedRepair);
    refs.failureText.textContent = diagnosis?.message || (hasRecovery(row) ? '正在核对这次草案未通过的原因…' : text(row.error));
    refs.missing.hidden = !diagnosis?.missing?.length;
    refs.missing.replaceChildren(...(diagnosis?.missing ?? []).map(item => node('li', `${item.id} · ${item.title}`)));
    const capacityMessage = httpStepOverflow(diagnosis);
    refs.capacity.hidden = !capacityMessage;
    refs.capacity.textContent = capacityMessage ? `${capacityMessage}请合并重复检查并保留必需的验收条件。` : '';
    refs.quickHint.textContent = diagnosis?.suggestedRepair ? `${diagnosis.suggestedRepair}保存草案无需调用模型。` : '';
    refs.quickHint.hidden = refs.quickRepair.hidden = !diagnosis?.suggestedRepair || !canEdit() || Boolean(draft?.repair);
    refs.quickRepair.disabled = !allowed('quickRepair') || openingDraft;
    refs.openDraft.hidden = !diagnosis?.canLoad || !canEdit();
    refs.openDraft.disabled = openingDraft || !!action || !canImport();
    refs.openDraft.textContent = draft?.repair ? '继续编辑失败草案' : '载入失败草案并修改';
    refs.bindingText.textContent = pretty({ revision: row.revision, manifestHash: row.manifestHash, policyHash: row.policyHash, binding: row.binding, receipt: row.receipt, approval: row.approval });
    refs.stale.hidden = !staleDraft(row) && currentRow(row); refs.stale.textContent = !row.revision ? '尚无可编辑的测试定义，请等待生成结果或核对失败原因。' : staleDraft(row) ? '已有新提案版本，旧编辑内容已保留；旧草稿不能保存或认可。请复制需要保留的内容，再显式载入当前提案版本。' : '该记录或规划绑定已失效，仅保留历史；当前不可修订或认可。';
    refs.load.disabled = !!action || !fresh || !currentRow(row);
    refs.json.disabled = !draft; refs.feedback.disabled = !draft;
    const recovery = hasRecovery(row);
    refs.editor.hidden = recovery && !draft?.repair;
    refs.editorHelp.textContent = draft?.repair ? '补齐上方列出的检查，保存为新的待审阅清单。原失败记录保留，保存无需调用模型。' : '编辑测试定义后先保存提案修订，再审阅和认可当前版本。';
    refs.json.readOnly = refs.feedback.readOnly = recovery && (!canImport() || !!action);
    refs.stale.hidden ||= recovery && Boolean(draft?.repair);
    refs.load.hidden = recovery;
    refs.saveRepair.hidden = !recovery || !draft?.repair; refs.saveRepair.disabled = !allowed('repair');
    refs.revise.hidden = refs.approve.hidden = refs.reject.hidden = recovery;
    for (const kind of ['revise', 'approve', 'reject', 'cancel']) refs[kind].disabled = !allowed(kind);
    const historySignature = pretty(row.history);
    if (refs.historyBody.dataset.signature !== historySignature) { refs.historyBody.dataset.signature = historySignature; refs.historyBody.replaceChildren(); for (const item of Array.isArray(row.history) ? row.history : []) refs.historyBody.append(node('p', `${({ imported: '人工导入草稿（尚未运行）', approve: '认可定义（尚未运行）', reject: '驳回定义', revised: '保存修订' })[item.status] ?? '未知历史'} · ${text(item.at)} · ${text(item.revision)}`), node('pre', text(item.feedback))); }
  }
  function confirmPending() {
    const intent = pending; if (!intent || !isCurrent(intent)) return;
    const row = rows().find(item => item.id === intent.id); if (!scope(row) || !creates(intent.kind) && bindingKey(row.binding) !== intent.binding) return;
    let confirmed = intent.kind === 'propose' || intent.kind === 'cancel' && ['cancel_requested', 'cancelled', 'timed_out', 'stale', 'failed', 'reconciliation_required'].includes(row.status);
    if (savesDefinition(intent.kind)) confirmed = currentRow(row) && row.origin === 'manual' && row.status === 'draft' && row.revision === intent.revision && row.approved === false;
    if (intent.kind === 'revise') confirmed = currentRow(row) && row.revision === intent.revision && row.history?.some(item => item.status === 'revised' && item.revision === intent.oldRevision && item.feedback === intent.feedback);
    if (intent.kind === 'approve') confirmed = currentRow(row) && row.revision === intent.oldRevision && row.status === 'approved' && row.approved === true && row.approval?.revision === intent.oldRevision && row.approval?.phase === 'definition_only' && row.approval?.coverage === 'structural_only' && row.approval.feedback === intent.feedback;
    if (intent.kind === 'reject') confirmed = currentRow(row) && row.status === 'rejected' && row.revision === intent.oldRevision && row.history?.some(item => item.status === 'reject' && item.revision === intent.oldRevision && item.feedback === intent.feedback);
    if (!confirmed) return;
    if (intent.kind !== 'cancel' || !['cancel_requested', 'reconciliation_required'].includes(row.status)) pending = null; error = ''; errorKind = '';
    notice = ({ import: '后端已保存人工定义；仍待单独审阅和认可，尚未运行测试。', repair: '修改已保存为新的待审阅清单。请核对并认可这份清单。', quickRepair: '修复后的清单已保存。请核对后认可，验收检查尚未运行。', 'recover-login': '已补上测试账号的登录步骤。请核对并认可这份清单。', propose: '后端已记录新的提案尝试，尚未运行测试。', revise: '后端已保存提案修订，尚未认可或运行。', approve: '后端已认可当前测试定义，尚未运行测试，不代表软件通过。', reject: '后端已驳回当前测试定义，修订后需重新审阅。', cancel: row.status === 'cancel_requested' ? '已请求停止提案生成，尚未确认停止。' : `${STATUSES[row.status] ?? '停止状态未知，请核对'}，测试尚未运行。` })[intent.kind];
    if (creates(intent.kind) && saved.selectedId === intent.selectedId && draft === intent.draft && draft?.edits === intent.edits
      && ![refs.json, refs.feedback].includes(document.activeElement)) { saved.selectedId = row.id; saved.loadedKey = ''; draft = null; chooseRow(); }
    if (intent.kind === 'revise' && saved.selectedId === row.id && draft === intent.draft && draft.edits === intent.edits) loadRow(row, intent.feedback);
  }
  function schedule() { clearTimeout(timer); if (mounted && !destroyed && context.projectId && context.runId) timer = setTimeout(() => { void refresh(); }, 3000); }
  async function refresh() {
    if (!mounted || destroyed) return false; syncContext(); clearTimeout(timer); render(); if (!context.projectId || !context.runId) return false;
    const token = { key, epoch, read: ++readId }; loading = true; render();
    try {
      const result = await api(base(), { cache: 'no-store' }); if (!isCurrent(token) || token.read !== readId) return false;
      if (result?.coverage !== 'structural_only' || !Array.isArray(result.proposals) || result.proposals.some(row => !scope(row) || typeof row.id !== 'string' || !row.id || row.id.length > 128) || new Set(result.proposals.map(row => row.id)).size !== result.proposals.length) throw new Error('测试提案状态格式不完整，请刷新核对。');
      data = result; fresh = true; if (errorKind === 'read') { error = ''; errorKind = ''; } confirmPending(); render(); persist(); return true;
    } catch (failure) { if (isCurrent(token) && token.read === readId) { fresh = false; refs.consent.checked = false; report(failure?.status === 404 ? new Error('当前版本尚未开放独立测试提案。') : failure, 'read'); render(); } return false; }
    finally {
      if (isCurrent(token) && token.read === readId) {
        loading = false; render();
        if (shouldRecoverLogin()) void perform('recover-login');
        else finishAutomaticRepair();
        onUpdate(); schedule();
      } else if (!destroyed && syncContext()) { render(); void refresh(); }
    }
  }
  async function perform(kind, { automaticRepair = false } = {}) {
    if (destroyed) return; if (syncContext()) { render(); void refresh(); return; } if (!allowed(kind)) return;
    const row = selected(), token = { key, epoch, kind, selectedId: saved.selectedId, draft, edits: draft?.edits, feedback: draft?.feedback, oldRevision: row?.revision, binding: bindingKey(row?.binding) };
    let body;
    try {
      if (kind === 'recover-login') body = { contractRevision: data.capabilities.contractRevision, planRevision: context.planRevision };
      else if (kind === 'propose' || kind === 'quickRepair') body = { contractRevision: data.capabilities.contractRevision };
      else if (kind === 'import' || kind === 'repair') {
        const json = kind === 'repair' ? draft.json : saved.importJSON;
        if (new TextEncoder().encode(json).length > 262144) throw new Error('测试定义JSON不能超过256 KiB。');
        let proposal; try { proposal = JSON.parse(json); } catch { throw new Error('测试定义JSON格式无效，草稿已保留。'); }
        if (!proposal || Array.isArray(proposal) || typeof proposal !== 'object') throw new Error('测试定义必须为JSON对象。');
        body = { contractRevision: data.capabilities.contractRevision, proposal, feedback: kind === 'repair' ? draft.feedback : saved.importFeedback };
      }
      else if (kind === 'cancel') body = {};
      else { body = { revision: row.revision, feedback: draft.feedback }; if (kind === 'revise') { if (new TextEncoder().encode(draft.json).length > 262144) throw new Error('测试定义JSON不能超过256 KiB。');
        let proposal; try { proposal = JSON.parse(draft.json); } catch { throw new Error('测试定义JSON格式无效，编辑内容已保留。'); }
        if (!proposal || Array.isArray(proposal) || typeof proposal !== 'object') throw new Error('测试定义必须为JSON对象。'); body.proposal = proposal; } }
    } catch (failure) { report(failure); render(); return; }
    if (kind === 'recover-login') loginRecoveries.set(sessionKey(context), '');
    action = token; pending = null; error = ''; errorKind = ''; notice = ''; fresh = false; readId++; if (kind === 'propose' || kind === 'recover-login') refs.consent.checked = false; render();
    try {
      const endpoint = ['repair', 'quickRepair'].includes(kind) ? repairPath(row) : `${base()}/${creates(kind) ? kind : `${encodeURIComponent(row.id)}/${kind}`}`;
      const result = await api(endpoint, { method: 'POST', body: JSON.stringify(body) }); if (!isCurrent(token) || action !== token) return;
      const returned = result?.proposal;
      if (kind === 'recover-login' && returned === null) {
        notice = typeof result.reason === 'string' && result.reason ? result.reason : '无法自动补齐登录步骤。可导入已核对的验收清单。';
        loginRecoveries.set(sessionKey(context), notice);
        await refresh(); return;
      }
      if (!scope(returned) || !creates(kind) && returned.id !== row.id || kind === 'revise' && (!HASH.test(returned.revision || '') || returned.revision === row.revision)
        || savesDefinition(kind) && (returned.origin !== 'manual' || !HASH.test(returned.revision || '') || returned.status !== 'draft' || returned.approved !== false)) throw new Error('操作结果尚未完整确认，请刷新核对；不会自动重发。');
      if (kind === 'propose' && automaticRepair) automaticRepairId = returned.id;
      pending = { ...token, id: returned.id, revision: returned.revision }; notice = '请求已返回，正在核对后端当前记录；尚未确认操作完成。'; await refresh();
    } catch (failure) { if (isCurrent(token) && action === token) { fresh = false; readId++; refs.consent.checked = false; report(failure);
      if (kind === 'repair' && failure.status === 400) { notice = '草稿未保存。请按错误提示修改后再试，已有编辑已保留。'; await refresh(); }
      else notice = '操作结果未确认，编辑内容已保留。请刷新核对后再决定下一步；不会自动重发。'; } }
    finally { if (isCurrent(token) && action === token) { action = null; persist(); render(); finishAutomaticRepair(); onUpdate(); schedule(); } else if (!destroyed && syncContext()) { render(); void refresh(); } }
  }
  return { async mount(element) { if (destroyed) return false; if (!element?.append) throw new TypeError('测试提案面板需要挂载元素。'); if (!mounted) { mounted = true; build(element); } return refresh(); }, refresh, workflowProgress,
    destroy() { if (destroyed) return; persist(); destroyed = true; epoch++; readId++; clearTimeout(timer); action = null; pending = null; root?.remove(); } };
}
