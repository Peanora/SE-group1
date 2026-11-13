const escape = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const copy = (value) => structuredClone(value);
const short = (value) => value ? String(value).slice(0, 10) : '尚未生成';
const lines = (value) => String(value).split('\n').map((line) => line.trim()).filter(Boolean);
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const actionNames = { approve_spec: '确认规格', reject_spec: '退回规格', revise_spec: '修订规格', approve_plan: '确认计划', reject_plan: '退回计划', revise_plan: '修订计划' };

// This editor owns its inputs. Polling updates status without replacing live drafts or focus.
export function createPlanningReview({ container, getState, submit, refresh, showArtifact, toast }) {
  const drafts = new Map();
  const reviewModes = new Map();
  let viewKey = '';
  let currentDraft = null;
  let pending = false;
  const $ = (selector) => container.querySelector(selector);
  const $$ = (selector) => [...container.querySelectorAll(selector)];
  const storageKey = (run, kind) => `taskflow-review:${run.id}:${kind}`;

  function persist(draft) {
    try { sessionStorage.setItem(draft.key, JSON.stringify(draft)); } catch { /* In-memory drafts remain available if browser storage is full. */ }
  }
  function clearDraft(draft) {
    drafts.delete(draft.key);
    try { sessionStorage.removeItem(draft.key); } catch { /* Browser storage can be unavailable. */ }
  }
  function getDraft(run, kind) {
    const key = storageKey(run, kind);
    let draft = drafts.get(key);
    if (!draft) {
      try { draft = JSON.parse(sessionStorage.getItem(key)); } catch { /* Use the current saved version. */ }
    }
    const revision = kind === 'spec' ? run.specRevision : run.planRevision;
    if (!draft || draft.key !== key || !draft.dirty && !draft.feedback && draft.revision !== revision) {
      draft = {
        key, kind, revision,
        specRevision: run.specRevision, spec: copy(run.spec), tasks: copy(run.tasks || []),
        answers: Object.fromEntries((run.specQuestions || []).map((q) => [q.id, q.answer || ''])),
        feedback: '', dirty: false, error: '', opened: [],
      };
    }
    drafts.set(key, draft);
    return draft;
  }
  function field(label, name, value, { multiline = false, rows = 2, help = '', max = 10000 } = {}) {
    const id = `review-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    return `<label class="review-field" for="${escape(id)}"><span>${escape(label)}</span>${multiline
      ? `<textarea id="${escape(id)}" data-review-field="${escape(name)}" rows="${rows}" maxlength="${max}">${escape(value)}</textarea>`
      : `<input id="${escape(id)}" data-review-field="${escape(name)}" type="text" maxlength="${max}" value="${escape(value)}">`}${help ? `<small>${escape(help)}</small>` : ''}</label>`;
  }
  function list(items) { return (items || []).length ? `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : '<p>无</p>'; }
  function specEditor(run, draft) {
    const spec = draft.spec;
    return `<div class="review-form-grid">${field('规格标题', 'spec.title', spec.title, { max: 300 })}${field('需求摘要', 'spec.summary', spec.summary, { multiline: true, rows: 3, max: 10000 })}</div>
      <fieldset class="review-stack"><legend>技术选型</legend>${field('前端', 'stack.frontend', spec.stack?.frontend || '', { max: 500 })}${field('服务端', 'stack.backend', spec.stack?.backend || '', { max: 500 })}${field('数据存储', 'stack.storage', spec.stack?.storage || '', { max: 500 })}</fieldset>
      <details class="review-context" data-review-details="context"><summary>目标、角色与其他规格内容（只读）</summary><div class="review-context-grid"><div><h4>项目目标</h4>${list(spec.goals)}<h4>用户角色</h4>${list(spec.roles)}</div><div><h4>约束</h4>${list(spec.constraints)}<h4>假设</h4>${list(spec.assumptions)}<h4>验收场景</h4>${list(spec.acceptanceScenarios)}</div></div></details>
      <div class="review-section-heading"><h4>需求与验收</h4><span>${spec.requirements?.length || 0} 项；原文引用保留</span></div>
      <div class="review-item-list">${(spec.requirements || []).map((requirement, index) => `<details class="review-item" data-review-details="requirement-${index}" ${index === 0 ? 'open' : ''}><summary><span>${escape(requirement.id)}</span><strong>${escape(requirement.title)}</strong></summary><div class="review-item-body">${field('需求标题', `requirement.${index}.title`, requirement.title, { max: 300 })}${field('需求描述', `requirement.${index}.description`, requirement.description, { multiline: true, rows: 3 })}${field('验收条件', `requirement.${index}.acceptance`, (requirement.acceptance || []).join('\n'), { multiline: true, rows: 3, help: '每行一条可检查的条件。' })}<div class="review-source"><strong>原文引用（只读）</strong><blockquote>${escape(requirement.sourceQuote)}</blockquote></div></div></details>`).join('')}</div>
      <section class="review-questions" aria-labelledby="review-questions-title"><div class="review-section-heading"><h4 id="review-questions-title">待确认问题</h4><span id="review-question-count"></span></div><p class="review-help">逐项写明决定，再点击“保存修订”。保存回答后，仍需单独确认规格。</p>${(run.specQuestions || []).length ? run.specQuestions.map((q, index) => `<div class="review-question">${field(`${q.id}　${q.question}${q.blocking ? '（必须回答）' : ''}`, `answer.${q.id}`, draft.answers[q.id] || '', { multiline: true, rows: 2, max: 4000 })}<button type="button" class="text-button" data-suggest-answer="${index}">填入推荐回答</button></div>`).join('') : '<p class="review-help">本版没有待确认问题。</p>'}<p class="review-help" id="review-suggestion-note" hidden>推荐回答来自本地规则，只是一项建议。请核对并修改，再自行保存和确认。</p></section>`;
  }
  function planEditor(run, draft) {
    return `<div class="review-plan-basis"><strong>计划依据</strong><span>规格第 ${escape(run.specVersion || 1)} 版 / ${escape(short(run.specRevision))}</span><p>任务仍为待开发。保存修订会重新检查依赖和需求覆盖，通过后再等待你的确认。</p></div><div class="review-item-list">${draft.tasks.map((task, index) => `<details class="review-item" data-review-details="task-${index}" ${index === 0 ? 'open' : ''}><summary><span>${escape(task.id)}</span><strong>${escape(task.title)}</strong><small>${(task.dependsOn || []).length} 项依赖</small></summary><div class="review-item-body">${field('任务标题', `task.${index}.title`, task.title, { max: 300 })}${field('任务描述', `task.${index}.description`, task.description, { multiline: true, rows: 3 })}${field('验收条件', `task.${index}.acceptance`, (task.acceptance || []).join('\n'), { multiline: true, rows: 3, help: '每行一条可检查的条件。' })}<div class="review-form-grid">${field('前置依赖', `task.${index}.dependsOn`, (task.dependsOn || []).join('\n'), { multiline: true, rows: 2, help: '每行一个任务编号；没有依赖可留空。' })}${field('需求来源', `task.${index}.requirementIds`, (task.requirementIds || []).join('\n'), { multiline: true, rows: 2, help: '每行一个需求编号。' })}</div><div class="review-source"><strong>关联需求与原文（按已保存计划）</strong>${(task.requirementIds || []).map((id) => { const requirement = run.spec?.requirements?.find((r) => r.id === id); return `<p>${escape(id)} ${escape(requirement?.title || '')}</p>${requirement ? `<blockquote>${escape(requirement.sourceQuote)}</blockquote>` : ''}`; }).join('') || '<p>无</p>'}</div></div></details>`).join('')}</div>`;
  }
  function approval(label, record, expected) {
    const valid = record && record.revision === expected;
    return `<div><strong>${escape(label)}</strong>${record ? `<p>${valid ? '已确认本版' : '历史确认，当前版本需重新确认'} / ${escape(short(record.revision))}</p><p>${escape(date(record.at))}${record.specRevision ? ` / 依据规格 ${escape(short(record.specRevision))}` : ''}</p>${record.feedback ? `<blockquote>${escape(record.feedback)}</blockquote>` : ''}` : '<p>尚未确认当前版本</p>'}</div>`;
  }
  function history(run) {
    const snapshots = ['spec', 'plan'].flatMap((kind) => (run.revisionHistory?.[kind] || []).map((item) => ({ ...item, kind })));
    const decisions = run.decisions || [];
    return `<details class="review-history" data-review-details="history"><summary>确认依据与修订历史 <span>${snapshots.length} 次历史修订 / ${decisions.length} 条操作</span></summary><div class="review-approval-grid">${approval('规格确认', run.approvals?.spec, run.specRevision)}${approval('计划确认', run.approvals?.plan, run.planRevision)}</div><div class="review-history-list">${decisions.length ? [...decisions].reverse().map((item) => `<div><strong>${escape(actionNames[item.action] || '审阅操作')}</strong><time>${escape(date(item.at))}</time><p>版本 ${escape(short(item.revision))}${item.specRevision ? ` / 依据规格 ${escape(short(item.specRevision))}` : ''}</p>${item.feedback ? `<blockquote>${escape(item.feedback)}</blockquote>` : ''}</div>`).join('') : '<p class="review-help">尚无审阅操作记录。</p>'}</div>${snapshots.length ? `<h4>已替换版本</h4>${snapshots.map((item, index) => `<details class="review-snapshot" data-review-details="snapshot-${index}"><summary>${item.kind === 'spec' ? '规格' : '计划'}第 ${escape(item.version || '—')} 版 / ${escape(short(item.revision))} / ${escape(date(item.at))}</summary>${item.kind === 'spec' ? `<p>${escape(item.spec?.title || '')}</p><p>${escape(item.spec?.summary || '')}</p>${list((item.spec?.requirements || []).map((r) => `${r.id} ${r.title}：${r.description}`))}${list((item.specQuestions || []).map((q) => `${q.question}：${q.answer || '未答复'}`))}` : list((item.tasks || []).map((task) => `${task.id} ${task.title}：${task.description}`))}</details>`).join('')}` : ''}</details>`;
  }
  function rejected(run, kind, revision) { return (run.decisions || []).some((item) => item.action === `reject_${kind}` && item.revision === revision); }
  function isSpecRevisionFromPlan(run, kind) { return run.workflowVersion === 2 && run.status === 'awaiting_review' && kind === 'spec'; }
  function syncControls() {
    const { run, busy } = getState();
    if (!run || !currentDraft) return;
    const draft = currentDraft;
    const legacy = run.workflowVersion !== 2;
    const revisingSpec = isSpecRevisionFromPlan(run, draft.kind);
    const waiting = legacy ? run.status === 'awaiting_review' : revisingSpec || run.status === `awaiting_${draft.kind === 'spec' ? 'spec' : 'review'}`;
    const revision = draft.kind === 'spec' ? run.specRevision : run.planRevision;
    const stale = !legacy && (draft.revision !== revision || draft.kind === 'plan' && draft.specRevision !== run.specRevision);
    const unanswered = (run.specQuestions || []).filter((q) => !String(q.answer || '').trim()).length;
    const blocked = !legacy && rejected(run, draft.kind, revision);
    const lock = busy || pending;
    $$('input, textarea, [data-suggest-answer]').forEach((element) => { element.disabled = lock || !waiting; });
    $$('[data-review-mode]').forEach((button) => { button.disabled = lock; });
    $$('[data-review-action]').forEach((button) => {
      const action = button.dataset.reviewAction;
      button.disabled = lock || !waiting || stale || (revisingSpec && action !== 'save') || (action === 'approve' && !legacy && (draft.dirty || blocked || draft.kind === 'spec' && unanswered > 0)) || (action === 'save' && !draft.dirty);
    });
    const status = $('#review-draft-status');
    if (status) status.textContent = stale ? `保存版本已变化。当前草稿基于 ${short(draft.revision)}，仍保留原文；请载入最新版本后重新核对。` : draft.dirty ? '有未保存的修订。先保存，再确认新版本。' : blocked ? '本版已退回。请修改并保存为新版本后再确认。' : draft.kind === 'spec' && unanswered ? `还有 ${unanswered} 个问题未答复；填写并保存后才能确认。` : '正在审阅已保存的版本。';
    const reset = $('#review-load-current');
    if (reset) { reset.hidden = !stale; reset.disabled = lock; }
    const count = $('#review-question-count');
    if (count) count.textContent = `${(run.specQuestions || []).length} 项 / ${unanswered} 项未保存答复`;
    const error = $('#review-action-error');
    if (error) { error.textContent = draft.error || ''; error.hidden = !draft.error; }
    const approve = $('[data-review-action="approve"]');
    if (approve) approve.textContent = lock ? '正在处理…' : legacy ? '确认并导出' : draft.kind === 'spec' ? '确认规格并继续' : '确认计划并导出';
  }
  function render() {
    const { run } = getState();
    const legacy = run && run.workflowVersion !== 2;
    const visible = run && (legacy ? run.status === 'awaiting_review' : !!run.specRevision);
    container.hidden = !visible;
    if (!visible) { viewKey = ''; currentDraft = null; return; }
    const localMode = run.status === 'awaiting_review' && run.workflowVersion === 2 ? reviewModes.get(run.id) || 'plan' : '';
    const kind = legacy ? 'legacy' : run.status === 'awaiting_spec' || !run.planRevision || localMode === 'spec' ? 'spec' : 'plan';
    const draft = getDraft(run, kind);
    currentDraft = draft;
    const signature = `${run.id}:${kind}:${localMode}:${run.status}:${run.specRevision}:${run.planRevision}:${run.decisions?.length || 0}`;
    if (signature === viewKey) { syncControls(); return; }
    viewKey = signature;
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const focusName = focused?.dataset.reviewField;
    const selection = focusName ? [focused.selectionStart, focused.selectionEnd] : null;
    const revisingSpec = isSpecRevisionFromPlan(run, kind);
    const active = legacy ? true : revisingSpec || run.status === (kind === 'spec' ? 'awaiting_spec' : 'awaiting_review');
    const revision = kind === 'spec' ? run.specRevision : run.planRevision;
    const version = kind === 'spec' ? run.specVersion : run.planVersion;
    container.innerHTML = `<div class="review-intro"><span class="review-check" aria-hidden="true">${active ? '?' : '✓'}</span><div><h3 id="review-heading">${legacy ? '旧版记录：开发计划等待审阅' : revisingSpec ? '修订已确认规格' : active ? kind === 'spec' ? '先确认规格，再生成开发计划' : '开发计划已生成，请确认后导出' : '本次运行的确认与修订记录'}</h3><p>${legacy ? '这条记录沿用旧版流程；本次确认仅用于导出规划文档。' : revisingSpec ? '保存新规格会使现有规格确认和开发计划失效。你需要重新确认规格，再生成并确认计划。' : active ? '修改与确认分开记录，每次确认只对所显示的保存版本有效。' : '这里保留真实确认依据。开发任务仍需后续编码与验收。'}</p></div><button type="button" class="text-button" data-review-document="${kind === 'spec' ? 'spec.md' : 'task.md'}">${kind === 'spec' ? '查看规格文档' : '查看任务文档'}</button></div>
      ${localMode ? `<div class="review-plan-basis"><button type="button" class="text-button" data-review-mode="${revisingSpec ? 'plan' : 'spec'}">${revisingSpec ? '返回计划审阅' : '返回规格修订'}</button><p>${revisingSpec ? '尚未保存的规格草稿不会改变已确认规格。返回计划审阅时，两份草稿都会保留。' : '发现规格问题可返回修订。切换视图会保留尚未保存的计划和规格草稿。'}</p></div>` : ''}
      ${legacy ? '' : `<ol class="review-steps"><li class="${run.approvals?.spec?.revision === run.specRevision ? 'confirmed' : kind === 'spec' ? 'current' : ''}"><span>1</span><div><strong>确认规格</strong><small>第 ${escape(run.specVersion || 1)} 版 / ${escape(short(run.specRevision))}</small></div></li><li class="${run.approvals?.plan?.revision === run.planRevision && run.planRevision ? 'confirmed' : kind === 'plan' && active ? 'current' : ''}"><span>2</span><div><strong>确认开发计划</strong><small>${run.planRevision ? `第 ${escape(run.planVersion || 1)} 版 / ${escape(short(run.planRevision))}` : '规格确认后生成'}</small></div></li></ol><p class="review-version">${kind === 'spec' ? '规格' : '计划'}第 ${escape(version || 1)} 版 / ${escape(short(revision))}${run.sourceRevision ? ` / 需求快照 ${escape(short(run.sourceRevision))}` : ''}</p>`}
      ${active ? `${legacy ? '' : `<div class="review-editor">${kind === 'spec' ? specEditor(run, draft) : planEditor(run, draft)}</div>`}<div class="review-feedback-area">${field(revisingSpec ? '规格修订说明（选填）' : '审阅意见（退回修改时必填）', 'feedback', draft.feedback, { multiline: true, rows: 2, max: 4000 })}</div><p id="review-action-error" class="inline-error" role="alert" hidden></p><div class="review-bottom"><div><p id="review-draft-status" class="review-help" aria-live="polite"></p><button type="button" id="review-load-current" class="text-button" hidden>放弃本地草稿，载入最新版本</button></div><div class="review-actions">${legacy ? '' : `${revisingSpec ? '' : '<button type="button" class="button button-outline" data-review-action="reject">退回修改</button>'}<button type="button" class="button ${revisingSpec ? 'button-primary' : 'button-outline'}" data-review-action="save">保存修订</button>`}${revisingSpec ? '' : '<button type="button" class="button button-primary" id="approve-button" data-review-action="approve">确认</button>'}</div></div>` : ''}
      ${legacy ? '' : history(run)}`;
    $$('[data-review-details]').forEach((details) => {
      if (draft.opened.includes(details.dataset.reviewDetails)) details.open = true;
      details.addEventListener('toggle', () => {
        const opened = new Set(draft.opened);
        if (details.open) opened.add(details.dataset.reviewDetails); else opened.delete(details.dataset.reviewDetails);
        draft.opened = [...opened]; persist(draft);
      });
    });
    syncControls();
    if (focusName) {
      const input = $$('[data-review-field]').find((element) => element.dataset.reviewField === focusName);
      if (input && !input.disabled) { input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
    }
  }
  container.addEventListener('input', (event) => {
    const name = event.target.dataset.reviewField;
    if (!name || !currentDraft) return;
    const draft = currentDraft;
    const value = event.target.value;
    const [group, key, property] = name.split('.');
    if (group === 'feedback') draft.feedback = value;
    else {
      draft.dirty = true;
      if (group === 'spec') draft.spec[key] = value;
      if (group === 'stack') { draft.spec.stack ||= {}; draft.spec.stack[key] = value; }
      if (group === 'requirement') draft.spec.requirements[Number(key)][property] = property === 'acceptance' ? lines(value) : value;
      if (group === 'task') draft.tasks[Number(key)][property] = ['acceptance', 'dependsOn', 'requirementIds'].includes(property) ? lines(value) : value;
      if (group === 'answer') draft.answers[key] = value;
    }
    persist(draft); syncControls();
  });
  function suggestion(question, draft) {
    if (/负责人|交付时间|排期|工期/.test(question)) return null;
    const selections = {
      frontend: ['原生 HTML / CSS / JavaScript（桌面与手机浏览器）', /前端|界面形式|支持的终端/],
      backend: ['Node.js 22.21 及以上版本，原生 HTTP 服务', /后端|服务边界|实现语言/],
      storage: ['SQLite（本地持久化数据库）', /数据库|存储|数据保存|备份/],
    };
    const relevant = Object.keys(selections).filter((key) => selections[key][1].test(question));
    if (!relevant.length && /技术选型|技术栈/.test(question)) relevant.push(...Object.keys(selections));
    if (relevant.length) {
      draft.spec.stack ||= {};
      for (const key of relevant) {
        if (!draft.spec.stack[key]?.trim() || /待确认|未确定|未指定|TBD/i.test(draft.spec.stack[key])) {
          draft.spec.stack[key] = selections[key][0];
          const input = $$('[data-review-field]').find((element) => element.dataset.reviewField === `stack.${key}`);
          if (input) input.value = selections[key][0];
        }
      }
      return `建议：${relevant.map((key) => `${({ frontend: '前端', backend: '服务端', storage: '数据存储' })[key]}采用${draft.spec.stack[key]}`).join('；')}。首版在本地运行；上线部署、容量与备份安排需在实施前由团队落实。`;
    }
    if (/验收|预期输出|异常场景/.test(question)) return '建议：以各项需求中已列出的验收条件为基线，实施时记录有效输入、无效输入、权限和持久化场景的实际结果。具体业务示例由团队在编码前核对补充。';
    if (/通知|找回密码/.test(question)) return '建议：首版暂不包含邮件通知和自助找回密码，后续需求另行评估并记录。';
    if (/外部协作|外部成员/.test(question)) return '建议：首版仅允许项目内已授权成员参与，暂不开放外部协作者。';
    return '建议：首版仅实现原文明确范围；本项暂不扩展，后续变更另行评审。';
  }
  async function act(action) {
    const { run, busy } = getState();
    const draft = currentDraft;
    if (!run || !draft || busy || pending) return;
    const legacy = run.workflowVersion !== 2;
    const revisingSpec = isSpecRevisionFromPlan(run, draft.kind);
    if (revisingSpec && action !== 'save') return;
    draft.error = '';
    if (action === 'reject' && !draft.feedback.trim()) {
      draft.error = '请在审阅意见中说明需要修改的位置和原因。'; persist(draft); syncControls(); $('[data-review-field="feedback"]')?.focus(); return;
    }
    if (action === 'save' && draft.kind === 'spec') {
      const invalid = !draft.spec.title?.trim() || !draft.spec.summary?.trim() || Object.values(draft.spec.stack || {}).some((value) => !value.trim()) || (draft.spec.requirements || []).some((r) => !r.title.trim() || !r.description.trim() || !r.acceptance.length);
      if (invalid) { draft.error = '请填写规格标题、摘要、技术选型，以及每项需求的标题、描述和验收条件。'; persist(draft); syncControls(); return; }
    }
    if (action === 'save' && draft.kind === 'plan' && draft.tasks.some((task) => !task.title.trim() || !task.description.trim() || !task.acceptance.length)) {
      draft.error = '请填写每项任务的标题、描述和至少一条验收条件。'; persist(draft); syncControls(); return;
    }
    let apiAction;
    let payload = { feedback: draft.feedback };
    if (legacy) apiAction = 'approve';
    else {
      apiAction = `${action === 'save' ? 'revise' : action === 'reject' ? 'reject' : 'approve'}_${draft.kind}`;
      payload.revision = draft.revision;
      if (draft.kind === 'plan') payload.specRevision = draft.specRevision;
      if (action === 'save') payload = { ...payload, ...(draft.kind === 'spec' ? { spec: draft.spec, answers: draft.answers } : { tasks: draft.tasks }) };
    }
    pending = true; syncControls();
    try {
      const savedRun = await submit(apiAction, payload);
      if (action === 'save' || action === 'approve') clearDraft(draft);
      if (revisingSpec && action === 'save') reviewModes.delete(run.id);
      viewKey = ''; render();
      toast(action === 'save' ? '修订已保存，请核对新版本后单独确认' : action === 'reject' ? '已退回，请修改并保存为新版本' : legacy || draft.kind === 'plan' ? '已确认计划，正在导出规划文档' : '已确认规格，正在生成开发计划');
      return savedRun;
    } catch (error) {
      draft.error = error.message || '操作未保存，请稍后重试。'; persist(draft);
      try { await refresh(); } catch { /* Keep the actionable error and the original draft. */ }
    } finally { pending = false; syncControls(); }
  }
  container.addEventListener('click', (event) => {
    const modeButton = event.target.closest('[data-review-mode]');
    if (modeButton) {
      const { run, busy } = getState();
      if (modeButton.disabled || pending || busy || run?.workflowVersion !== 2 || run.status !== 'awaiting_review') return;
      reviewModes.set(run.id, modeButton.dataset.reviewMode);
      if (currentDraft) persist(currentDraft);
      render(); $('#review-heading')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const button = event.target.closest('[data-review-action]');
    if (button && !button.disabled) { act(button.dataset.reviewAction); return; }
    const documentButton = event.target.closest('[data-review-document]');
    if (documentButton) { showArtifact(documentButton.dataset.reviewDocument); return; }
    if (event.target.closest('#review-load-current') && currentDraft && !pending) { clearDraft(currentDraft); viewKey = ''; render(); return; }
    const suggest = event.target.closest('[data-suggest-answer]');
    if (suggest && !suggest.disabled && currentDraft) {
      const q = getState().run.specQuestions[Number(suggest.dataset.suggestAnswer)];
      const input = $$('[data-review-field]').find((element) => element.dataset.reviewField === `answer.${q.id}`);
      if (!input || input.value.trim()) return;
      const answer = suggestion(q.question, currentDraft);
      if (!answer) { currentDraft.error = '负责人、优先级、交付时间和业务依赖需要项目团队确认。请填写已确认的安排。'; persist(currentDraft); syncControls(); input.focus(); return; }
      input.value = answer; input.dispatchEvent(new Event('input', { bubbles: true }));
      $('#review-suggestion-note').hidden = false; input.focus();
    }
  });
  return { render };
}
