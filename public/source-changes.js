const KINDS = { field: '字段', permission: '权限', workflow: '流程', other: '其他' };
const STATUSES = { pending: '待应用', applying: '应用中，等待确认', applied: '已应用', apply_interrupted: '应用中断，需核对' };
const HASH = /^[a-f0-9]{64}$/;
const STYLE = `
.source-changes{margin-top:20px;min-width:0;padding:20px 22px;border:1px solid #e3e9f1;border-radius:12px;background:#fff;color:#344c6d;font:13px/1.8 "Microsoft YaHei",sans-serif}
.source-changes *{box-sizing:border-box;min-width:0}.source-changes [hidden]{display:none!important}
.source-changes h2{margin:0;font-size:19px}.source-changes h3{font-size:15px}.source-changes p{overflow-wrap:anywhere}
.source-changes label{display:grid;gap:5px;margin:12px 0}.source-changes input,.source-changes textarea,.source-changes select{width:100%;max-width:100%;padding:8px;border:1px solid #cfd9e6;border-radius:6px;font:inherit;color:inherit;background:#fff}
.source-changes textarea{resize:vertical;min-height:110px}.source-changes textarea.sc-source{min-height:220px;font-family:monospace}
.source-changes button{padding:8px 13px;margin:4px 8px 4px 0;border:1px solid #cbd7e7;border-radius:6px;background:#f8fafc;color:#344c6d;font:inherit;cursor:pointer;white-space:normal}
.source-changes button:disabled{opacity:.5;cursor:default}.source-changes .sc-primary{background:#2469b0;border-color:#2469b0;color:white}
.source-changes .sc-note{padding:10px 12px;border-left:3px solid #90b6dc;background:#f3f7fc}.source-changes .sc-error{border-color:#c25b4f;color:#983c35;background:#fff4f2}
.source-changes pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;padding:10px;background:#f4f6f9;font:12px/1.7 monospace}.source-changes details{margin:12px 0}.source-changes summary{cursor:pointer;font-weight:600}
@media(max-width:600px){.source-changes{padding:16px 12px}.source-changes button{width:100%;margin:5px 0}}
`;

