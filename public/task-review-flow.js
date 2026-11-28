const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const HELD = new Set(['paused', 'paused_recovery_ready', 'reconciliation_required', 'cancel_requested', 'stopped', 'timed_out']);
const status = (state, label) => ({ state, label });
const list = value => Array.isArray(value) ? value : [];
const candidate = value => COMMIT.test(value ?? '') ? value : null;

function collectHistory(execution, task) {
  const versions = new Map();
  function append(entry, receipt) {
    if (!candidate(entry.candidateCommit)) return;
    const key = JSON.stringify([entry.attemptId ?? '', entry.candidateCommit]);
    const row = versions.get(key) ?? { attemptId: entry.attemptId, commit: entry.candidateCommit };
    if (receipt) row.receipt = entry;
    else row.checks = entry.checks;
    versions.set(key, row);
  }
  for (const entry of list(execution?.reviewHistory)) {
    if (entry.taskId === task.id) append(entry, true);
  }
  for (const entry of list(task.history)) append(entry, false);
  return [...versions.values()];
}

function independentCheck(entries, errors, running, crossed, planned) {
  if (planned) return status('planned', '待执行');
  const rows = list(entries);
  const failed = rows.filter(check => check?.passed === false).length;
  if (failed) return status('failed', failed + ' 项未通过');
  if (errors.length) return status('unknown', '结果待核对');
  if (rows.length && rows.every(check => check?.passed === true)) return status('passed', rows.length + ' 项通过');
  if (crossed && !rows.length) return status('passed', '已进入同版审查');
  if (running) return status('checking', '测试中');
  return status('waiting', rows.length ? '结果未齐' : '等待测试');
}

function issueClosed(issue, commit) {
  return issue.status === 'resolved' && issue.checkedCommit === commit;
}

function reviewState({ receipt, checks, issues, commit, planned, reviewing, testFailed, testsPassed, held }) {
  if (planned) return status('planned', '待执行');
  if (!commit) return status('waiting', '等待固定候选');
  const result = receipt?.status ?? checks?.review;
  const open = list(issues).filter(issue => issue.severity === 'blocking' && !issueClosed(issue, commit));
  if (result === 'changes_requested' || result === 'failed') return status('failed', '要求修订');
  if (result === 'completed') {
    if (open.length) return status('failed', open.length + ' 项阻塞');
    if (!Array.isArray(issues) || testFailed || testsPassed === false) return status('unknown', '证据待核对');
    return status('passed', '审查通过');
  }
  if (['error', 'reconciliation_required', 'incomplete'].includes(result)) return status('unknown', '结论待核对');
  if (held) return status('unknown', '状态待核对');
  if (reviewing) return status('checking', '正在审查');
  return status('waiting', testFailed ? '等待测试修复' : testsPassed ? '等待审查' : '等待独立测试');
}

