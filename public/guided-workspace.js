const groups = [
  { id: 'request', label: '说需求', steps: ['source', 'spec', 'spec-approval'] },
  { id: 'plan', label: '看方案', steps: ['plan', 'plan-approval'] },
  { id: 'verification', label: '确认怎么验收', steps: ['verification'] },
  { id: 'build', label: '开发与测试', steps: ['coding', 'testing'] },
  { id: 'delivery', label: '预览与下载', steps: ['delivery'] },
];
const developmentStages = [
  ['coding', '编写代码', 'codingDetails'], ['testing', '运行测试', 'buildDetails'],
  ['review', '检查代码', 'buildDetails'], ['delivery', '准备交付', 'deliveryDetails'],
];

const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const button = (id, label, plain = false) => ({ id, label, plain });
const link = (href, label, external = false, plain = false) => ({ href, label, external, plain });
const info = (title, text, fields = {}) => ({ title, text, ...fields });

function present({ project, run, historical, busy, startLabel, model, canStart, canEdit, verification, development, steps, prepareChecklist }) {
  if (!project) return info('你想做什么软件？', '用一句话说清谁会用、希望它能做什么。也可以直接上传已有文档。', {
    primary: button('new', '描述我的需求'), secondary: button('sample', '试用示例', true),
  });
  if (historical) return info('正在看旧版本', '这是以前的需求和结果。回到当前需求就能继续。', { primary: button('current', '回到当前需求') });
  if (busy) return info('正在处理你的操作', '完成后，这里会显示下一步。');
  if (!run) return info('开始整理需求', model ? '系统会先整理你写的内容，只问影响首版的关键问题。此操作会使用已配置的模型。'
    : '系统会按文档整理需求。使用一句话生成方案与后续开发，需要先配置模型。', {
    primary: canStart ? button('start', startLabel) : null, secondary: button('source', '先查看需求', true),
  });
  if (run.status === 'paused') return info('方案整理已暂停', '你可以从上次停下的地方继续。', { primary: canEdit ? button('resume', '继续整理') : null });
  if ((run.status === 'awaiting_spec' || run.status === 'awaiting_review') && run.planningIssue) {
    return info('还有几件事需要你确认', '按你的想法回答就行。列出的项目全要，可以直接写「都需要」。', { embedded: 'answers' });
  }
  if (run.status === 'failed') {
    return info('这次整理没有完成', '你的需求和已填内容都保留了。打开问题说明查看能怎样继续。', { primary: button('planningFailure', '查看原因和处理方法') });
  }
  if (run.status === 'awaiting_spec') {
    return info('看看这些是不是你想做的功能', run.mode === 'model' && !run.engineeringFallback
      ? '确认后，系统会用模型为这些功能制定开发方案。' : '确认后，系统会按这个范围制定开发方案。', {
      primary: canEdit ? button('confirmPlan', '确认这些功能') : null,
      secondary: canEdit ? button('editSource', '修改原始需求', true) : null, content: 'requirements',
    });
  }
  if (run.status === 'awaiting_review') {
    return info('核对开发方案', prepareChecklist ? '确认后会用模型准备一份验收清单，等你核对。' : '看一眼要做哪些事，以及哪些工作需要先完成。', {
      primary: canEdit ? button('confirmPlan', '确认开发方案') : null,
      secondary: button('tasks', '查看任务图', true), content: 'tasks',
    });
  }
  if (run.status === 'running') {
    const stage = run.stages?.find(item => item.status === 'running')?.id;
    const title = stage === 'export' ? '正在整理开发文档' : ['architecture', 'tasks', 'review'].includes(stage) ? '正在安排开发任务' : '正在整理你说的需求';
    return info(title, '有需要你确认的地方，会显示在这里。');
  }
  if (run.status !== 'succeeded') return info('这次运行已停下', '可以根据当前需求重新整理。', { primary: canStart ? button('start', '重新整理需求') : null });
  if (!run.engineeringPlan || !verification) {
    return info('开发文档已准备好', '这份规划可以查看和下载。生成软件需要已确认的工程方案和可用的模型服务。', {
      primary: button('documents', '查看开发文档'), secondary: canStart && model ? button('start', '用模型整理完整方案', true) : null,
    });
  }
  if (!development?.active && steps.find(item => item.id === 'verification')?.state !== 'done') {
    if (verification.draft) return info('看看怎样判断软件做好了',
      '核对下面的功能和预期效果。系统会按这份清单检查做出来的软件。', {
      primary: canEdit && verification.draft.canApprove ? button('approveVerification', '确认验收清单') : null,
      secondary: button('verificationDetails', '查看清单详情', true), content: 'checklist',
    });
    if (verification.working) return info('正在准备验收清单', '系统正在把你确认的功能整理成检查步骤。');
    if (verification.repairable) return info('这份清单可以直接修好', '系统能从已保存的内容补齐格式问题。这次修复不增加模型用量。', {
      primary: canEdit ? button('repairVerification', '修好并查看清单') : null,
      secondary: button('verificationDetails', '查看失败记录', true),
    });
    if (verification.canGenerate) return info(verification.failed ? '这次没能准备好验收清单' : '先定好软件要怎样验收',
      verification.failed ? '可以重新生成一份。本次操作会使用模型。' : '系统会根据已确认的功能安排接口和页面检查。本次操作会使用模型。', {
        primary: canEdit ? button('generateVerification', verification.failed ? '重新准备验收清单' : '准备验收清单') : null,
        cost: verification.cost,
      });
    if (verification.blocked) return info('正在核对当前进度', '项目正在处理其他操作，等状态确认后可以继续。', {
      primary: button('refreshProgress', '刷新进度'), secondary: button('verificationDetails', '查看当前记录', true),
    });
    return info(verification.text || '正在读取验收进度', verification.detail || '状态确认后，这里会显示可以继续的操作。', {
      primary: canEdit && verification.failed ? button('editSource', '补充验收要求') : null,
      secondary: verification.failed ? button('verificationDetails', '查看失败详情', true) : null,
    });
  }
  if (development?.accepted) {
    const { previewHref, downloadHref, canStopPreview, canPreview } = development;
    return info('软件已通过验收', previewHref ? '预览已打开。试用完可以停止预览，再下载源码。' : '现在可以打开试用版，或下载当前通过验收的源码。', {
      primary: previewHref ? link(previewHref, '打开软件预览', true) : canPreview ? button('preview', '启动软件预览') : downloadHref ? link(downloadHref, '下载源码') : null,
      secondary: canStopPreview ? button('stopPreview', '停止预览', true) : downloadHref && canPreview ? link(downloadHref, '下载源码', false, true) : null,
      content: 'development',
    });
  }
  if (development?.checkingDelivery) return info('正在核对已有交付', '这次的代码和历史记录还在。核对完成后会显示可用的交付操作。', {
    primary: button('buildDetails', '查看交付记录'), secondary: button('refreshProgress', '刷新进度', true),
  });
  if (development?.active) return info(development.title || '正在开发和测试', development.detail || '可以等系统完成，进度会在这里更新。', {
    primary: canEdit && development.canRecover ? button('recoverBuild', '从上次进度继续') : canEdit && development.canResume ? button('resumeBuild', '继续开发') : null,
    secondary: development.canStop ? button('stopBuild', '停止本次开发', true) : button('buildDetails', '查看进度记录', true), content: 'development', nextStep: development.held ? development.nextStep : '',
  });
  if (development?.failed) {
    const checklist = development.failureAction === 'review_checklist';
    const retry = !checklist && development.failureAction !== 'inspect';
    const primary = canEdit && checklist && development.canReviseChecklist ? button('reviseChecklist', '准备清单修订')
      : canEdit && retry && development.canRepair ? button('repairBuild', '继续自动修复')
        : canEdit && retry && development.canStart ? button('startBuild', '重新开始开发') : null;
    return info(development.failureTitle || '这次开发未完成', development.failureDetail || '打开开发记录可以看停在了哪一步。', {
      primary, secondary: button('buildDetails', '查看检查结果', Boolean(primary)), content: 'development',
      nextStep: development.nextStep, cost: primary && retry ? development.cost : null,
    });
  }
  return info('可以开始开发了', development?.canStart ? '系统会写代码并按清单跑测试。开始后会产生模型用量。' : development?.detail || '正在核对当前清单和开发条件。', {
    primary: canEdit && development?.canStart ? button('startBuild', '开始开发') : null, cost: development?.cost, content: 'development',
  });
}