/** Only backend source facts authorize application. All document strings stay text. */
export function createSourceChanges({ api, getContext, onApplied = () => {}, onError = () => {} }) {
  if (typeof api !== 'function' || typeof getContext !== 'function') throw new TypeError('需求变更面板需要api和项目上下文。');
  let root, refs, mounted = false, destroyed = false, timer, projectId = '', epoch = 0, readId = 0;
  let data = null, draft = emptyDraft(), action = null, error = '', notice = '', loading = false, edits = 0, detailSignature = '';
  const drafts = new Map();
  function emptyDraft() { return { baseRevision: null, baseGeneration: null, filename: '', content: '', reason: '', kind: 'other', requestKey: null, requestBody: null, uncertain: false, selectedId: '' }; }
  function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
  function button(text, handler, primary = false) { const el = node('button', text, primary ? 'sc-primary' : ''); el.type = 'button'; el.addEventListener('click', handler); return el; }
  function field(title, control) { const label = node('label'); label.append(node('span', title), control); return label; }
  const contextId = () => { const value = getContext()?.projectId; return typeof value === 'string' ? value : ''; };
  const current = () => data?.current;
  const validCurrent = value => value && typeof value.revision === 'string' && HASH.test(value.revision) && Number.isSafeInteger(value.generation) && value.generation >= 0
    && typeof value.source?.filename === 'string' && typeof value.source?.content === 'string';
  const changes = () => Array.isArray(data?.changes) ? data.changes.filter(item => item && typeof item.id === 'string') : [];
  const selected = () => changes().find(item => item.id === draft.selectedId);
  const stale = () => !validCurrent(current()) || draft.baseRevision !== current().revision || draft.baseGeneration !== current().generation;
  const basePath = () => `/api/projects/${encodeURIComponent(projectId)}/changes`;
  function isCurrent(token) { return !destroyed && projectId === token.projectId && epoch === token.epoch && contextId() === token.projectId; }
  function report(value) { error = value instanceof Error ? value.message : String(value); try { onError(value instanceof Error ? value : new Error(error)); } catch { /* Notices do not alter state. */ } }
  function persist() {
    if (!projectId) return;
    drafts.set(projectId, { ...draft });
    try { sessionStorage.setItem(`taskflow.sourceChanges.${projectId}`, JSON.stringify(draft)); } catch { /* Memory draft remains usable. */ }
  }
  function restore(id) {
    if (drafts.has(id)) return { ...drafts.get(id) };
    try {
      const text = sessionStorage.getItem(`taskflow.sourceChanges.${id}`);
      if (!text || text.length > 2 * 1024 * 1024) return emptyDraft();
      const value = JSON.parse(text), result = emptyDraft();
      for (const name of ['filename', 'content', 'reason', 'kind', 'selectedId']) if (typeof value?.[name] === 'string') result[name] = value[name];
      if (result.filename.length > 160 || result.content.length > 100000 || result.reason.length > 5000 || !Object.hasOwn(KINDS, result.kind)) return emptyDraft();
      if (typeof value.baseRevision === 'string' && HASH.test(value.baseRevision)) result.baseRevision = value.baseRevision;
      if (Number.isSafeInteger(value.baseGeneration) && value.baseGeneration >= 0) result.baseGeneration = value.baseGeneration;
      if (typeof value.requestKey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.requestKey) && typeof value.requestBody === 'string' && value.requestBody.length < 1024 * 1024) {
        result.requestKey = value.requestKey; result.requestBody = value.requestBody;
      }
      result.uncertain = value.uncertain === true; return result;
    } catch { return emptyDraft(); }
  }
  function syncContext() {
    const next = contextId(); if (next === projectId) return false;
    persist(); projectId = next; epoch++; readId++; action = null; data = null; loading = false; error = ''; notice = ''; detailSignature = ''; edits++;
    draft = next ? restore(next) : emptyDraft(); fillForm(); return true;
  }
  function fillForm() { if (!refs) return; for (const key of ['filename', 'content', 'reason', 'kind']) refs[key].value = draft[key]; refs.file.value = ''; }
  function loadCurrent() {
    if (syncContext()) { render(); void refresh(); return; }
    if (action || !validCurrent(current())) return;
    draft = { ...emptyDraft(), baseRevision: current().revision, baseGeneration: current().generation, filename: current().source.filename, content: current().source.content, selectedId: draft.selectedId };
    edits++; error = ''; notice = '已载入当前输入。请编辑并保存为待应用变更。'; fillForm(); persist(); render();
  }
  function schedule() { clearTimeout(timer); if (mounted && !destroyed && projectId) timer = setTimeout(() => { void refresh(); }, 3000); }
  function build(element) {
    root = node('section', null, 'source-changes'); root.setAttribute('aria-label', '需求输入变更'); root.append(node('style', STYLE));
    root.append(node('h2', '需求输入变更'), node('p', '保存待应用请求不会修改当前输入，也不调用模型。应用只更新需求输入并使旧运行只读；新规格和计划需重新确认，代码和数据库迁移尚未执行。', 'sc-note'));
    const refreshButton = button('刷新变更状态', () => { void refresh(); }), status = node('p'), errorBox = node('p', '', 'sc-note sc-error'), noticeBox = node('p', '', 'sc-note');
    status.setAttribute('role', 'status'); errorBox.setAttribute('role', 'alert'); noticeBox.setAttribute('role', 'status'); root.append(refreshButton, status, errorBox, noticeBox);
    const body = node('div'), version = node('p'), staleBox = node('p', '', 'sc-note'), load = button('基于当前版本重新编辑', loadCurrent); body.append(version, staleBox, load);
    const form = node('form'), filename = node('input'), content = node('textarea', '', 'sc-source'), reason = node('textarea'), kind = node('select');
    filename.maxLength = 160; content.maxLength = 100000; reason.maxLength = 5000; reason.rows = 3;
    for (const [value, title] of Object.entries(KINDS)) { const option = node('option', title); option.value = value; kind.append(option); }
    form.append(field('需求文件名', filename), field('需求正文', content), field('变更原因', reason), field('变更分类（仅标签）', kind));
    const file = node('input'); file.type = 'file'; file.accept = '.md,.txt,.docx';
    const importButton = button('导入文件到草稿', () => { void perform('parse'); }); form.append(field('导入 MD / TXT / DOCX（最大 3 MiB）', file), importButton);
    const save = button('保存为待应用变更', () => { void perform('save'); }, true); form.append(save); form.addEventListener('submit', event => event.preventDefault()); body.append(form);
    for (const name of ['filename', 'content', 'reason', 'kind']) refsInput(name, { filename, content, reason, kind }[name]);
    function refsInput(name, control) { control.addEventListener('input', () => { if (syncContext()) { render(); void refresh(); return; } if (draft[name] === control.value) return; draft[name] = control.value; draft.requestKey = null; draft.requestBody = null; draft.uncertain = false; edits++; notice = '草稿已修改，尚未保存或应用。'; persist(); render(); }); }
    const history = node('select'), detail = node('details'), detailBody = node('div'), apply = button('应用为新需求版本', () => { void perform('apply'); }, true);
    detail.open = true; detail.append(node('summary', '变更原文与影响'), detailBody); history.addEventListener('change', () => { if (syncContext()) { render(); void refresh(); return; } draft.selectedId = history.value; persist(); render(); });
    body.append(node('h3', '变更记录'), field('选择变更记录', history), detail, apply);
    const versions = node('details'), versionsBody = node('div'); versions.append(node('summary', '输入版本历史'), versionsBody); body.append(versions); root.append(body); element.append(root);
    refs = { refreshButton, status, errorBox, noticeBox, body, version, staleBox, load, filename, content, reason, kind, file, importButton, save, history, detail, detailBody, apply, versionsBody };
  }
  function renderDetail(item) {
    const signature = JSON.stringify(item ?? null); if (signature === detailSignature) return; detailSignature = signature;
    refs.detailBody.replaceChildren(); if (!item) { refs.detailBody.append(node('p', '暂无变更记录。')); return; }
    const proposal = item.appliedDraft ?? item.draft, diff = proposal?.changes;
    refs.detailBody.append(node('p', `${STATUSES[item.status] ?? '未知状态（不可应用）'} · ${item.id}`), node('p', `原因：${item.reason ?? proposal?.reason ?? '未记录'}`),
      node('p', `分类：${KINDS[item.kind ?? proposal?.kind] ?? '未知'}（标签不证明语义影响已精确分析）`), node('p', `基于代次 ${Number.isSafeInteger(item.generation) ? item.generation : '未知'} · ${item.baseRevision ?? '未知版本'}`));
    if (item.error) refs.detailBody.append(node('p', String(item.error), 'sc-note sc-error'));
    if (diff?.rename) refs.detailBody.append(node('p', `文件名：${diff.rename.from} → ${diff.rename.to}`));
    if (diff?.metadataOnly) refs.detailBody.append(node('p', '仅文件名改变，仍须全部重新验证。'));
    for (const block of Array.isArray(diff?.blocks) ? diff.blocks : []) {
      refs.detailBody.append(node('p', `原文差异：${({ add: '新增', delete: '删除', modify: '修改' })[block.type] ?? '变化'}（原 ${block.oldStartLine ?? '?'} 行，新 ${block.newStartLine ?? '?'} 行）`), node('p', '删除的原文'), node('pre', String(block.removed ?? '')), node('p', '新增的原文'), node('pre', String(block.added ?? '')));
    }
    refs.detailBody.append(node('p', '影响范围采用保守的全部重验：旧 passed 结果不复用；所有下游需新版本审阅和回归。分类与文本差异不证明业务语义正确。', 'sc-note'),
      node('p', proposal?.impact?.requiresMigrationReview === true ? '需要单独审阅数据迁移；此操作不会执行迁移。' : '数据迁移尚未执行；持久化影响可能未知，后续仍需审阅。'));
  }
  function canApply() { const item = selected(); return !action && !stale() && data?.capabilities?.canApply === true && item?.status === 'pending' && item.baseRevision === current().revision && item.generation === current().generation; }
  function render() {
    if (!refs || destroyed) return;
    refs.body.hidden = !projectId; refs.status.textContent = !projectId ? '请先选择项目，再查看或提出需求变更。' : loading && !data ? '正在读取需求输入版本…' : data ? (data.capabilities?.reason || '待应用请求仅在安全检查点发布。') : '尚未取得当前输入版本，请刷新核对。';
    refs.errorBox.hidden = !error; refs.errorBox.textContent = error; refs.noticeBox.hidden = !notice && !draft.uncertain;
    refs.noticeBox.textContent = notice || (draft.uncertain ? '上次保存结果尚不确定，请先刷新核对。若重试相同正文，将复用同一请求编号。' : '');
    refs.version.textContent = validCurrent(current()) ? `当前输入：代次 ${current().generation} · ${current().revision} · ${current().source.filename}` : '当前版本信息不完整，不能保存或应用。';
    refs.staleBox.hidden = !draft.baseRevision || !stale(); refs.staleBox.textContent = '草稿基于旧输入版本。已保留编辑内容；请复制所需修改后，点击“基于当前版本重新编辑”载入新版本，才能保存或应用。';
    for (const key of ['filename', 'content', 'reason', 'kind']) refs[key].disabled = !projectId || !draft.baseRevision;
    refs.load.disabled = !!action || !validCurrent(current()); refs.save.disabled = !!action || stale(); refs.importButton.disabled = !!action || stale(); refs.apply.disabled = !canApply();
    refs.save.textContent = action?.kind === 'save' ? '正在保存，等待后端确认…' : '保存为待应用变更';
    const list = changes(), listSignature = JSON.stringify(list.map(item => [item.id, item.status, item.createdAt]));
    if (refs.history.dataset.signature !== listSignature) { refs.history.replaceChildren(); for (const item of list) { const option = node('option', `${STATUSES[item.status] ?? '未知'} · ${item.createdAt ?? ''} · ${item.id}`); option.value = item.id; refs.history.append(option); } refs.history.dataset.signature = listSignature; }
    if (!list.some(item => item.id === draft.selectedId)) draft.selectedId = list.at(-1)?.id ?? '';
    refs.history.value = draft.selectedId; refs.history.disabled = !list.length; renderDetail(selected());
    const versionText = JSON.stringify(Array.isArray(data?.versions) ? data.versions : []);
    if (refs.versionsBody.dataset.signature !== versionText) { refs.versionsBody.dataset.signature = versionText; refs.versionsBody.replaceChildren(); for (const item of Array.isArray(data?.versions) ? data.versions : []) refs.versionsBody.append(node('p', `代次 ${item?.generation ?? '未知'} · ${item?.revision ?? '未知'} · ${item?.source?.filename ?? item?.filename ?? ''}`)); }
  }
  async function refresh() {
    if (!mounted || destroyed) return false; syncContext(); render(); clearTimeout(timer); if (!projectId) return false;
    const token = { projectId, epoch, read: ++readId }; loading = true; render();
    try {
      const response = await api(basePath(), { cache: 'no-store' });
      if (!isCurrent(token) || token.read !== readId) return false;
      if (!response || typeof response !== 'object' || !Array.isArray(response.changes)) throw new Error('变更状态格式不完整，请刷新核对。');
      data = response;
      if (!draft.baseRevision && validCurrent(current())) { draft.baseRevision = current().revision; draft.baseGeneration = current().generation; draft.filename = current().source.filename; draft.content = current().source.content; fillForm(); }
      persist(); render(); return true;
    } catch (failure) { if (isCurrent(token) && token.read === readId) { if (data) data = { ...data, capabilities: null }; report(failure); render(); } return false; }
    finally { if (isCurrent(token) && token.read === readId) { loading = false; render(); schedule(); } else if (!destroyed && syncContext()) { render(); void refresh(); } }
  }
  async function perform(kind) {
    if (destroyed) return; if (syncContext()) { render(); void refresh(); return; } if (action || !projectId) return;
    if (kind === 'apply' ? !canApply() : stale()) return;
    const token = { projectId, epoch, kind }, item = selected(), startEdits = edits; action = token; error = ''; notice = ''; render();
    let attemptedSave = false, submittedKey;
    try {
      if (kind === 'parse') {
        const file = refs.file.files[0]; if (!file || !/\.(md|txt|docx)$/i.test(file.name) || file.size > 3 * 1024 * 1024) throw new Error('请选择不超过 3 MiB 的 MD、TXT 或 DOCX 文件。');
        let payload;
        if (/\.docx$/i.test(file.name)) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); payload = { filename: file.name, fileBase64: btoa(binary) }; }
        else payload = { filename: file.name, content: await file.text() };
        if (!isCurrent(token)) return;
        const result = await api(`${basePath()}/parse`, { method: 'POST', body: JSON.stringify(payload) }); if (!isCurrent(token)) return;
        if (!result?.source || typeof result.source.filename !== 'string' || result.source.filename.length > 160 || typeof result.source.content !== 'string' || result.source.content.length > 100000) throw new Error('文件解析结果无效，已保留原草稿。');
        if (startEdits !== edits) throw new Error('解析期间草稿已编辑，未覆盖现有文本。请重新导入。');
        draft.filename = result.source.filename; draft.content = result.source.content; draft.requestKey = null; draft.requestBody = null; draft.uncertain = false; edits++; fillForm(); persist(); notice = '文件已解析到草稿，尚未保存或应用。';
      } else if (kind === 'save') {
        if (!draft.filename.trim() || draft.filename.length > 160 || !draft.content.trim() || draft.content.length > 100000 || !draft.reason.trim() || draft.reason.length > 5000) throw new Error('请填写有效的文件名、正文和变更原因。');
        const body = { baseRevision: draft.baseRevision, source: { filename: draft.filename, content: draft.content }, reason: draft.reason, kind: draft.kind }, signature = JSON.stringify(body);
        if (draft.requestBody !== signature || !draft.requestKey) { draft.requestBody = signature; draft.requestKey = crypto.randomUUID(); }
        const requestKey = draft.requestKey; submittedKey = requestKey; draft.uncertain = true; persist(); attemptedSave = true;
        const response = await api(basePath(), { method: 'POST', body: JSON.stringify({ ...body, requestKey }) }); if (!isCurrent(token)) return;
        if (!response?.change || typeof response.change.id !== 'string') throw new Error('保存结果不完整，请刷新核对；不要重复创建新请求。');
        if (draft.requestKey === requestKey) draft.uncertain = false; draft.selectedId = response.change.id; persist();
        notice = '请求已保存；当前输入未因保存而改变。请核对差异与后端状态。'; await refresh();
      } else {
        const response = await api(`${basePath()}/${encodeURIComponent(item.id)}/apply`, { method: 'POST', body: JSON.stringify({ baseRevision: item.baseRevision, generation: item.generation }) }); if (!isCurrent(token)) return;
        const refreshed = await refresh(); if (!isCurrent(token)) return;
        const confirmed = changes().find(change => change.id === item.id);
        if (response?.change?.status !== 'applied' || !refreshed || confirmed?.status !== 'applied' || !validCurrent(current()) || confirmed.sourceRevision !== current().revision || confirmed.appliedGeneration !== current().generation) throw new Error('应用结果尚未由后端当前版本确认，请刷新核对。请求不会自动重放。');
        notice = '后端已确认新输入版本。旧运行只读；请重新生成并确认规格和计划。代码与数据库迁移尚未执行。';
        try { await onApplied(confirmed); } catch { if (isCurrent(token)) report(new Error('需求已应用，项目列表刷新未完成，请刷新页面核对。')); }
      }
    } catch (failure) {
      if (isCurrent(token)) { if (attemptedSave && draft.requestKey === submittedKey) { draft.uncertain = !Number.isInteger(failure?.status) || failure.status >= 500; persist(); } report(failure); if (kind === 'apply') notice = '应用未获确认。草稿已保留，可刷新后在安全检查点核对。'; }
    } finally { if (isCurrent(token) && action === token) { action = null; render(); schedule(); } else if (!destroyed && syncContext()) { render(); void refresh(); } }
  }
  return Object.freeze({ mount(element) { if (mounted || destroyed || !element?.append) throw new Error('需求变更面板只能挂载一次。'); mounted = true; build(element); syncContext(); fillForm(); render(); return refresh(); }, refresh,
    destroy() { persist(); destroyed = true; mounted = false; epoch++; readId++; action = null; clearTimeout(timer); root?.remove(); refs = null; } });
}