export function projectTaskReview(execution, planTask) {
  const task = list(execution?.tasks).find(item => item.id === planTask.id);
  const planned = !execution;
  const history = task ? collectHistory(execution, task) : [];
  const attemptId = task?.attemptId || null;
  const records = attemptId ? history.filter(row => row.attemptId === attemptId && row.receipt) : [];
  const latest = records.at(-1);
  const calls = attemptId ? list(execution.modelCalls).filter(call => call.taskId === task.id && call.attemptId === attemptId) : [];
  const round = calls.findLast(call => call.role === 'coding')?.attempt;
  const rewriting = ['generating', 'proposal_rejected'].includes(task?.stage);
  const betweenRounds = latest && Number.isSafeInteger(round) && Number.isSafeInteger(latest.receipt.attempt)
    && round > latest.receipt.attempt && (!candidate(task?.candidateCommit) || task.candidateCommit === latest.commit);
  const publishedCommit = task?.candidateCommit == null ? latest?.commit ?? null : candidate(task.candidateCommit);
  const commit = attemptId && !rewriting && !betweenRounds ? publishedCommit : null;
  const current = commit ? records.findLast(row => row.commit === commit) : null;
  const receipt = current?.receipt;
  // During a rewrite the unversioned task.checks can still describe an earlier candidate.
  const hasOtherVersion = history.some(row => row.commit !== commit || row.attemptId !== attemptId);
  const canBindChecks = (current != null && latest === current) || !hasOtherVersion;
  const checks = commit && canBindChecks ? task?.checks : null;
  const issues = receipt?.issues ?? checks?.issues;
  const result = receipt?.status ?? checks?.review;
  const held = HELD.has(execution?.status);
  const live = execution?.active === true && !held && task?.status === 'running';
  const reviewCall = calls.findLast(call => call.role === 'review' && call.candidateCommit === commit);
  const reviewing = Boolean(commit && live && task.stage === 'validating'
    && (result === 'checking' || reviewCall?.requestState === 'in_flight' && reviewCall.dispatched !== false && !reviewCall.finishedAt));
  const crossed = Boolean(commit && (reviewing || result === 'completed'));
  const testing = Boolean(commit && live && task.stage === 'validating' && !crossed);
  const errors = list(receipt?.errors);
  const http = independentCheck(checks?.http, errors.filter(error => error.role === 'test'), testing, crossed, planned);
  const browser = independentCheck(checks?.browser, errors.filter(error => error.role === 'browser'), testing, crossed, planned);
  const testFailed = [http, browser].some(check => ['failed', 'unknown'].includes(check.state));
  const testsPassed = http.state === 'passed' && browser.state === 'passed';
  const review = reviewState({ receipt, checks, issues, commit, planned, reviewing, testFailed, testsPassed, held });
  const coding = planned ? status('planned', '待执行') : commit ? status('passed', '候选已固定')
    : live ? status('checking', task.stage === 'self_check' ? '编码自检中' : '准备候选') : status('waiting', '尚无固定候选');
  const integrated = task?.status === 'completed';
  const release = planned ? status('planned', '待集成') : integrated && review.state === 'passed' ? status('passed', '已验收并集成')
    : integrated ? status('unknown', '集成记录待核对') : review.state === 'failed' || testFailed ? status('failed', '后继未放行')
    : review.state === 'passed' ? status('waiting', '等待集成') : status('waiting', '等待门禁');
  return { planned, taskId: planTask.id, attemptId, commit, coding, http, browser, review, release, checks,
    issues: list(issues), concluded: ['completed', 'failed', 'changes_requested'].includes(result),
    summary: receipt?.summary, error: receipt?.error, executionId: execution?.id,
    history: history.filter(row => !commit || row.commit !== commit || row.attemptId !== attemptId),
    budget: execution?.budget };
}

function renderIssues(issues, commit, escape, concluded) {
  if (!issues.length) return '';
  return '<ul class="tr-issues">' + issues.map(issue => {
    const blocking = issue.severity === 'blocking';
    const closed = issueClosed(issue, commit);
    const level = blocking ? closed ? '已复核关闭' : concluded ? '阻塞' : '阻塞项待复核' : '建议';
    const place = issue.file ? `${escape(issue.file)}${issue.line != null ? ' · L' + escape(issue.line) : ''}` : '';
    return `<li data-blocking="${blocking && !closed}"><b>${level}</b> ${escape(issue.message || issue.id || '未提供意见正文')}${place ? `<small>${place}</small>` : ''}${issue.resolution ? `<small>${escape(issue.resolution)}</small>` : ''}</li>`;
  }).join('') + '</ul>';
}

