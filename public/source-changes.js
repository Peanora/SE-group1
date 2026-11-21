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
.source-changes .sc-feature{margin:18px 0;padding:16px;border:1px solid #b7cde5;border-radius:8px;background:#f8fbff}.source-changes .sc-feature h3{margin-top:0}.source-changes .sc-feature-actions{display:flex;flex-wrap:wrap;gap:4px}.source-changes .sc-feature-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0;padding:0;list-style:none}.source-changes .sc-feature-steps li{padding:9px 10px;border-bottom:3px solid #d3dfed;background:#f4f7fb;overflow-wrap:anywhere}.source-changes .sc-feature-steps strong,.source-changes .sc-feature-steps small{display:block}.source-changes .sc-feature-steps [data-confirmed="true"]{border-color:#408365;background:#eff7f2}.source-changes .sc-feature-help{margin:8px 0;color:#536b87}.source-changes .sc-feature-replan{margin-top:12px}
.source-changes .sc-mode-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.source-changes .sc-full-editor{border:1px solid #d8e3ef;border-radius:8px;background:#fff}.source-changes .sc-full-editor>summary{padding:12px 14px;color:#405e80}.source-changes .sc-full-editor form{padding:0 14px 12px}.source-changes .sc-save-bar{position:sticky;bottom:12px;z-index:3;display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px;padding:12px 14px;margin:12px 0 20px;border:1px solid #ccdbea;border-radius:8px;background:#fff;box-shadow:0 4px 16px #344c6d12}.source-changes .sc-save-bar>p{flex-basis:100%;margin:0}.source-changes .sc-save-bar .sc-note{padding:7px 10px}.source-changes .sc-save-bar .sc-step-hint{flex:1;min-width:180px;color:#536b87;font-size:12px}.source-changes .sc-feature-actions button{margin-bottom:0}.source-changes :is(button,summary,input,textarea,select):focus-visible{outline:3px solid #94aaf3;outline-offset:2px}
@media(max-width:600px){.source-changes{padding:16px 12px}.source-changes button{width:100%;margin:5px 0}}
@media(max-width:600px){.source-changes .sc-feature{padding:12px}.source-changes .sc-feature-steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

/** Only backend source facts authorize application. All document strings stay text. */
export function createSourceChanges({ api, getContext, onApplied = () => {}, onError = () => {}, onReplan = null, onReady = () => {} }) {
  if (typeof api !== 'function' || typeof getContext !== 'function') throw new TypeError('需求变更面板需要api和项目上下文。');
  let root, refs, mounted = false, destroyed = false, timer, projectId = '', epoch = 0, readId = 0;
  let data = null, dataRead = 0, draft = emptyDraft(), action = null, error = '', notice = '', loading = false, edits = 0, detailSignature = '', selectedProcess = -1, foldedChange = '';
  const drafts = new Map(), applications = new Map();
  function emptyDraft() { return { baseRevision: null, baseGeneration: null, filename: '', content: '', reason: '', kind: 'other', requestKey: null, requestBody: null, uncertain: false, selectedId: '', featureName: '', featureDescription: '', featureAcceptance: '', featureOpen: false, featureCollapsed: false, sourceOpen: true }; }
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
  // Older browser drafts may predate baseGeneration. If they are still based on
  // the current revision, reconcile the generation instead of disabling Save.
  function reconcileDraft() {
    const value = current();
    if (!validCurrent(value) || !draft.baseRevision || draft.baseRevision !== value.revision) return;
    if (draft.baseGeneration !== value.generation) { draft.baseGeneration = value.generation; persist(); }
  }
  const basePath = () => `/api/projects/${encodeURIComponent(projectId)}/changes`;
  function isCurrent(token) { return !destroyed && projectId === token.projectId && epoch === token.epoch && contextId() === token.projectId; }
  function report(value) {
    const message = value instanceof Error ? value.message : String(value);
    error = /^(?:Failed to fetch|Load failed|NetworkError)/i.test(message) ? '暂时无法连接本地服务，操作结果尚未确认。请检查服务并刷新核对，当前草稿已保留。' : message;
    try { onError(error === message && value instanceof Error ? value : new Error(error)); } catch { /* Notices do not alter state. */ }
  }
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
      for (const name of ['filename', 'content', 'reason', 'kind', 'selectedId', 'featureName', 'featureDescription', 'featureAcceptance']) if (typeof value?.[name] === 'string') result[name] = value[name];
      if (result.filename.length > 160 || result.content.length > 100000 || result.reason.length > 5000 || !Object.hasOwn(KINDS, result.kind)) return emptyDraft();
      if (result.featureName.length > 200 || result.featureDescription.length > 10000 || result.featureAcceptance.length > 10000) return emptyDraft();
      result.featureOpen = value.featureOpen === true;
      result.featureCollapsed = value.featureCollapsed === true;
      result.sourceOpen = typeof value.sourceOpen === 'boolean' ? value.sourceOpen : !result.featureOpen;
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
    persist(); projectId = next; epoch++; readId++; action = null; data = null; dataRead = 0; applications.clear(); loading = false; error = ''; notice = ''; detailSignature = ''; selectedProcess = -1; foldedChange = ''; edits++;
    draft = next ? restore(next) : emptyDraft(); fillForm(); return true;
  }
  function fillForm() { if (!refs) return; for (const key of ['filename', 'content', 'reason', 'kind', 'featureName', 'featureDescription', 'featureAcceptance']) refs[key].value = draft[key]; refs.file.value = ''; }
  function loadCurrent() {
    if (syncContext()) { render(); void refresh(); return; }
    if (action || !validCurrent(current())) return;
    draft = { ...emptyDraft(), baseRevision: current().revision, baseGeneration: current().generation, filename: current().source.filename, content: current().source.content, selectedId: draft.selectedId,
      featureName: draft.featureName, featureDescription: draft.featureDescription, featureAcceptance: draft.featureAcceptance, featureOpen: draft.featureOpen, sourceOpen: draft.sourceOpen };
    edits++; error = ''; notice = '已载入当前输入。请编辑并保存为待应用变更。'; fillForm(); persist(); render();
  }
  function schedule() { clearTimeout(timer); if (mounted && !destroyed && projectId) timer = setTimeout(() => { void refresh(); }, 3000); }
  function featureBlock() {
    const name = draft.featureName.trim(), description = draft.featureDescription.trim(), acceptance = draft.featureAcceptance.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!name || !description || !acceptance.length) return '';
    return `## 新增功能：${name}\n\n### 功能说明\n${description}\n\n### 验收条件\n${acceptance.map(line => `- ${line}`).join('\n')}`;
  }
  function featureText(block = featureBlock()) { return block ? `${draft.content}${draft.content.endsWith('\n\n') || !draft.content ? '' : draft.content.endsWith('\n') ? '\n' : '\n\n'}${block}\n` : ''; }
  function featureAdded() { const block = featureBlock(); return !!block && draft.content.includes(block); }
  function unappendedFeature() { return draft.featureOpen && [draft.featureName, draft.featureDescription, draft.featureAcceptance].some(value => value.trim()) && !featureAdded(); }
  function featureProblem() {
    if (action) return '正在处理上一步操作，请稍候。';
    if (stale()) return '请先载入当前需求版本，再把功能加入草稿。已填写的功能说明会保留。';
    if (!featureBlock()) return '请填写功能名称、功能说明和至少一条验收条件。';
    if (featureAdded()) return '此功能已在需求草稿中，不会重复添加。下一步保存；需要调整正文时可展开“编辑完整需求”。';
    if (featureText().length > 100000) return '加入后需求正文将超过100000字符，请先精简正文或功能说明。';
    return '';
  }
  function addFeature() {
    if (destroyed || syncContext()) { render(); void refresh(); return; }
    if (featureProblem()) return;
    const block = featureBlock(); draft.content = featureText(block);
    if (!draft.reason.trim()) draft.reason = `新增功能：${draft.featureName.trim()}`;
    draft.requestKey = null; draft.requestBody = null; draft.uncertain = false; edits++; error = ''; notice = '功能已加入本地需求草稿，原有编辑已保留。请核对正文，再保存为待应用变更；尚未更新项目需求，也未调用模型。';
    fillForm(); persist(); render(); refs.save.focus({ preventScroll: true });
  }
  function openFeature({ focus = true } = {}) {
    if (!mounted || destroyed) return;
    const changed = syncContext(); foldedChange = savedDraft()?.id ?? ''; draft.featureOpen = true; draft.featureCollapsed = false; draft.sourceOpen = false; selectedProcess = 1; persist(); render();
    if (changed || !data) void refresh();
    if (focus) refs.featureName.focus({ preventScroll: true });
  }
  function closeFeature({ focus = true } = {}) {
    if (!mounted || destroyed) return;
    const changed = syncContext(); draft.featureOpen = false; draft.sourceOpen = true; selectedProcess = 1; persist(); render();
    if (changed || !data) void refresh();
    if (focus) refs.content.focus({ preventScroll: true });
  }
  function appliedCurrent() {
    if (!validCurrent(current()) || !data?.capabilities) return null;
    const item = savedDraft();
    return item?.status === 'applied' && item.sourceRevision === current().revision && Number.isSafeInteger(item.generation)
      && item.appliedGeneration === item.generation + 1 && item.appliedGeneration === current().generation ? item : null;
  }
  function savedDraft() {
    if (unappendedFeature()) return null;
    const item = selected(); return item && item.projectId === projectId && item.baseRevision === draft.baseRevision && item.generation === draft.baseGeneration
      && item.source?.filename === draft.filename && item.source?.content === draft.content && item.reason === draft.reason && item.kind === draft.kind ? item : null;
  }
  async function replan() {
    if (destroyed || syncContext()) { render(); void refresh(); return; }
    const confirmed = appliedCurrent(); if (action || loading || !confirmed || typeof onReplan !== 'function') return;
    const token = { projectId, epoch, kind: 'replan' }; action = token; error = ''; render();
    try { await onReplan({ projectId, changeId: confirmed.id, revision: current().revision, generation: current().generation }); }
    catch (failure) { if (isCurrent(token)) report(failure); }
    finally { if (isCurrent(token) && action === token) { action = null; render(); schedule(); } else if (!destroyed && syncContext()) { render(); void refresh(); } }
  }
  function build(element) {
    root = node('section', null, 'source-changes sc-process-panel'); root.setAttribute('aria-label', '需求输入变更'); root.append(node('style', STYLE));
    const heading = node('div', null, 'sc-process-heading'), headingCopy = node('div');
    headingCopy.append(node('h2', '需求变更'), node('p', '先核对改动，再发布为新的需求版本。'));
    const refreshButton = button('刷新变更状态', () => { void refresh(); }), status = node('p'), errorBox = node('p', '', 'sc-note sc-error'), noticeBox = node('p', '', 'sc-note');
    heading.append(headingCopy, refreshButton); root.append(heading);
    const boundaries = node('section', null, 'sc-boundaries'), boundaryText = node('p', '保存待应用请求不会修改当前输入，也不调用模型。应用只更新需求输入并使旧运行只读；再次编排会继承上一版运行已保存的回答，新版需求正文优先，只需补充新增或变化的问题。新规格和计划需重新确认，代码和数据库迁移尚未执行。');
    const boundaryToggle = button('发布需求会发生什么', () => { boundaryText.hidden = !boundaryText.hidden; boundaryToggle.setAttribute('aria-expanded', String(!boundaryText.hidden)); });
    boundaryText.hidden = true; boundaryToggle.setAttribute('aria-expanded', 'false'); boundaries.append(boundaryToggle, boundaryText);
    status.className = 'sc-process-status'; status.setAttribute('role', 'status'); errorBox.setAttribute('role', 'alert'); noticeBox.setAttribute('role', 'status'); root.append(status);
    const body = node('div', null, 'sc-process-body'), version = node('p', null, 'sc-version-facts'), staleBox = node('p', '', 'sc-note'), load = button('基于当前版本重新编辑', loadCurrent);
    const featureToggle = button('新增功能', openFeature), sourceToggle = button('直接修改需求', closeFeature), modeActions = node('div', null, 'sc-mode-actions');
    modeActions.append(featureToggle, sourceToggle);
    const process = node('nav', null, 'sc-process'), steps = node('ol', null, 'sc-feature-steps'), stepLabels = ['当前需求', '草稿与预览', '待应用版本', '已生效版本'];
    const phases = ['current', 'draft', 'pending', 'applied'];
    const stepStates = stepLabels.map((label, index) => {
      const item = node('li'), state = node('small'), trigger = button('', () => showProcess(index)), title = node('strong', label), number = node('span', String(index + 1), 'sc-process-number');
      trigger.dataset.sourcePhase = phases[index]; trigger.append(number, title, state); item.append(trigger); steps.append(item); return { item, state, trigger };
    });
    steps.setAttribute('aria-label', '需求变更流程'); process.setAttribute('aria-label', '需求变更步骤'); process.append(steps);
    const processContext = node('div', null, 'sc-process-context'), processDescription = node('p'), processNext = button('开始添加功能', () => locateNextAction());
    processNext.className = 'sc-process-next'; processContext.append(processDescription, processNext); body.append(process, processContext, staleBox);
    const layout = node('div', null, 'sc-process-layout'), editor = node('div', null, 'sc-edit-column'), inspector = node('aside', null, 'sc-inspector');
    inspector.setAttribute('aria-label', '需求版本与变更记录'); layout.append(editor, inspector); body.append(layout);
    const currentCard = node('section', null, 'sc-current-card'), currentPreview = node('pre');
    const currentTitle = button('当前已生效需求', () => { currentPreview.hidden = !currentPreview.hidden; currentTitle.setAttribute('aria-expanded', String(!currentPreview.hidden)); });
    currentTitle.setAttribute('aria-expanded', 'false'); currentPreview.hidden = true;
    currentPreview.setAttribute('aria-label', '当前已生效需求正文'); currentCard.append(currentTitle, currentPreview); editor.append(currentCard, modeActions);
    const form = node('form'), filename = node('input'), content = node('textarea', '', 'sc-source'), reason = node('textarea'), kind = node('select');
    filename.maxLength = 160; content.maxLength = 100000; reason.maxLength = 5000; reason.rows = 3;
    for (const [value, title] of Object.entries(KINDS)) { const option = node('option', title); option.value = value; kind.append(option); }
    form.append(field('需求文件名', filename), field('需求正文', content), field('变更原因', reason), field('变更分类（仅标签）', kind));
    const file = node('input'); file.type = 'file'; file.accept = '.md,.txt,.docx';
    const importButton = button('导入文件到草稿', () => { void perform('parse'); }); form.append(field('导入 MD / TXT / DOCX（最大 3 MiB）', file), importButton);
    const fullEditor = node('details', null, 'sc-full-editor'); fullEditor.append(node('summary', '编辑完整需求'), form);
    fullEditor.addEventListener('toggle', () => { if (syncContext()) { render(); void refresh(); return; } if (draft.sourceOpen !== fullEditor.open) { draft.sourceOpen = fullEditor.open; persist(); } });
    const save = button('保存为待应用变更', () => { void perform('save'); }, true), saveHint = node('p', '', 'sc-note'), saveBar = node('div', null, 'sc-save-bar'), stepHint = node('span', '', 'sc-step-hint');
    stepHint.setAttribute('role', 'status'); saveBar.append(stepHint, save, saveHint, errorBox, noticeBox);
    form.addEventListener('submit', event => event.preventDefault());
    for (const name of ['filename', 'content', 'reason', 'kind']) refsInput(name, { filename, content, reason, kind }[name]);
    function refsInput(name, control) { control.addEventListener('input', () => { if (syncContext()) { render(); void refresh(); return; } if (draft[name] === control.value) return; draft[name] = control.value; draft.requestKey = null; draft.requestBody = null; draft.uncertain = false; edits++; notice = '草稿已修改，尚未保存或应用。'; persist(); render(); }); }
    const feature = node('section', null, 'sc-feature'); feature.setAttribute('aria-label', '新增功能说明');
    const featureHeader = node('div', null, 'sc-feature-header'), featureSummary = node('p', '', 'sc-feature-summary'), featureEditor = node('div', null, 'sc-feature-editor');
    const featureFold = button('收起编辑', () => { draft.featureCollapsed = !draft.featureCollapsed; persist(); render(); });
    featureHeader.append(node('h3', '说明要增加的功能'), featureFold); feature.append(featureHeader, featureSummary, featureEditor);
    featureEditor.append(node('p', '填写后先核对追加预览，再加入需求草稿。原有正文和未保存的修改会保留，以上操作不调用模型。', 'sc-feature-help'));
    const featureName = node('input'), featureDescription = node('textarea'), featureAcceptance = node('textarea');
    featureName.maxLength = 200; featureDescription.maxLength = 10000; featureAcceptance.maxLength = 10000; featureDescription.rows = 3; featureAcceptance.rows = 3;
    featureEditor.append(field('功能名称', featureName), field('功能说明', featureDescription), field('功能验收条件（每行一条）', featureAcceptance));
    for (const [name, control] of Object.entries({ featureName, featureDescription, featureAcceptance })) control.addEventListener('input', () => {
      if (syncContext()) { render(); void refresh(); return; } draft[name] = control.value; edits++; persist(); render();
    });
    const featurePreview = node('pre'), featureHint = node('p', '', 'sc-feature-help'), featureAdd = button('加入需求草稿', addFeature);
    const featureNext = button('填写另一个功能', () => { if (action || syncContext()) { render(); void refresh(); return; } draft.featureName = ''; draft.featureDescription = ''; draft.featureAcceptance = ''; draft.featureCollapsed = false; fillForm(); persist(); render(); refs.featureName.focus(); });
    featurePreview.setAttribute('aria-label', '功能追加预览'); const featureActions = node('div', null, 'sc-feature-actions'); featureActions.append(featureAdd, featureNext);
    featureEditor.append(node('h4', '加入后的需求正文预览'), featurePreview, featureHint, featureActions); editor.append(feature, fullEditor, saveBar);
    const draftPreview = node('pre'), previewCard = node('section', null, 'sc-draft-preview');
    const previewToggle = button('核对完整草稿预览', () => { draftPreview.hidden = !draftPreview.hidden; previewToggle.setAttribute('aria-expanded', String(!draftPreview.hidden)); });
    previewToggle.setAttribute('aria-expanded', 'false'); draftPreview.hidden = true; draftPreview.setAttribute('aria-label', '当前需求草稿预览'); previewCard.append(previewToggle, draftPreview); editor.append(previewCard);
    const history = node('select'), detail = node('details'), detailBody = node('div'), apply = button('应用为新需求版本', () => { void perform('apply'); }, true);
    detail.className = 'sc-change-detail'; detail.open = true; detail.append(node('summary', '变更原文与影响'), detailBody); history.addEventListener('change', () => { if (syncContext()) { render(); void refresh(); return; } draft.selectedId = history.value; persist(); render(); });
    const applyHint = node('p', '', 'sc-note'), replanButton = button('重新规划', () => { void replan(); }), replanHint = node('p', '', 'sc-feature-help'), replanArea = node('div', null, 'sc-feature-replan');
    applyHint.setAttribute('role', 'status'); applyHint.classList.add('sc-feature-apply-hint');
    const publishCard = node('section', null, 'sc-publish-card'), publishTitle = node('h3', '发布与重新规划');
    replanArea.append(replanButton, replanHint); publishCard.append(publishTitle, node('p', '新规格和计划需重新确认，代码与数据库迁移尚未执行。', 'sc-publish-boundary'), apply, applyHint, replanArea); editor.append(detail, publishCard);
    const recordsHeading = node('div', null, 'sc-inspector-heading'); recordsHeading.append(node('h3', '版本与记录'), node('p', '选择历史记录只查看差异，不会替换编辑中的草稿。'));
    const historyList = node('div', null, 'sc-history-list');
    const versions = node('details', null, 'sc-version-history'), versionsBody = node('div'); versions.append(node('summary', '输入版本历史'), versionsBody);
    inspector.append(recordsHeading, version, load, field('选择变更记录', history), historyList, versions, boundaries); root.append(body); element.append(root);
    refs = { refreshButton, status, errorBox, noticeBox, body, version, staleBox, load, filename, content, reason, kind, file, importButton, save, saveHint, history, detail, detailBody, apply, versionsBody,
      featureToggle, sourceToggle, feature, featureName, featureDescription, featureAcceptance, featurePreview, featureHint, featureAdd, featureNext, steps, stepStates, fullEditor, saveBar, stepHint, applyHint, replanArea, replanButton, replanHint,
      editor, inspector, currentCard, currentTitle, currentPreview, draftPreview, previewCard, processDescription, processNext, publishCard, historyList, featureEditor, featureFold, featureSummary };
  }
  function showProcess(index) {
    if (!refs || destroyed) return; selectedProcess = index; renderProcess();
    const target = [refs.currentCard, draft.featureOpen ? refs.feature : refs.fullEditor, refs.detail, refs.publishCard][index];
    if (index === 0) { refs.currentPreview.hidden = false; refs.currentTitle.setAttribute('aria-expanded', 'true'); }
    if (index === 2) {
      refs.detail.open = true;
      if (draft.featureOpen && savedDraft() && !refs.featureEditor.contains(document.activeElement)) { draft.featureCollapsed = true; persist(); render(); }
    }
    target.tabIndex = -1; target.scrollIntoView({ block: 'start', behavior: 'auto' }); target.focus({ preventScroll: true });
  }
  function locateNextAction() {
    if (!refs || destroyed || action) return;
    const saved = savedDraft(), applied = appliedCurrent();
    if (!applied && stale()) { refs.load.scrollIntoView({ block: 'center' }); refs.load.focus({ preventScroll: true }); return; }
    if (!saved && !draft.featureOpen && validCurrent(current()) && draft.content === current().source.content && !draft.reason.trim()) { openFeature(); refs.feature.scrollIntoView({ block: 'start' }); return; }
    if (saved && !applied && !canApply()) { refs.detail.open = true; refs.detail.tabIndex = -1; refs.detail.scrollIntoView({ block: 'start' }); refs.detail.focus({ preventScroll: true }); return; }
    if (applied && typeof onReplan !== 'function') { showProcess(0); return; }
    if (applied && refs.replanButton.disabled) { showProcess(3); return; }
    const target = applied ? refs.replanButton : saved ? refs.apply : unappendedFeature() ? refs.featureAdd : refs.save;
    target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true });
  }
  function renderProcess() {
    const saved = savedDraft(), applied = appliedCurrent(), added = featureAdded(), valid = validCurrent(current());
    const editing = unappendedFeature() || valid && (draft.content !== current().source.content || draft.filename !== current().source.filename || !!draft.reason.trim());
    const pending = saved?.status === 'pending';
    const actual = applied ? 3 : pending ? 2 : editing || draft.featureOpen ? 1 : 0;
    const viewed = selectedProcess >= 0 ? selectedProcess : actual;
    const states = [valid ? `已发布 · 第 ${current().generation} 版` : '读取中或待核对', added ? '功能已加入草稿' : editing ? '本地填写中' : '填写说明与验收条件', pending || applied ? '后端已确认保存' : saved ? '记录状态待核对' : '草稿尚未保存', applied ? '后端已确认新版本' : '等待安全检查点应用'];
    refs.steps.setAttribute('aria-label', draft.featureOpen ? '新增功能流程' : '需求变更流程');
    refs.stepStates.forEach(({ item, state, trigger }, index) => {
      state.textContent = states[index]; item.dataset.confirmed = String(index === 2 ? pending || !!applied : index === 3 ? !!applied : false);
      trigger.dataset.state = index === actual ? 'current' : index < actual ? 'complete' : 'waiting';
      trigger.setAttribute('aria-pressed', String(index === viewed));
      if (index === actual) trigger.setAttribute('aria-current', 'step'); else trigger.removeAttribute('aria-current');
      trigger.disabled = !projectId;
    });
    const descriptions = ['以服务端已发布的正文为基础，已有运行仍保留自己的需求快照。', '填写新增功能或直接修改正文；核对后保存为待应用记录。', '核对所选变更的原文差异与影响，再在安全检查点应用。', '新版本经后端确认后，可单独重新规划并重新确认规格与计划。'];
    refs.processDescription.textContent = descriptions[viewed];
    refs.processNext.textContent = applied ? typeof onReplan === 'function' ? '前往重新规划' : '查看已生效需求' : stale() ? '前往核对版本' : saved ? canApply() ? '前往应用版本' : '前往核对变更' : unappendedFeature() ? '前往加入草稿' : !editing && !draft.featureOpen ? '开始添加功能' : '前往保存草稿';
    refs.processNext.disabled = !!action || !valid;
    refs.currentTitle.textContent = valid ? `当前已生效需求 · 第 ${current().generation} 版 · ${current().source.filename}` : '当前已生效需求尚待核对';
    const currentText = valid ? current().source.content : '尚未取得服务端需求正文。';
    if (refs.currentPreview.textContent !== currentText) refs.currentPreview.textContent = currentText;
    if (refs.draftPreview.textContent !== draft.content) refs.draftPreview.textContent = draft.content || '尚未载入需求草稿。';
  }
  function renderDetail(item) {
    const signature = JSON.stringify(item ?? null); if (signature === detailSignature) return; detailSignature = signature;
    refs.detailBody.replaceChildren(); if (!item) { refs.detailBody.append(node('p', '暂无变更记录。保存草稿后，可在这里核对原文差异与影响。', 'sc-empty-state')); return; }
    const proposal = item.appliedDraft ?? item.draft, diff = proposal?.changes;
    const summary = node('div', null, 'sc-change-summary'), state = node('span', STATUSES[item.status] ?? '未知状态（不可应用）', 'sc-state-badge');
    state.dataset.state = item.status; summary.append(state, node('strong', item.reason ?? proposal?.reason ?? '未记录变更原因'));
    refs.detailBody.append(summary, node('p', `分类：${KINDS[item.kind ?? proposal?.kind] ?? '未知'}（标签不证明语义影响已精确分析）`, 'sc-change-meta'));
    const provenance = node('div', null, 'sc-change-provenance');
    provenance.append(node('p', `变更编号：${item.id}`), node('p', `基于代次 ${Number.isSafeInteger(item.generation) ? item.generation : '未知'} · ${item.baseRevision ?? '未知版本'}`));
    refs.detailBody.append(provenance);
    if (item.error) refs.detailBody.append(node('p', String(item.error), 'sc-note sc-error'));
    if (diff?.rename) refs.detailBody.append(node('p', `文件名：${diff.rename.from} → ${diff.rename.to}`));
    if (diff?.metadataOnly) refs.detailBody.append(node('p', '仅文件名改变，仍须全部重新验证。'));
    for (const block of Array.isArray(diff?.blocks) ? diff.blocks : []) {
      const section = node('section', null, 'sc-diff-block'), columns = node('div', null, 'sc-diff-columns'), removed = node('div', null, 'sc-diff-removed'), added = node('div', null, 'sc-diff-added');
      section.append(node('h4', `原文差异：${({ add: '新增', delete: '删除', modify: '修改' })[block.type] ?? '变化'}（原 ${block.oldStartLine ?? '?'} 行，新 ${block.newStartLine ?? '?'} 行）`));
      removed.append(node('p', '删除的原文'), node('pre', String(block.removed ?? '') || '（无删除）'));
      added.append(node('p', '新增的原文'), node('pre', String(block.added ?? '') || '（无新增）')); columns.append(removed, added); section.append(columns); refs.detailBody.append(section);
    }
    const impact = node('section', null, 'sc-impact'); impact.append(node('h4', '发布后的影响'), node('p', '影响范围采用保守的全部重验：旧 passed 结果不复用；所有下游需新版本审阅和回归。分类与文本差异不证明业务语义正确。', 'sc-note'),
      node('p', proposal?.impact?.requiresMigrationReview === true ? '需要单独审阅数据迁移；此操作不会执行迁移。' : '数据迁移尚未执行；持久化影响可能未知，后续仍需审阅。')); refs.detailBody.append(impact);
  }
  function canApply() { const item = selected(); return !action && !stale() && data?.capabilities?.canApply === true && item?.status === 'pending' && item.baseRevision === current().revision && item.generation === current().generation
    && (!draft.featureOpen || savedDraft() === item); }
  async function confirmApplications() {
    for (const intent of applications.values()) {
      if (!isCurrent(intent) || intent.notified || dataRead <= intent.readFloor || !validCurrent(current())) continue;
      const confirmed = changes().find(change => change.id === intent.id);
      if (confirmed?.status !== 'applied' || confirmed.projectId !== intent.projectId || confirmed.baseRevision !== intent.baseRevision || confirmed.generation !== intent.generation
        || confirmed.sourceRevision !== intent.sourceRevision || confirmed.sourceRevision !== current().revision || confirmed.appliedGeneration !== intent.generation + 1 || confirmed.appliedGeneration !== current().generation) continue;
      // Consume the notification before any callback await, including overlapping refreshes.
      intent.notified = true;
      selectedProcess = -1;
      if (action?.application === intent) action = null;
      if (error === intent.lastError) error = '';
      notice = '后端已确认新输入版本。旧运行只读；请重新生成并确认规格和计划。代码与数据库迁移尚未执行。'; render();
      try { await onApplied(confirmed); } catch { if (isCurrent(intent)) report(new Error('需求已应用，项目列表刷新未完成，请刷新页面核对。')); }
    }
  }
  function render() {
    if (!refs || destroyed) return;
    reconcileDraft();
    refs.body.hidden = !projectId; refs.status.textContent = !projectId ? '请先选择项目，再查看或提出需求变更。' : loading && !data ? '正在读取需求输入版本…' : data ? (data.capabilities?.reason || '待应用请求仅在安全检查点发布。') : '尚未取得当前输入版本，请刷新核对。';
    refs.errorBox.hidden = !error; refs.errorBox.textContent = error; refs.noticeBox.hidden = !notice && !draft.uncertain;
    refs.noticeBox.textContent = notice || (draft.uncertain ? '上次保存结果尚不确定，请先刷新核对。若重试相同正文，将复用同一请求编号。' : '');
    refs.version.textContent = validCurrent(current()) ? `当前输入：代次 ${current().generation} · ${current().revision} · ${current().source.filename}` : '当前版本信息不完整，不能保存或应用。';
    refs.staleBox.hidden = !draft.baseRevision || !stale() || Boolean(appliedCurrent()); refs.staleBox.textContent = '草稿基于旧输入版本。已保留编辑内容；请复制所需修改后，点击“基于当前版本重新编辑”载入新版本，才能保存或应用。';
    for (const key of ['filename', 'content', 'reason', 'kind']) refs[key].disabled = !projectId || !draft.baseRevision;
    refs.load.disabled = !!action || !validCurrent(current()); refs.save.disabled = !!action || stale(); refs.importButton.disabled = !!action || stale(); refs.apply.disabled = !canApply();
    refs.save.textContent = action?.kind === 'save' ? '正在保存，等待后端确认…' : '保存为待应用变更';
    refs.save.title = action ? '正在处理上一步操作，请稍候。' : !validCurrent(current()) ? '尚未取得当前输入版本，请刷新或稍候。' : !draft.baseRevision ? '请先点击“基于当前版本重新编辑”载入当前输入。' : stale() ? '草稿基于旧输入版本，不能保存；请先点击“基于当前版本重新编辑”。' : '';
    refs.saveHint.hidden = !refs.save.disabled || !refs.save.title;
    refs.saveHint.textContent = refs.save.disabled ? refs.save.title : '';
    const list = changes(), listSignature = JSON.stringify(list.map(item => [item.id, item.status, item.createdAt]));
    if (refs.history.dataset.signature !== listSignature) { refs.history.replaceChildren(); for (const item of list) { const option = node('option', `${STATUSES[item.status] ?? '未知'} · ${item.createdAt ?? ''} · ${item.id}`); option.value = item.id; refs.history.append(option); } refs.history.dataset.signature = listSignature; }
    if (!list.some(item => item.id === draft.selectedId)) draft.selectedId = list.at(-1)?.id ?? '';
    refs.history.value = draft.selectedId; refs.history.disabled = !list.length; renderDetail(selected());
    if (refs.historyList.dataset.signature !== listSignature) {
      refs.historyList.dataset.signature = listSignature; refs.historyList.replaceChildren();
      for (const item of [...list].reverse()) {
        const entry = button('', () => { if (syncContext()) { render(); void refresh(); return; } draft.selectedId = item.id; persist(); render(); });
        entry.className = 'sc-history-entry'; entry.dataset.changeId = item.id;
        const badge = node('span', STATUSES[item.status] ?? '未知状态', 'sc-state-badge'); badge.dataset.state = item.status;
        entry.append(badge, node('strong', item.reason || item.source?.filename || '需求变更'), node('small', item.createdAt ? String(item.createdAt).replace('T', ' ').slice(0, 16) : '时间未记录')); refs.historyList.append(entry);
      }
      if (!list.length) refs.historyList.append(node('p', '暂无变更记录。', 'sc-empty-state'));
    }
    for (const entry of refs.historyList.querySelectorAll('[data-change-id]')) entry.setAttribute('aria-pressed', String(entry.dataset.changeId === draft.selectedId));
    const added = featureAdded(), applied = appliedCurrent(), saved = savedDraft();
    if (draft.featureOpen && added && saved && ['pending', 'applied'].includes(saved.status) && foldedChange !== saved.id
      && !refs.featureEditor.contains(document.activeElement)) { foldedChange = saved.id; draft.featureCollapsed = true; selectedProcess = -1; persist(); }
    if (!added || !saved) draft.featureCollapsed = false;
    refs.featureEditor.hidden = draft.featureCollapsed;
    refs.featureFold.hidden = !added || !saved;
    refs.featureFold.disabled = !!action;
    refs.featureFold.textContent = draft.featureCollapsed ? '编辑草稿' : '收起编辑';
    refs.featureFold.setAttribute('aria-expanded', String(!draft.featureCollapsed));
    refs.featureSummary.hidden = !draft.featureCollapsed;
    refs.featureSummary.textContent = applied ? `${draft.featureName} · 后端已确认新版本，下一步重新规划。` : `${draft.featureName} · 草稿已保存，核对下方差异后应用。`;
    refs.applyHint.hidden = !draft.featureOpen || !!saved;
    refs.applyHint.textContent = '当前功能尚未保存到所选变更，请先加入草稿并保存，再核对差异后应用。';
    refs.feature.hidden = !draft.featureOpen; refs.steps.hidden = false;
    refs.featureToggle.disabled = !projectId || !!action; refs.sourceToggle.hidden = false; refs.sourceToggle.disabled = !!action;
    refs.featureToggle.setAttribute('aria-pressed', String(draft.featureOpen)); refs.sourceToggle.setAttribute('aria-pressed', String(!draft.featureOpen));
    if (refs.fullEditor.open !== draft.sourceOpen) refs.fullEditor.open = draft.sourceOpen;
    for (const name of ['featureName', 'featureDescription', 'featureAcceptance']) refs[name].disabled = !projectId || !!action || added;
    refs.featureAdd.disabled = !!featureProblem(); refs.featureAdd.textContent = added ? '已加入需求草稿' : '加入需求草稿'; refs.featureNext.hidden = !added; refs.featureNext.disabled = !!action;
    refs.featureHint.textContent = featureProblem() || '确认预览后加入草稿，再点击本区下方“保存为待应用变更”；不会自动保存或应用。';
    refs.stepHint.textContent = applied ? '本次需求已应用，可继续重新规划。' : saved ? '本次草稿已保存，请核对下方差异后应用。' : draft.featureOpen ? added ? '功能已加入草稿，下一步保存为待应用变更。' : '先填写功能并加入草稿；尚未保存或应用。' : '编辑完整需求后保存；保存不会应用版本或调用模型。';
    const preview = added ? draft.content : featureText(); if (refs.featurePreview.textContent !== preview) refs.featurePreview.textContent = preview || '填写完整的功能说明后，这里显示保留原有编辑并追加功能后的完整正文。';
    renderProcess();
    refs.replanArea.hidden = typeof onReplan !== 'function'; refs.replanButton.disabled = !!action || loading || !applied;
    refs.replanHint.textContent = applied ? '本次草稿对应的新需求版本已由后端确认。点击“重新规划”才会启动规划；若选择模型模式，会按页面预算调用模型。新规格和计划仍需你确认。'
      : unappendedFeature() ? '当前填写的功能尚未加入需求正文。请先加入草稿、保存并应用，不能使用之前已应用的版本替代本次功能。'
        : '先将当前草稿保存并应用为新需求版本，取得后端确认后才能从这里重新规划。保存与应用不调用模型。';
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
      data = response; dataRead = token.read;
      if (!draft.baseRevision && validCurrent(current())) { draft.baseRevision = current().revision; draft.baseGeneration = current().generation; draft.filename = current().source.filename; draft.content = current().source.content; fillForm(); }
      reconcileDraft();
      persist(); render(); await confirmApplications(); return true;
    } catch (failure) { if (isCurrent(token) && token.read === readId) { if (data) data = { ...data, capabilities: null }; report(failure); render(); } return false; }
    finally { if (isCurrent(token) && token.read === readId) {
      loading = false; render(); schedule();
      // Restoration must wait until initial loading hints and the actual draft are rendered.
      if (dataRead === token.read) { try { onReady({ projectId }); } catch { /* Layout feedback does not alter source facts. */ } }
    } else if (!destroyed && syncContext()) { render(); void refresh(); } }
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
        // The refresh initially renders the previous history. Re-select this
        // confirmed save after the new history arrives, instead of an older row.
        if (isCurrent(token) && changes().some(change => change.id === response.change.id)) { draft.selectedId = response.change.id; persist(); render(); }
      } else {
        const key = JSON.stringify([item.id, item.baseRevision, item.generation, item.sourceRevision]);
        if (!applications.has(key)) applications.set(key, { projectId, epoch, id: item.id, baseRevision: item.baseRevision, generation: item.generation, sourceRevision: item.sourceRevision, readFloor: readId, notified: false });
        token.application = applications.get(key);
        await api(`${basePath()}/${encodeURIComponent(item.id)}/apply`, { method: 'POST', body: JSON.stringify({ baseRevision: item.baseRevision, generation: item.generation }) }); if (!isCurrent(token)) return;
        await refresh(); if (!isCurrent(token)) return;
        if (!token.application.notified) throw new Error('应用结果尚未由后端当前版本确认，请刷新核对。请求不会自动重放。');
      }
    } catch (failure) {
      if (isCurrent(token)) { if (kind === 'apply' && token.application?.notified) return; if (attemptedSave && draft.requestKey === submittedKey) { draft.uncertain = !Number.isInteger(failure?.status) || failure.status >= 500; persist(); } report(failure); if (kind === 'apply') { if (token.application) token.application.lastError = error; notice = '应用未获确认。草稿已保留，可刷新后在安全检查点核对。'; } }
    } finally { if (isCurrent(token) && action === token) { action = null; render(); schedule(); } else if (!destroyed && syncContext()) { render(); void refresh(); } }
  }
  return Object.freeze({ mount(element) { if (mounted || destroyed || !element?.append) throw new Error('需求变更面板只能挂载一次。'); mounted = true; build(element); syncContext(); fillForm(); render(); return refresh(); }, refresh, openFeature, closeFeature,
    destroy() { persist(); destroyed = true; mounted = false; epoch++; readId++; action = null; applications.clear(); clearTimeout(timer); root?.remove(); refs = null; } });
}