function listMarkup(items, render) {
  return items.length ? `<ul class="guide-list">${items.map(render).join('')}</ul>` : '';
}

function renderDevelopment(development) {
  const current = developmentStages.findIndex(([id]) => id === development?.stage);
  const started = development?.accepted || development?.active || development?.failed || development?.held;
  const stages = developmentStages.map(([id, label, action], index) => {
    const done = development?.accepted || started && index < current;
    const selected = started && !done && index === current;
    const state = done ? 'done' : selected ? development.failed ? 'needs-attention' : development.held ? 'held' : 'working' : 'waiting';
    const text = ({ done: '已完成', 'needs-attention': '需要处理', held: '已暂停', working: '正在进行', waiting: '待开始' })[state];
    const content = `<span class="guide-phase-mark" aria-hidden="true">${done ? '✓' : ''}</span><span>${label}<small>${text}</small></span>`;
    return `<li data-phase="${id}" data-state="${state}"${selected ? ' aria-current="step"' : ''}>${done || selected
      ? `<button type="button" data-guide-stage="${action}">${content}</button>` : `<span class="guide-phase-label">${content}</span>`}</li>`;
  }).join('');
  const facts = [development?.taskCount > 1 ? `已完成 ${development.completedTasks} 项，共 ${development.taskCount} 项任务` : '',
    development?.reworkCount ? `已安排 ${development.reworkCount} 次自动返工` : ''].filter(Boolean);
  return `<ol class="guide-phases" aria-label="开发与检查进展">${stages}</ol>${facts.length ? `<p class="guide-flow-note">${facts.join(' · ')}</p>` : ''}`;
}

