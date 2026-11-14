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

/** HTTP test definitions only. Server facts never become software acceptance in this component. */
export function createVerificationPlans({ api, getContext, onError = () => {} }) {
  if (typeof api !== 'function' || typeof getContext !== 'function') throw new TypeError('测试提案面板需要api和运行上下文。');
  let root, refs, mounted = false, destroyed = false, timer, epoch = 0, readId = 0, action = null, pending = null;
  let context = contextValue(null), key = '', data = null, fresh = false, loading = false, error = '', errorKind = '', notice = '', consentKey = '';
  let saved = { selectedId: '', loadedKey: '', drafts: {} }, draft = null;
  const sessions = new Map();
  const node = (tag, value, className) => { const element = document.createElement(tag); if (value != null) element.textContent = value; if (className) element.className = className; return element; };
  function button(label, handler, primary = false) { const element = node('button', label, primary ? 'vp-primary' : ''); element.type = 'button'; element.addEventListener('click', handler); return element; }
  function field(label, control) { const wrapper = node('label'); control.setAttribute('aria-label', label); wrapper.append(node('span', label), control); return wrapper; }
  const rows = () => Array.isArray(data?.proposals) ? data.proposals : [];
  const selected = () => rows().find(row => row.id === saved.selectedId);
  const base = () => `/api/projects/${encodeURIComponent(context.projectId)}/runs/${encodeURIComponent(context.runId)}/verification-plans`;
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
  function validCost() {
    const cap = data?.capabilities, budget = cap?.budget;
    return fresh && data?.coverage === 'structural_only' && confirmed() && cap?.canPropose === true && HASH.test(cap.contractRevision || '')
      && typeof cap.model === 'string' && !!cap.model.trim() && cap.model.length <= 200
      && Number.isInteger(budget?.maxAttempts) && budget.maxAttempts >= 1 && budget.maxAttempts <= 3
      && Number.isInteger(budget.remainingAttempts) && budget.remainingAttempts >= 1 && budget.remainingAttempts <= budget.maxAttempts
      && Number.isInteger(budget.timeoutMs) && budget.timeoutMs >= 1 && budget.timeoutMs <= 60000;
  }
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
      const restored = { selectedId: parsed.selectedId, loadedKey: parsed.loadedKey, drafts: {} };
      for (const [id, item] of Object.entries(parsed.drafts).slice(-12)) if (HASH.test(item?.revision || '') && typeof item.json === 'string' && item.json.length <= 262144 && typeof item.feedback === 'string' && item.feedback.length <= 5000) restored.drafts[id] = { revision: item.revision, json: item.json, feedback: item.feedback, touched: item.touched === true, edits: 0 };
      return restored;
    } catch { return { selectedId: '', loadedKey: '', drafts: {} }; }
  }
  function syncContext() {
    const next = contextValue(getContext()), nextKey = contextKey(next); if (key === nextKey) return false;
    persist(); context = next; key = nextKey; epoch++; readId++; data = null; fresh = false; action = null; pending = null; loading = false; error = ''; notice = ''; consentKey = '';
    saved = restore(); draft = saved.drafts[saved.loadedKey] ?? null;
    if (refs) { refs.consent.checked = false; fill(); } return true;
  }
  function fill() { refs.json.value = draft?.json ?? ''; refs.feedback.value = draft?.feedback ?? ''; }
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
    const id = JSON.stringify([row.id, row.revision]);
    if (saved.drafts[id]) { saved.loadedKey = id; draft = saved.drafts[id]; fill(); } else loadRow(row);
  }
  const staleDraft = row => !draft || draft.revision !== row?.revision;
  const dirtyDefinition = row => !!draft && draft.json !== pretty(row?.proposal);
  function allowed(kind) {
    const row = selected(); if (action || !fresh) return false;
    if (kind === 'propose') return validCost() && refs.consent.checked;
    if (kind === 'cancel') return scope(row) && row.status === 'generating' && row.actions?.canCancel === true;
    if (!currentRow(row) || staleDraft(row) || !draft.feedback.trim()) return false;
    if (kind === 'revise' && !dirtyDefinition(row)) return false;
    if (kind !== 'revise' && dirtyDefinition(row)) return false;
    return ({ revise: ['draft', 'rejected', 'approved'], approve: ['draft'], reject: ['draft', 'approved'] })[kind]?.includes(row.status)
      && row.actions?.[{ revise: 'canRevise', approve: 'canApprove', reject: 'canReject' }[kind]] === true;
  }
  function build(element) {
    root = node('section', null, 'verification-plans'); root.setAttribute('aria-label', '独立测试提案'); root.append(node('style', STYLE), node('h2', '独立测试提案（尚未运行）'),
      node('p', '仅覆盖 HTTP 测试定义的结构与映射。人工认可只认可定义，不表示测试已运行或软件通过；不会编译、运行测试，也不会改变固定图书项目的验收门禁。', 'vp-note'));
    const refreshButton = button('刷新测试提案', () => { void refresh(); }), state = node('p'), errorBox = node('p', '', 'vp-note vp-error'), noticeBox = node('p', '', 'vp-note');
    state.setAttribute('role', 'status'); errorBox.setAttribute('role', 'alert'); noticeBox.setAttribute('role', 'status'); root.append(refreshButton, state, errorBox, noticeBox);
    const body = node('div'), cost = node('p', '', 'vp-note'), consent = node('input'); consent.type = 'checkbox';
    const consentLabel = node('label', null, 'vp-consent'); consentLabel.append(consent, node('span', '我已核对当前模型、HTTP结构范围及尝试预算，同意生成新测试提案产生用量。'));
    const propose = button('生成独立测试提案', () => { void perform('propose'); }, true); body.append(cost, consentLabel, propose);
    const select = node('select'); select.addEventListener('change', () => { if (syncContext()) { render(); void refresh(); return; } if (action) return; saved.selectedId = select.value; saved.loadedKey = ''; draft = null; chooseRow(); persist(); render(); });
    body.append(field('测试提案记录', select));
    const detail = node('div'), identity = node('p'), status = node('p', '', 'vp-note'), facts = node('p'), failure = node('p', '', 'vp-note vp-error'), binding = node('details'), bindingText = node('pre');
    binding.append(node('summary', '提案版本与绑定'), bindingText); detail.append(identity, status, facts, failure, binding);
    const stale = node('p', '', 'vp-note'), load = button('载入当前提案版本', () => { if (syncContext()) { render(); void refresh(); return; } if (!action && currentRow(selected())) { loadRow(selected()); notice = '已载入当前提案版本。保存修订与认可定义是两个操作。'; render(); } });
    const json = node('textarea', null, 'vp-json'), feedback = node('textarea'); json.maxLength = 262144; json.spellcheck = false; feedback.maxLength = 5000;
    for (const [name, control] of [['json', json], ['feedback', feedback]]) control.addEventListener('input', () => {
      if (syncContext()) { render(); void refresh(); return; } if (!draft) return; draft[name] = control.value; draft.touched = true; draft.edits++; persist(); render();
    });
    detail.append(stale, load, node('p', '编辑 HTTP DSL JSON 后先“保存提案修订”。保存不会自动认可；认可和驳回只针对当前已保存版本。'), field('HTTP测试定义 JSON', json), field('修订或审阅依据（必填，最多5000字）', feedback));
    const revise = button('保存提案修订', () => { void perform('revise'); }), approve = button('认可测试定义（尚未运行）', () => { void perform('approve'); }), reject = button('驳回测试定义', () => { void perform('reject'); }), cancel = button('请求停止提案生成', () => { void perform('cancel'); });
    detail.append(revise, approve, reject, cancel);
    const history = node('details'), historyBody = node('div'); history.append(node('summary', '提案修订与审阅历史'), historyBody); detail.append(history); body.append(detail); root.append(body); element.append(root);
    refs = { refreshButton, state, errorBox, noticeBox, body, cost, consent, propose, select, detail, identity, status, facts, failure, bindingText, stale, load, json, feedback, revise, approve, reject, cancel, historyBody };
    consent.addEventListener('change', render);
  }
  function render() {
    if (!refs || destroyed) return;
    refs.body.hidden = !context.projectId || !context.runId;
    refs.state.textContent = refs.body.hidden ? '请先选择项目和规划运行。' : loading && !data ? '正在读取测试提案…' : !fresh ? '尚未取得当前提案许可，请刷新核对。' : data?.capabilities?.reason || '仅审阅HTTP结构测试定义，尚未运行。';
    refs.errorBox.hidden = !error; refs.errorBox.textContent = error; refs.noticeBox.hidden = !notice; refs.noticeBox.textContent = notice;
    const cap = data?.capabilities, budget = cap?.budget;
    const signature = JSON.stringify([key, cap?.contractRevision, cap?.budget, cap?.model]);
    if (signature !== consentKey) { consentKey = signature; refs.consent.checked = false; }
    refs.cost.textContent = `模型：${text(cap?.model)}。每次生成最多一次新模型请求；本运行最多 ${count(budget?.maxAttempts)} 次，剩余 ${count(budget?.remainingAttempts)} 次，单次总时限 ${Number.isSafeInteger(budget?.timeoutMs) && budget.timeoutMs > 0 ? `${budget.timeoutMs / 1000} 秒` : '未知'}。仅生成HTTP结构提案，不运行测试。`;
    refs.consent.disabled = !!action || !validCost(); refs.propose.disabled = !allowed('propose'); refs.propose.textContent = action?.kind === 'propose' ? '正在请求生成，等待后端…' : '生成独立测试提案';
    const list = rows(), listSignature = JSON.stringify(list.map(row => [row.id, row.status, row.revision]));
    if (refs.select.dataset.signature !== listSignature) { refs.select.replaceChildren(); for (const row of list) { const option = node('option', `${STATUSES[row.status] ?? '未知状态'} · 第${count(row.attempt)}次 · ${row.id}`); option.value = row.id; refs.select.append(option); } refs.select.dataset.signature = listSignature; }
    if (!list.some(row => row.id === saved.selectedId)) { saved.selectedId = list.at(-1)?.id ?? ''; saved.loadedKey = ''; draft = null; }
    refs.select.value = saved.selectedId; refs.select.disabled = !!action || !list.length;
    const row = selected(); refs.detail.hidden = !row; if (!row) return; chooseRow();
    refs.identity.textContent = `提案 ${row.id} · 第${count(row.attempt)}次 · ${text(row.startedAt)}`;
    refs.status.textContent = `${STATUSES[row.status] ?? '未知状态，不可操作'}。${text(row.notice)} 测试尚未运行，软件通过状态未产生。`;
    refs.facts.textContent = `模型：${text(row.model)}；输入 ${count(row.usage?.inputTokens)} / 输出 ${count(row.usage?.outputTokens)} token。请求发送：${row.dispatched === true ? '已发送' : row.dispatched === false ? '尚未发送' : '未知'}；回执：${text(row.receiptState)}；结束原因：${text(row.finishReason)}。`;
    refs.failure.hidden = !row.error && !row.errorCode; refs.failure.textContent = `${text(row.error)} ${row.errorCode ? `（${text(row.errorCode)}）` : ''}`;
    refs.bindingText.textContent = pretty({ revision: row.revision, manifestHash: row.manifestHash, policyHash: row.policyHash, binding: row.binding, receipt: row.receipt, approval: row.approval });
    refs.stale.hidden = !staleDraft(row) && currentRow(row); refs.stale.textContent = !row.revision ? '尚无可编辑的测试定义，请等待生成结果或核对失败原因。' : staleDraft(row) ? '已有新提案版本，旧编辑内容已保留；旧草稿不能保存或认可。请复制需要保留的内容，再显式载入当前提案版本。' : '该记录或规划绑定已失效，仅保留历史；当前不可修订或认可。';
    refs.load.disabled = !!action || !fresh || !currentRow(row);
    refs.json.disabled = !draft; refs.feedback.disabled = !draft;
    for (const kind of ['revise', 'approve', 'reject', 'cancel']) refs[kind].disabled = !allowed(kind);
    const historySignature = pretty(row.history);
    if (refs.historyBody.dataset.signature !== historySignature) { refs.historyBody.dataset.signature = historySignature; refs.historyBody.replaceChildren(); for (const item of Array.isArray(row.history) ? row.history : []) refs.historyBody.append(node('p', `${({ approve: '认可定义（尚未运行）', reject: '驳回定义', revised: '保存修订' })[item.status] ?? '未知历史'} · ${text(item.at)} · ${text(item.revision)}`), node('pre', text(item.feedback))); }
  }
  function confirmPending() {
    const intent = pending; if (!intent || !isCurrent(intent)) return;
    const row = rows().find(item => item.id === intent.id); if (!scope(row) || intent.kind !== 'propose' && bindingKey(row.binding) !== intent.binding) return;
    let confirmed = intent.kind === 'propose' || intent.kind === 'cancel' && ['cancel_requested', 'cancelled', 'timed_out', 'stale', 'failed', 'reconciliation_required'].includes(row.status);
    if (intent.kind === 'revise') confirmed = currentRow(row) && row.revision === intent.revision && row.history?.some(item => item.status === 'revised' && item.revision === intent.oldRevision && item.feedback === intent.feedback);
    if (intent.kind === 'approve') confirmed = currentRow(row) && row.revision === intent.oldRevision && row.status === 'approved' && row.approved === true && row.approval?.revision === intent.oldRevision && row.approval?.phase === 'definition_only' && row.approval?.coverage === 'structural_only' && row.approval.feedback === intent.feedback;
    if (intent.kind === 'reject') confirmed = currentRow(row) && row.status === 'rejected' && row.revision === intent.oldRevision && row.history?.some(item => item.status === 'reject' && item.revision === intent.oldRevision && item.feedback === intent.feedback);
    if (!confirmed) return;
    if (intent.kind !== 'cancel' || !['cancel_requested', 'reconciliation_required'].includes(row.status)) pending = null; error = ''; errorKind = '';
    notice = ({ propose: '后端已记录新的提案尝试，尚未运行测试。', revise: '后端已保存提案修订，尚未认可或运行。', approve: '后端已认可当前测试定义，尚未运行测试，不代表软件通过。', reject: '后端已驳回当前测试定义，修订后需重新审阅。', cancel: row.status === 'cancel_requested' ? '已请求停止提案生成，尚未确认停止。' : `${STATUSES[row.status] ?? '停止状态未知，请核对'}，测试尚未运行。` })[intent.kind];
    if (intent.kind === 'propose' && saved.selectedId === intent.selectedId && draft === intent.draft && draft?.edits === intent.edits
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
    finally { if (isCurrent(token) && token.read === readId) { loading = false; render(); schedule(); } else if (!destroyed && syncContext()) { render(); void refresh(); } }
  }
  async function perform(kind) {
    if (destroyed) return; if (syncContext()) { render(); void refresh(); return; } if (!allowed(kind)) return;
    const row = selected(), token = { key, epoch, kind, selectedId: saved.selectedId, draft, edits: draft?.edits, feedback: draft?.feedback, oldRevision: row?.revision, binding: bindingKey(row?.binding) };
    let body;
    try {
      if (kind === 'propose') body = { contractRevision: data.capabilities.contractRevision };
      else if (kind === 'cancel') body = {};
      else { body = { revision: row.revision, feedback: draft.feedback }; if (kind === 'revise') { if (new TextEncoder().encode(draft.json).length > 262144) throw new Error('测试定义JSON不能超过256 KiB。');
        let proposal; try { proposal = JSON.parse(draft.json); } catch { throw new Error('测试定义JSON格式无效，编辑内容已保留。'); }
        if (!proposal || Array.isArray(proposal) || typeof proposal !== 'object') throw new Error('测试定义必须为JSON对象。'); body.proposal = proposal; } }
    } catch (failure) { report(failure); render(); return; }
    action = token; pending = null; error = ''; errorKind = ''; notice = ''; fresh = false; readId++; if (kind === 'propose') refs.consent.checked = false; render();
    try {
      const result = await api(`${base()}/${kind === 'propose' ? 'propose' : `${encodeURIComponent(row.id)}/${kind}`}`, { method: 'POST', body: JSON.stringify(body) }); if (!isCurrent(token) || action !== token) return;
      const returned = result?.proposal;
      if (!scope(returned) || kind !== 'propose' && returned.id !== row.id || kind === 'revise' && (!HASH.test(returned.revision || '') || returned.revision === row.revision)) throw new Error('操作结果尚未完整确认，请刷新核对；不会自动重发。');
      pending = { ...token, id: returned.id, revision: returned.revision }; notice = '请求已返回，正在核对后端当前记录；尚未确认操作完成。'; await refresh();
    } catch (failure) { if (isCurrent(token) && action === token) { fresh = false; readId++; refs.consent.checked = false; report(failure); notice = '操作结果未确认，编辑内容已保留。请刷新核对后再决定下一步；不会自动重发。'; } }
    finally { if (isCurrent(token) && action === token) { action = null; persist(); render(); schedule(); } else if (!destroyed && syncContext()) { render(); void refresh(); } }
  }
  return { async mount(element) { if (destroyed) return false; if (!element?.append) throw new TypeError('测试提案面板需要挂载元素。'); if (!mounted) { mounted = true; build(element); } return refresh(); }, refresh,
    destroy() { if (destroyed) return; persist(); destroyed = true; epoch++; readId++; clearTimeout(timer); action = null; pending = null; root?.remove(); } };
}
