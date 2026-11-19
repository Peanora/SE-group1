const TERMINAL_FAILURES = new Set(['failed', 'stopped', 'timed_out', 'reconciliation_required', 'diagnostic_passed']);
const EXECUTION_STATES = {
  reserved: '等待执行', preparing: '准备工作区', checking_environment: '检查环境', generating: '正在编码',
  proposal_rejected: '正在修正候选', self_check: '正在自检', validating: '独立验收中', running: '任务执行中',
  merging: '正在集成', pause_requested: '正在暂停', paused: '已暂停', paused_recovery_ready: '可恢复',
  recovery_requested: '正在恢复', cancel_requested: '正在停止', failed: '执行失败', stopped: '已停止', timed_out: '已超时',
  reconciliation_required: '状态待核对', diagnostic_passed: '诊断结束', restoring_delivery: '正在核对同版本交付', accepted: '代码版本已固定',
};

function checkSummary(checks) {
  return [['HTTP', checks?.http], ['浏览器', checks?.browser]].filter(([, rows]) => Array.isArray(rows) && rows.length)
    .map(([name, rows]) => `${name} ${rows.filter(row => row.passed === true).length}/${rows.length}`).join('，');
}

export function deliverySteps({ project, run, historical, verification, development }) {
  const step = (id, title, state, text, detail = '') => ({ id, title, state, text, detail });
  const waiting = (id, title, text = '尚未开始') => step(id, title, 'idle', text);
  const stage = id => run?.stages?.find(item => item.id === id);
  const spec = stage('spec');
  const specApproved = !!run?.specRevision && run.approvals?.spec?.revision === run.specRevision;
  const planApproved = !!run?.planRevision && run.approvals?.plan?.revision === run.planRevision && run.approvals?.plan?.specRevision === run.specRevision && specApproved;
  const unanswered = (run?.specQuestions ?? []).filter(question => question.blocking && !question.answer?.trim()).length;
  const clarifying = run?.status === 'awaiting_spec' && (unanswered > 0 || run.spec?.clarificationRequired);
  const planStages = ['architecture', 'tasks', 'review'].map(stage);
  const failedPlan = planStages.find(item => item?.status === 'failed');
  const activePlan = planStages.filter(item => item?.status === 'running');
  const steps = [project ? step('source', '需求输入', 'done', '已导入', run?.sourceSnapshot?.filename || project.source?.filename) : waiting('source', '需求输入')];
  steps.push(clarifying ? step('spec', '设计规格', 'waiting', '等待补充需求', run?.planningIssue?.qa?.length ? `${run.planningIssue.qa.length} 个问题` : '查看待处理内容')
    : spec?.status === 'failed' ? step('spec', '设计规格', 'failed', '整理失败', '查看原因')
      : spec?.status === 'succeeded' ? step('spec', '设计规格', 'done', '草案已生成', `${run.spec?.requirements?.length ?? 0} 条需求`)
        : spec?.status === 'running' ? step('spec', '设计规格', 'working', '正在整理') : waiting('spec', '设计规格'));
  steps.push(specApproved ? step('spec-approval', '确认规格', 'done', '已确认')
    : run?.status === 'awaiting_spec' && !clarifying ? step('spec-approval', '确认规格', 'waiting', '待你确认') : waiting('spec-approval', '确认规格', '等待规格草案'));
  steps.push(failedPlan ? step('plan', '开发计划', 'failed', '生成失败', failedPlan.title)
    : activePlan.length ? step('plan', '开发计划', 'working', '正在规划', activePlan.map(item => item.title).join('、'))
      : run?.planRevision && stage('review')?.status === 'succeeded' ? step('plan', '开发计划', 'done', '已生成', `${run.tasks?.length ?? 0} 个任务`)
        : specApproved && run?.status === 'running' ? step('plan', '开发计划', 'working', '正在检查依赖') : waiting('plan', '开发计划', '等待规格确认'));
  steps.push(planApproved ? step('plan-approval', '确认计划', 'done', '已确认')
    : run?.status === 'awaiting_review' && run.workflowVersion === 2 ? step('plan-approval', '确认计划', 'waiting', '待你确认') : waiting('plan-approval', '确认计划', '等待计划草案'));
  const item = development?.execution;
  let preparation = waiting('verification', '验收准备', historical ? '历史版本' : '等待计划确认');
  if (planApproved && !historical) {
    const definition = verification ?? { state: 'idle', text: '当前不可用' };
    // The execution has already been admitted against its approved definition.
    // The project lock can temporarily hide that definition from the editing list.
    const confirmedForDevelopment = item?.active === true || development?.hasDefinition || definition.state === 'done';
    preparation = confirmedForDevelopment ? step('verification', '验收准备', 'done', '清单已确认')
      : step('verification', '验收准备', definition.state, definition.text, definition.detail);
  }
  steps.push(preparation);
  let coding = waiting('coding', '编写代码', '等待验收清单');
  let testing = waiting('testing', '测试与审查', '等待代码候选');
  let delivery = waiting('delivery', '交付', '等待验收通过');
  if (planApproved && !historical && item) {
    const passed = development.accepted;
    const taskCount = item.tasks?.length ?? 0;
    const taskProgress = taskCount ? `${item.tasks.filter(task => task.status === 'completed').length}/${taskCount} 项已集成` : '';
    const failures = TERMINAL_FAILURES.has(item.status);
    const currentCheck = item.status === 'validating' || item.tasks?.some(task => ['self_check', 'validating'].includes(task.stage) && task.status !== 'completed');
    const checks = checkSummary(item.checks);
    coding = step('coding', '编写代码', passed || !taskCount && item.candidateCommit ? 'done' : failures ? 'failed' : 'working',
      passed || !taskCount && item.candidateCommit ? '候选已生成' : EXECUTION_STATES[item.status] || '查看执行记录', taskProgress);
    if (passed) {
      testing = step('testing', '测试与审查', 'done', '验收通过', checks);
      delivery = step('delivery', '交付', 'done', item.preview?.state === 'running' ? '预览运行中' : '可预览与下载');
    } else if (failures && (item.checks || taskCount && item.tasks.some(task => task.status === 'failed' && task.checks))) {
      testing = step('testing', '测试与审查', 'failed', '验收未通过', checks || '查看检查结果');
    } else if (currentCheck) testing = step('testing', '测试与审查', 'working', '正在检查候选', checks);
    else if (item.checks) testing = step('testing', '测试与审查', 'waiting', '等待最终结论', checks);
  } else if (planApproved && !historical && preparation.state === 'done') {
    coding = step('coding', '编写代码', 'waiting', development?.canStart ? '待开始开发' : '暂未就绪', development?.canStart ? '' : development?.reason);
  }
  steps.push(coding, testing, delivery);
  return steps;
}