function contentMarkup(kind, { run, verification, development }, reading = false) {
  const requirements = run?.spec?.requirements ?? [];
  if (kind === 'requirements' || kind === 'checklist') {
    const covered = verification?.draft?.requirements;
    const shown = kind === 'checklist' && covered ? requirements.filter(item => covered.includes(item.id)) : requirements;
    return listMarkup(shown, item => {
      const acceptance = item.acceptance?.filter(text => typeof text === 'string' && text.trim()) ?? [];
      if (kind === 'checklist' && acceptance.length) {
        return `<li><details class="guide-check"${shown.length === 1 ? ' open' : ''}><summary>${escape(item.title)}</summary>
          <ul>${acceptance.map(text => `<li>${escape(text)}</li>`).join('')}</ul></details></li>`;
      }
      return `<li><strong>${escape(item.title)}</strong>${kind === 'requirements' && item.description ? `<p>${escape(item.description)}</p>` : ''}
      ${reading && acceptance.length ? `<ul>${acceptance.map(text => `<li>${escape(text)}</li>`).join('')}</ul>` : ''}</li>`;
    });
  }
  if (kind === 'tasks') {
    const names = new Map((run?.tasks ?? []).map(task => [task.id, task.title]));
    return listMarkup(run?.tasks ?? [], item => `<li><strong>${escape(item.title)}</strong>${item.dependsOn?.length
      ? `<p>先完成${escape(item.dependsOn.map(id => names.get(id) ?? id).join('、'))}</p>` : ''}</li>`);
  }
  if (kind === 'development') return renderDevelopment(development);
  return '';
}

function actionMarkup(action) {
  if (!action) return '';
  const style = action.plain ? 'guide-action-secondary' : 'guide-action-primary';
  return action.href ? `<a class="${style}" href="${escape(action.href)}"${action.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escape(action.label)}</a>`
    : `<button type="button" class="${style}" data-guide-action="${action.id}">${escape(action.label)}</button>`;
}

