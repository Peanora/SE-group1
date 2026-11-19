export function createPlanningIssue({ container, getState, submit }) {
  const heading = container.querySelector('h3');
  const message = container.querySelector('[data-issue-message]');
  const draft = container.querySelector('[data-issue-draft]');
  const draftTitle = draft.querySelector('[data-issue-draft-title]');
  const draftDescription = draft.querySelector('[data-issue-draft-description]');
  const draftQuote = draft.querySelector('[data-issue-draft-quote]');
  const explanation = container.querySelector('[data-issue-explanation]');
  const previous = container.querySelector('[data-issue-previous]');
  const form = container.querySelector('form');
  const fields = form.querySelector('[data-issue-fields]');
  const retry = container.querySelector('[data-issue-retry]');
  const recover = container.querySelector('[data-issue-recover]');
  const save = form.querySelector('[data-issue-save]');
  const proceed = form.querySelector('[data-issue-continue]');
  const status = container.querySelector('[data-issue-status]');
  const drafts = new Map();
  const automaticAttempts = new Set();
  let openedRun = '', rendered = '', pending = '', submittedIssue = '', localMessage = '', explainFailed = false;

  function key(run = getState().run) {
    return run?.id && run.planningIssue?.id ? `${run.id}:${run.planningIssue.id}` : '';
  }

  function renderQuestions(qa, answers) {
    fields.replaceChildren(...qa.map(({ id, question, previousAnswer }) => {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const title = document.createElement('span');
      const input = document.createElement('textarea');
      label.className = 'review-field';
      title.textContent = question;
      input.dataset.issueAnswer = id;
      input.rows = 3;
      input.maxLength = 4000;
      input.value = answers[id] ?? '';
      label.append(title, input);
      item.append(label);
      if (previousAnswer) {
        const prior = document.createElement('p');
        prior.id = `planning-prior-${id}`;
        prior.className = 'planning-issue-previous-answer';
        prior.textContent = `上次回答「${previousAnswer}」。请写出具体选择，也可以说明首版暂不包含或由系统决定。`;
        input.setAttribute('aria-describedby', prior.id);
        item.append(prior);
      }
      return item;
    }));
  }

  function answerFields() {
    return [...fields.querySelectorAll('textarea')];
  }

  function render() {
    const { run, busy, canEdit } = getState();
    const issue = run?.planningIssue;
    const visible = Array.isArray(issue?.qa) && run.id === openedRun && !run.sourceSuperseded;
    container.hidden = !visible;
    if (!visible) return false;

    const current = key(run);
    const signature = JSON.stringify([current, issue.qa]);
    if (rendered !== signature) {
      rendered = signature;
      localMessage = '';
      explainFailed = false;
      renderQuestions(issue.qa, drafts.get(current) ?? issue.answers);
    }
    const locked = busy || Boolean(pending) || !canEdit;
    const inputs = answerFields();
    const answered = inputs.filter(input => input.value.trim()).length;
    heading.textContent = `查看问题 · ${issue.title}`;
    message.textContent = issue.message;
    const requirement = issue.draftRequirement;
    draft.hidden = !requirement;
    if (requirement) {
      draftTitle.textContent = `模型草案第 ${requirement.index} 条 · ${requirement.title}`;
      draftDescription.textContent = requirement.description;
      draftQuote.textContent = requirement.sourceQuote;
      draftQuote.closest('p').hidden = !requirement.sourceQuote;
    }
    explanation.textContent = issue.explanation?.explanation ?? '';
    explanation.hidden = !explanation.textContent;
    previous.textContent = issue.qa.length > 1 ? issue.answer ?? '' : '';
    previous.closest('details').hidden = !previous.textContent;
    form.hidden = !inputs.length;
    for (const input of inputs) input.disabled = locked || !issue.canSave;
    save.hidden = proceed.hidden = !canEdit;
    save.disabled = locked || !issue.canSave || answered === 0;
    proceed.disabled = locked || !issue.canContinue || answered !== inputs.length;
    retry.hidden = !canEdit || !issue.allowQuestions || !(issue.explanationError || explainFailed);
    retry.disabled = locked || !issue.canExplain;
    recover.hidden = !canEdit || !(issue.canRebuild || issue.canRetrySpec);
    recover.disabled = locked;

    const willExplain = canEdit && issue.autoExplain && !automaticAttempts.has(current);
    status.textContent = pending === 'explain' || willExplain ? '正在请模型生成需要确认的问题…'
      : ['continue', 'retrySpec'].includes(pending) ? '正在用已保存的信息重新整理规格…'
        : pending === 'save' ? '正在保存回答…'
          : localMessage || issue.explanationError || (issue.pending ? '前次请求仍待核对。'
            : inputs.length ? `已填写 ${answered} / ${inputs.length} 项。提交后会自动核对是否还需要补充。`
              : '');
    if (submittedIssue && submittedIssue !== current) {
      submittedIssue = '';
      if (container.getClientRects().length) {
        heading.scrollIntoView({ block: 'nearest' });
        heading.focus({ preventScroll: true });
      }
    }
    if (!locked && willExplain) {
      automaticAttempts.add(current);
      if (automaticAttempts.size > 30) automaticAttempts.delete(automaticAttempts.values().next().value);
      queueMicrotask(() => {
        const latest = getState();
        if (key(latest.run) === current && latest.run.id === openedRun && !latest.busy && latest.canEdit) void act('explain', true);
        else automaticAttempts.delete(current);
      });
    }
    return true;
  }

  async function act(action, automatic = false) {
    const { run, busy, canEdit } = getState();
    const current = key(run), issue = run?.planningIssue;
    if (!current || busy || !canEdit || pending) return;
    const payload = { issueId: issue.id };
    if (action === 'explain') payload.automatic = automatic;
    else {
      payload.answers = Object.fromEntries(answerFields().map(input => [input.dataset.issueAnswer, input.value]));
      payload.continue = action === 'continue';
    }
    localMessage = '';
    explainFailed = false;
    pending = action;
    if (action === 'continue') submittedIssue = current;
    render();
    try {
      if (action === 'retrySpec') await submit('retry', { stageId: 'spec' });
      else await submit(action === 'explain' ? 'explain_planning_issue' : 'answer_planning_issue', payload);
      if (action === 'continue') drafts.delete(current);
      if (key() === current && action === 'save') localMessage = '回答已保存。';
    } catch (error) {
      if (action === 'continue') submittedIssue = '';
      if (key() === current) {
        localMessage = error.message || '操作未完成。';
        explainFailed = action === 'explain';
      }
    } finally {
      pending = '';
      render();
    }
  }

  fields.addEventListener('input', () => {
    drafts.set(key(), Object.fromEntries(answerFields().map(input => [input.dataset.issueAnswer, input.value])));
    if (drafts.size > 30) drafts.delete(drafts.keys().next().value);
    localMessage = '';
    render();
  });
  retry.addEventListener('click', () => { void act('explain'); });
  recover.addEventListener('click', () => { void act(getState().run?.planningIssue?.canRebuild ? 'continue' : 'retrySpec'); });
  save.addEventListener('click', () => { void act('save'); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!proceed.disabled) void act('continue');
  });
  return {
    render,
    open({ focus = true } = {}) {
      if (openedRun !== getState().run?.id) submittedIssue = '';
      openedRun = getState().run?.id ?? '';
      if (!render()) return false;
      if (focus) {
        heading.scrollIntoView({ block: 'nearest' });
        heading.focus({ preventScroll: true });
      }
      return true;
    },
  };
}