export function renderTaskReview(flow, { downstream, versions, escape, simulation, preview, contextKey, historyOpen }) {
  const titleId = 'task-review-title';
  function evidenceLink(attemptId, commit) {
    if (!flow.executionId || !attemptId || !commit || !versions.some(row => row.taskId === flow.taskId && row.attemptId === attemptId && row.candidateCommit === commit)) return '';
    return `<button type="button" class="tr-evidence-link" data-focus-key="review-evidence-${escape(attemptId)}-${escape(commit)}" data-task-review-evidence="${escape(flow.executionId)}" data-trace-task="${escape(flow.taskId)}" data-trace-attempt="${escape(attemptId)}" data-trace-commit="${escape(commit)}">查看此提交的验收证据</button>`;
  }
  const step = (key, name, value) => `<li data-review-step="${key}" data-state="${value.state}"><strong>${name}</strong><small>${escape(value.label)}</small></li>`;
  const history = flow.history.map(row => {
    const issues = row.receipt?.issues ?? row.checks?.issues;
    const result = reviewState({ receipt: row.receipt, checks: row.checks, issues, commit: row.commit });
    const concluded = ['completed', 'failed', 'changes_requested'].includes(row.receipt?.status ?? row.checks?.review);
    return `<li><span>${escape(result.label)}</span><code>${escape(row.commit)}</code><small>尝试 ${escape(row.attemptId || '编号缺失')}</small>${row.receipt?.summary ? `<p>${escape(row.receipt.summary)}</p>` : ''}${renderIssues(list(issues), row.commit, escape, concluded)}${evidenceLink(row.attemptId, row.commit)}</li>`;
  }).join('');
  const codingLimit = flow.budget?.maxCalls, reviewLimit = flow.budget?.maxReviewCalls;
  const limit = Number.isSafeInteger(codingLimit) && Number.isSafeInteger(reviewLimit)
    ? `每项任务最多调用编码 ${codingLimit} 次、审查 ${reviewLimit} 次。` : '';
  const context = simulation ? '模拟记录仅展示任务调度。' : preview ? '正在预览修订后的任务计划。'
    : flow.planned ? '计划中的验收路径，尚无绑定到本计划的按图执行记录。'
      : !flow.attemptId ? '本任务尚无可核对的执行尝试。' : '';
  return `<section id="task-review-flow" tabindex="-1" aria-labelledby="${titleId}" data-focus-key="task-review-flow-${escape(flow.taskId)}" data-review-context="${escape(contextKey)}" data-review-state="${flow.review.state}" data-review-task="${escape(flow.taskId)}" data-review-commit="${escape(flow.commit || '')}" data-review-attempt="${escape(flow.attemptId || '')}">
    <div class="tr-heading"><h4 id="${titleId}">任务审查流程</h4><span data-state="${flow.review.state}">${escape(flow.review.label)}</span></div>
    ${context ? `<p class="tr-context">${context}</p>` : ''}
    <ol class="tr-route" aria-label="同版本任务验收流程">
      ${step('coding', '编码与自检', flow.coding)}
      <li class="tr-parallel"><span>同一候选 · 并行验收</span><ul>${step('http', 'HTTP 测试', flow.http)}${step('browser', 'Edge 测试', flow.browser)}</ul></li>
      ${step('review', '独立 Review', flow.review)}${step('release', '集成与放行', flow.release)}
    </ol>
    <p class="tr-next">${downstream.length ? `集成后核对后继 ${downstream.map(escape).join('、')} 的全部前置。` : '当前模块无直接后继。'}</p>
    <p class="tr-repair">有可复现的测试失败或开放阻塞意见时，可在预算内修订代码。新提交重新测试和审查。${limit}</p>
    ${flow.attemptId ? `<dl class="tr-identity"><dt>当前尝试</dt><dd><code>${escape(flow.attemptId)}</code></dd><dt>候选提交</dt><dd><code>${escape(flow.commit || '待固定')}</code></dd></dl>` : ''}
    ${flow.summary ? `<p class="tr-conclusion">${escape(flow.summary)}</p>` : ''}${flow.error ? `<p class="tr-error">${escape(flow.error)}</p>` : ''}
    ${renderIssues(flow.issues, flow.commit, escape, flow.concluded)}${evidenceLink(flow.attemptId, flow.commit)}
    ${history ? `<details data-review-history ${historyOpen ? 'open' : ''}><summary data-focus-key="task-review-history-${escape(flow.taskId)}">历史候选 · ${flow.history.length}</summary><ul class="tr-history">${history}</ul></details>` : ''}
  </section>`;
}
