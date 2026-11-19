const ID = /^[A-Za-z0-9_-]{1,128}$/u, HASH = /^[a-f0-9]{64}$/u;
const identifier = value => typeof value === 'string' && ID.test(value);
const STATES = { stopped: '已停止', starting: '正在启动', running: '运行中', reconciliation_required: '状态待核对', preparing: '正在备份和核对来源', awaiting_review: '等待迁移确认', changes_requested: '需要修订', approved: '迁移已确认', accepted: '新版本已验收', preparing_activation: '正在准备本机版本', activation_ready: '等待切换本机版本', active: '已启用本机版本', failed: '未完成' };
const node = (tag, text, className) => { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result; };
const safeUrl = value => { try { const url = new URL(value); return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash ? url.href : null; } catch { return null; } };
const STYLE = `.project-evolution{padding:20px;margin-top:20px;border:1px solid #e2e9f3;border-radius:12px;background:#fff;color:#344c6d;font:13px/1.8 "Microsoft YaHei",sans-serif;min-width:0}.project-evolution *{box-sizing:border-box;min-width:0}.project-evolution [hidden]{display:none!important}.project-evolution h2{font-size:18px;margin:0 0 10px}.project-evolution h3{font-size:15px;margin:18px 0 8px}.project-evolution p{overflow-wrap:anywhere}.project-evolution label{display:grid;gap:5px;margin:10px 0}.project-evolution input,.project-evolution select,.project-evolution textarea{max-width:100%;width:100%;padding:8px;border:1px solid #cfd9e6;border-radius:6px;background:#fff;color:inherit;font:inherit}.project-evolution textarea{min-height:80px;resize:vertical}.project-evolution button{padding:8px 12px;margin:4px 8px 4px 0;border:1px solid #cbd7e7;border-radius:6px;background:#f8fafc;color:inherit;font:inherit;cursor:pointer;white-space:normal}.project-evolution :disabled{opacity:.5;cursor:default}.project-evolution :focus-visible{outline:3px solid #9ab0ef;outline-offset:3px}.project-evolution .ev-note{padding:10px;background:#f5f8ff;border-left:3px solid #92ade8}.project-evolution .ev-error{background:#fff2f1;color:#98463e;border-color:#bd635a}.project-evolution .ev-consent{display:flex;align-items:flex-start;gap:8px}.project-evolution .ev-consent input{width:auto;flex:none;margin-top:7px}.project-evolution .ev-row{border-top:1px solid #e2e9f3;padding:10px 0}.project-evolution a{color:#315deb;overflow-wrap:anywhere}@media(max-width:600px){.project-evolution{padding:16px 12px}.project-evolution button{width:100%;margin:5px 0}}`;