export function createGuidedWorkspace(host, { act, isVisible }) {
  const nav = host.querySelector('[data-guide-steps]'), surface = host.querySelector('[data-guide-surface]');
  let context, phase, viewed = '', key = '', navigationMarkup = '', surfaceMarkup = '', embedded = '';
  function render(next) {
    context = next;
    const nextKey = `${next.project?.id ?? ''}/${next.run?.id ?? ''}`;
    if (nextKey !== key) { key = nextKey; viewed = ''; }
    host.hidden = !isVisible();
    if (host.hidden) return '';
    const states = new Map(next.steps.map(item => [item.id, item.state]));
    const active = groups.find(group => group.steps.some(step => states.get(step) !== 'done')) ?? groups.at(-1);
    const read = viewed && viewed !== active.id ? groups.find(group => group.id === viewed) : null;
    const page = read
      ? info(read.label, '', { content: ({ request: 'requirements', plan: 'tasks', verification: 'checklist', build: 'development', delivery: 'development' })[read.id],
        primary: button('resumeGuide', '返回当前步骤'), secondary: read.id === 'request' ? button('source', '查看原始需求', true) : null })
      : present(next);
    phase = page;
    nav.hidden = !next.project;
    const newNavigation = groups.map((group, index) => {
      const done = group.steps.every(step => states.get(step) === 'done');
      const current = group.id === active.id;
      const failed = group.steps.some(step => states.get(step) === 'failed');
      return `<li><button type="button" data-guide-step="${group.id}" data-state="${done ? 'done' : current ? 'current' : 'waiting'}"${current ? ' aria-current="step"' : ''}
        ${viewed === group.id ? ' data-reading="true"' : ''} ${!done && !current ? 'disabled' : ''}><span class="guide-index" aria-hidden="true">${done ? '✓' : index + 1}</span>
        <span>${group.label}</span><small>${failed && !done ? '需要处理' : done ? '已完成' : current ? '当前步骤' : '待开始'}</small></button></li>`;
    }).join('');
    if (newNavigation !== navigationMarkup) {
      const focused = nav.contains(document.activeElement) ? document.activeElement.dataset.guideStep : null;
      navigationMarkup = newNavigation;
      nav.innerHTML = newNavigation;
      if (focused) [...nav.querySelectorAll('button')].find(item => item.dataset.guideStep === focused && !item.disabled)?.focus({ preventScroll: true });
    }
    const contents = contentMarkup(page.content, next, Boolean(read));
    const actions = actionMarkup(page.primary) + actionMarkup(page.secondary);
    const markup = `<h2 tabindex="-1">${escape(page.title)}</h2>${page.text ? `<p class="guide-lead">${escape(page.text)}</p>` : ''}
      ${page.nextStep ? `<p class="guide-lead"><strong>接下来</strong> ${escape(page.nextStep)}</p>` : ''}
      ${contents}${page.cost ? `<p class="guide-cost">${escape(page.cost)}</p>` : ''}${actions ? `<div class="guide-actions"${page.content === 'checklist' ? ' data-guide-approval' : ''}>${actions}</div>` : ''}`;
    if (markup !== surfaceMarkup) {
      const previous = document.activeElement;
      const focusAction = surface.contains(previous) ? previous.dataset.guideAction : null;
      const focusPhase = surface.contains(previous) ? previous.closest('[data-phase]')?.dataset.phase : null;
      surfaceMarkup = markup;
      surface.innerHTML = markup;
      if (focusAction) (surface.querySelector(`[data-guide-action="${focusAction}"]`) ?? surface.querySelector('h2')).focus({ preventScroll: true });
      else if (focusPhase) (surface.querySelector(`[data-phase="${focusPhase}"] button`) ?? surface.querySelector('h2')).focus({ preventScroll: true });
    }
    embedded = page.embedded ?? '';
    return embedded;
  }
  host.addEventListener('click', event => {
    const detail = event.target.closest('[data-guide-stage]')?.dataset.guideStage;
    if (detail && developmentStages.some(([, , action]) => action === detail)) { act(detail); return; }
    const step = event.target.closest('[data-guide-step]');
    if (step && !step.disabled) {
      viewed = step.getAttribute('aria-current') === 'step' ? '' : step.dataset.guideStep;
      act('guideNavigation');
      surface.querySelector('h2')?.focus();
      return;
    }
    const action = event.target.closest('[data-guide-action]')?.dataset.guideAction;
    if (!action || ![phase?.primary?.id, phase?.secondary?.id].includes(action)) return;
    if (action === 'resumeGuide') { viewed = ''; act('guideNavigation'); }
    else act(action);
  });
  return { render, get embedded() { return embedded; } };
}