/** Backend state is authoritative. Draft inputs never trigger model calls. */
export function createProjectEvolution({ api, getContext, onError = () => {} }) {
  let root, context = {}, key = '', epoch = 0, readId = 0, timer, destroyed = false, fresh = false, busy = false, data = null, message = '', error = '';
  const refs = {}, fields = {}, drafts = new Map(); let selections = {}, focusToRestore = null;
  const scope = () => { const value = getContext() ?? {}; return { projectId: value.projectId ?? '', runId: value.runId ?? '', specRevision: value.specRevision ?? '', planRevision: value.planRevision ?? '', sourceRevision: value.sourceRevision ?? '', sourceGeneration: value.sourceGeneration ?? 0, planningStatus: value.planningStatus ?? 'unconfirmed' }; };
  const valid = value => identifier(value.projectId) && identifier(value.runId);
  const base = () => `/api/projects/${encodeURIComponent(context.projectId)}`, runBase = () => `${base()}/runs/${encodeURIComponent(context.runId)}`;
  const token = () => ({ key, epoch }), current = value => !destroyed && value.key === key && value.epoch === epoch && JSON.stringify(scope()) === key;
  function saveDraft() { if (!key || !root) return; const value = Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, input.value])); drafts.set(key, value); try { sessionStorage.setItem(`taskflow/evolution/${key}`, JSON.stringify(value)); } catch {} }
  function sync() {
    const next = scope(), nextKey = JSON.stringify(next); if (nextKey === key) return;
    saveDraft(); context = next; key = nextKey; epoch++; readId++; fresh = false; busy = false; data = null; message = ''; error = ''; clearTimeout(timer);
    refs.releases?.replaceChildren();
    let draft = drafts.get(key); if (!draft) { try { draft = JSON.parse(sessionStorage.getItem(`taskflow/evolution/${key}`)); } catch {} }
    for (const [name, input] of Object.entries(fields)) input.value = draft?.[name] ?? (name === 'migrationType' ? 'none' : name === 'columnType' ? 'INTEGER' : '');
    selections = { ...(draft ?? {}) }; focusToRestore = null; if (refs.consent) refs.consent.checked = false;
  }
  function label(text, name, type = 'input') { const item = node('label'), title = node('span', text), input = node(type); fields[name] = input; input.dataset.field = name; if (type === 'textarea') input.maxLength = 5000;
    const changed = () => { selections[name] = input.value; saveDraft(); if (type === 'select') { refs.consent.checked = false; render(); } }; input.addEventListener('input', changed); if (type === 'select') input.addEventListener('change', changed); item.append(title, input); return item; }
  function selectOptions(input, entries, placeholder = '请选择') { const previous = input.value || selections[input.dataset.field] || ''; const signature = JSON.stringify(entries); if (input.dataset.options === signature && entries.some(([id]) => id === input.value)) return;
    input.dataset.options = signature; input.replaceChildren(new Option(placeholder, ''), ...entries.map(([id, text]) => new Option(text, id))); if (entries.some(([id]) => id === previous)) input.value = previous; }
  function action(text, kind) { const button = node('button', text); button.type = 'button'; button.dataset.action = kind; button.addEventListener('click', () => void perform(kind)); refs[kind] = button; return button; }
  function build(host) {
    root = node('section', undefined, 'project-evolution'); root.setAttribute('aria-label', '本机业务版本与已有数据变更'); root.append(node('style', STYLE), node('h2', '本机业务版本与已有数据变更'), node('p', '启用后的版本保存你在应用中录入的数据。需求修改后，先确认新规划和测试定义，再核对迁移并开发新版本。', 'ev-note'));
    refs.notice = node('p', '', 'ev-note'); refs.notice.setAttribute('role', 'status'); refs.error = node('p', '', 'ev-note ev-error'); refs.error.setAttribute('role', 'alert'); root.append(refs.notice, refs.error, action('刷新状态', 'refresh'));
    root.append(node('h3', '本机业务版本')); refs.releases = node('div'); root.append(refs.releases, label('首次启用的已验收源码', 'executionId', 'select'), action('启用本机业务版本', 'activateInitial'));
    root.append(node('h3', '准备已有数据变更'), label('旧业务版本', 'releaseId', 'select'), label('当前已认可的联合测试定义', 'proposalId', 'select'), label('本次变更说明', 'reason', 'textarea'), action('备份旧数据并准备变更', 'prepare'));
    root.append(label('变更记录', 'evolutionId', 'select')); fields.evolutionId.addEventListener('change', () => { refs.consent.checked = false; render(); }); refs.summary = node('p', '', 'ev-note'); root.append(refs.summary);
    root.append(label('数据处理方式', 'migrationType', 'select')); for (const [value, text] of [['none', '不修改数据结构（权限或代码规则变化）'], ['addColumn', '增加一个字段并给旧数据设置默认值'], ['mapValues', '将一个字段的旧值改为新值']]) fields.migrationType.add(new Option(text, value));
    root.append(label('数据表', 'table', 'select'), label('字段名称', 'column'), label('新字段类型', 'columnType', 'select')); fields.columnType.add(new Option('整数', 'INTEGER')); fields.columnType.add(new Option('文字', 'TEXT'));
    root.append(label('新字段默认值', 'defaultValue'), label('要替换的旧值', 'oldValue'), label('替换后的新值', 'newValue'), label('其他值映射（每行：旧值 → 新值；不变的值也要列出）', 'mappingLines', 'textarea'), action('保存迁移修订', 'revise'), label('审阅意见', 'feedback', 'textarea'), action('确认这版迁移', 'approve'), action('退回修订', 'reject'));
    refs.budget = node('p', '', 'ev-note'); const consent = node('label', undefined, 'ev-consent'); refs.consent = node('input'); refs.consent.type = 'checkbox'; refs.consent.addEventListener('change', render); consent.append(refs.consent, node('span', '我同意使用已显示的预算，在旧源码和数据副本上开发新版本。'));
    root.append(refs.budget, consent, action('开发新版本', 'start'), action('启用已验收的新版本', 'activate')); host.append(root);
    for (const name of ['migrationType', 'table', 'proposalId']) fields[name].addEventListener('change', () => { refs.consent.checked = false; render(); }); sync(); render();
  }
  function selected() { return data?.evolutions.find(item => item.id === fields.evolutionId.value) ?? null; }
  function render() {
    if (!root || destroyed) return;
    const row = selected(), allowed = fresh && !busy && valid(context);
    refs.notice.textContent = message || (!valid(context) ? '先选择项目和规划运行。' : !fresh ? '正在核对当前状态；结果确认前不能执行操作。' : '状态已与服务端核对。'); refs.error.textContent = error; refs.error.hidden = !error;
    for (const button of root.querySelectorAll('button')) button.disabled = button.dataset.action !== 'refresh' && !allowed;
    for (const button of refs.releases.querySelectorAll('button')) button.disabled = !allowed || button.dataset.releaseAllowed !== 'true';
    if (!fresh || busy) refs.releases.querySelectorAll('a').forEach(link => link.remove());
    refs.refresh.disabled = busy;
    refs.activateInitial.disabled = !allowed || data?.permissions.canActivate !== true || !fields.executionId.value || data?.releases.some(item => item.current);
    refs.prepare.disabled = !allowed || data?.permissions.canPrepare !== true || context.planningStatus !== 'confirmed' || !HASH.test(context.sourceRevision) || !fields.releaseId.value || !fields.proposalId.value;
    refs.revise.disabled = !allowed || !row?.actions.canRevise;
    refs.approve.disabled = refs.reject.disabled = !allowed || !row?.actions.canApprove;
    refs.start.disabled = !allowed || !row?.actions.canStart || !refs.consent.checked || !HASH.test(data?.budget?.contractRevision ?? ''); refs.activate.disabled = !allowed || !row?.actions.canActivate;
    refs.summary.textContent = row ? `${STATES[row.status] ?? row.status}${row.current ? '' : ' · 历史记录，不能用作当前版本'}。${row.error ?? ''}已保存的迁移：${row.migration?.kind === 'none' ? '不修改数据结构' : (row.migration?.operations ?? []).map(op => op.op === 'addColumn' ? `${op.table} 增加 ${op.column}` : `${op.table}.${op.column} 的值映射`).join('；')}` : '选择一条变更记录，核对和确认迁移。';
    const budget = data?.budget?.budget;
    refs.budget.textContent = budget ? `本轮最多 ${budget.maxCalls} 次编码、${budget.maxReviewCalls} 次审查。${budget.unlimited ? '计划累计执行次数不限。' : `剩余 ${budget.remainingModelCalls} 次模型调用。`}金额未配置单价，仍为未知。` : '尚未取得当前开发预算。';
    const mode = fields.migrationType.value; for (const name of ['table', 'column']) fields[name].closest('label').hidden = mode === 'none'; for (const name of ['columnType', 'defaultValue']) fields[name].closest('label').hidden = mode !== 'addColumn'; for (const name of ['oldValue', 'newValue', 'mappingLines']) fields[name].closest('label').hidden = mode !== 'mapValues';
    selectOptions(fields.table, (row?.schema ?? []).map(table => [table.name, table.label || table.name]));
  }
  function renderData() {
    const active = document.activeElement, focus = focusToRestore ?? (refs.releases.contains(active) ? { releaseId: active?.dataset.releaseId, action: active?.dataset.action } : null); focusToRestore = null;
    selectOptions(fields.executionId, data.executions.filter(item => item.accepted && item.current).map(item => [item.id, `已验收版本 ${(item.candidateCommit ?? '').slice(0, 8)}`]));
    selectOptions(fields.releaseId, data.releases.filter(item => item.current && item.state === 'stopped' && !item.active).map(item => [item.id, `已停止版本 ${(item.candidateCommit ?? '').slice(0, 8)} · 数据代次 ${item.dataGeneration}`]));
    selectOptions(fields.proposalId, data.proposals.filter(item => item.current && item.approved && item.proposal?.browser && (item.proposal.taskScopes?.length ?? 0) < 2).map(item => [item.id, item.proposal.name || item.id]));
    selectOptions(fields.evolutionId, data.evolutions.map(item => [item.id, `${STATES[item.status] ?? item.status} · ${item.reason ?? ''}`]));
    if (!fields.evolutionId.value && data.evolutions.length) fields.evolutionId.value = data.evolutions[0].id;
    refs.releases.replaceChildren(...data.releases.map(item => { const row = node('div', undefined, 'ev-row'); row.append(node('p', `${item.current ? '当前本机版本' : '历史备份'} ${(item.candidateCommit ?? '').slice(0, 8)} · ${STATES[item.state] ?? item.state}`));
      const url = safeUrl(item.url); if (url && item.state === 'running' && item.current) { const link = node('a', '打开业务应用'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
      for (const [operation, label, enabled] of [['startRelease', '启动', item.actions?.canStart], ['stopRelease', '停止并保存数据', item.actions?.canStop], ['rollback', '恢复上一个代码和数据版本', item.actions?.canRollback]]) { const button = node('button', label); button.type = 'button'; button.dataset.action = operation; button.dataset.releaseId = item.id; button.dataset.releaseAllowed = String(enabled === true); button.disabled = !fresh || busy || enabled !== true; button.addEventListener('click', () => void perform(operation, item)); row.append(button); } return row; })); render();
    if (focus?.releaseId && focus.action) [...refs.releases.querySelectorAll('button')].find(button => button.dataset.releaseId === focus.releaseId && button.dataset.action === focus.action)?.focus({ preventScroll: true });
  }
  async function refresh() {
    if (destroyed) return false; sync(); if (!valid(context)) { render(); return false; } clearTimeout(timer); const expected = token(), requestId = ++readId, focused = document.activeElement;
    const focusForRead = refs.releases.contains(focused) ? { releaseId: focused.dataset.releaseId, action: focused.dataset.action, element: focused } : null; fresh = false; render();
    try {
      const [release, evolution, execution, proposal] = await Promise.all([api(`${base()}/local-releases`), api(`${runBase()}/evolutions`), api(`${runBase()}/development-executions`), api(`${runBase()}/verification-plans`)]);
      if (!current(expected) || requestId !== readId) return false;
      if (![release.releases, evolution.evolutions, execution.executions, proposal.proposals].every(Array.isArray) || release.releases.some(item => item.projectId !== context.projectId || !identifier(item.id)) || [...evolution.evolutions, ...execution.executions, ...proposal.proposals].some(item => item.projectId !== context.projectId || item.runId !== context.runId || !identifier(item.id))) throw new Error('返回记录不属于当前项目和运行。');
      const signature = `${selected()?.revision ?? ''}/${data?.budget?.contractRevision ?? ''}`;
      data = { releases: release.releases, evolutions: evolution.evolutions, executions: execution.executions, proposals: proposal.proposals, budget: execution.capabilities,
        permissions: { canActivate: release.capabilities?.canActivate === true, canPrepare: evolution.capabilities?.canPrepare === true } };
      if (focusForRead && (document.activeElement === document.body || document.activeElement === focusForRead.element)) focusToRestore = focusForRead;
      fresh = true; error = ''; renderData(); if (signature !== `${selected()?.revision ?? ''}/${data.budget?.contractRevision ?? ''}`) refs.consent.checked = false; render(); return true;
    } catch (failure) { if (current(expected) && requestId === readId) { fresh = false; error = failure.message || '当前状态未能确认，请刷新。'; onError(failure); render(); } return false; }
    finally { if (current(expected)) timer = setTimeout(() => void refresh(), data?.releases.some(item => item.active) || data?.evolutions.some(item => ['starting', 'running', 'preparing'].includes(item.status)) ? 2000 : 7000); }
  }
  async function perform(kind, release) {
    if (kind === 'refresh') return refresh(); sync(); if (!fresh || busy || !valid(context)) return;
    const expected = token(), row = selected(); let path, body;
    try {
      const revision = row && { revision: row.revision }, entry = data.proposals.find(item => item.id === fields.proposalId.value);
      if (kind === 'activateInitial') { const execution = data.executions.find(item => item.id === fields.executionId.value && item.accepted && item.current); if (data.permissions.canActivate !== true || !execution || data.releases.some(item => item.current)) throw new Error('请先核对已验收版本及当前账号权限。'); path = `${base()}/local-releases/activate`; body = { runId: context.runId, executionId: execution.id, expectedReleaseId: null, expectedDataGeneration: 0 }; }
      else if (kind === 'prepare') { if (data.permissions.canPrepare !== true || !entry || !fields.reason.value.trim()) throw new Error('请选择已认可测试定义、填写变更说明，并核对当前账号权限。'); path = `${runBase()}/evolutions`; body = { releaseId: fields.releaseId.value, proposalId: entry.id, definitionRevision: entry.revision, expectedSourceRevision: context.sourceRevision, expectedSourceGeneration: context.sourceGeneration, requestKey: crypto.randomUUID(), reason: fields.reason.value.trim() }; }
      else if (['startRelease', 'stopRelease', 'rollback'].includes(kind)) { if (!release || !data.releases.includes(release) || release.actions?.[({ startRelease: 'canStart', stopRelease: 'canStop', rollback: 'canRollback' })[kind]] !== true) return; path = `${base()}/local-releases/${encodeURIComponent(release.id)}/${{ startRelease: 'start', stopRelease: 'stop', rollback: 'rollback' }[kind]}`; body = kind === 'stopRelease' ? {} : { expectedDataGeneration: release.dataGeneration, ...(kind === 'rollback' ? { reason: fields.reason.value.trim() || '恢复上一组可用代码和数据库。' } : {}) }; }
      else {
        if (!row || !HASH.test(row.revision)) throw new Error('请选择当前变更记录。'); path = `${runBase()}/evolutions/${encodeURIComponent(row.id)}/${kind}`;
        if (kind === 'revise') {
          const table = fields.table.value, column = fields.column.value.trim(), type = fields.columnType.value;
          let migration = { version: 1, kind: 'none', operations: [] };
          if (fields.migrationType.value !== 'none') {
            if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(table) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(column)) throw new Error('请选择数据表并填写有效的英文字段名。');
            const number = value => { if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('整数值格式无效。'); return Number(value); };
            const fieldType = row.schema?.find(item => item.name === table)?.columns.find(item => item.name === column)?.type?.toUpperCase();
            let operation;
            if (fields.migrationType.value === 'addColumn') operation = { op: 'addColumn', table, column, type, nullable: false, default: type === 'INTEGER' ? number(fields.defaultValue.value) : fields.defaultValue.value };
            else {
              if (!['TEXT', 'INTEGER'].includes(fieldType)) throw new Error('请选择旧数据中存在的文字或整数字段。');
              const convert = value => fieldType === 'INTEGER' ? number(value) : value, mapping = [];
              if (fields.oldValue.value || fields.newValue.value) mapping.push({ from: convert(fields.oldValue.value), to: convert(fields.newValue.value) });
              for (const line of fields.mappingLines.value.split('\n').filter(line => line.trim())) { const pair = line.split(/\s*(?:→|=>)\s*/u); if (pair.length !== 2) throw new Error('每组映射须写成“旧值 → 新值”。'); mapping.push({ from: convert(pair[0].trim()), to: convert(pair[1].trim()) }); }
              if (!mapping.length || mapping.length > 32 || new Set(mapping.map(item => JSON.stringify(item.from))).size !== mapping.length) throw new Error('请填写1至32组不重复的旧值映射。');
              operation = { op: 'mapValues', table, column, mapping, unmapped: 'reject' };
            }
            migration = { version: 1, kind: 'bounded_operations', operations: [operation] };
          }
          body = { ...revision, migration, reason: fields.reason.value.trim() };
        } else if (['approve', 'reject'].includes(kind)) body = { ...revision, feedback: fields.feedback.value.trim() };
        else if (kind === 'start') { if (!refs.consent.checked || !row.actions?.canStart) return; body = { ...revision, contractRevision: data.budget.contractRevision }; }
        else if (kind === 'activate') body = revision; else return;
      }
      busy = true; fresh = false; refs.consent.checked = false; saveDraft(); message = '请求已发出，等待服务端核对；不会自动重发。'; render();
      await api(path, { method: 'POST', body: JSON.stringify(body) }); if (!current(expected)) return;
      message = '请求已返回，正在读取当前记录确认结果。'; await refresh();
    } catch (failure) { if (current(expected)) { error = failure.message || '操作未能确认。'; fresh = false; onError(failure); render(); } }
    finally { if (current(expected)) { busy = false; renderDataSafe(); } }
  }
  function renderDataSafe() { if (data) renderData(); else render(); }
  return { async mount(host) { if (!root) build(host); return refresh(); }, refresh, destroy() { if (destroyed) return; saveDraft(); destroyed = true; epoch++; readId++; clearTimeout(timer); root?.remove(); } };
}
