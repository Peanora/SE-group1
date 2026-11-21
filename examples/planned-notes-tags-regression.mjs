import { plannedNotesTags } from './planned-notes-tags.mjs';

// New, explicit approval fixture. The previous fixture and all old paid results
// retain their original meaning; appending checks never rewrites that evidence.
const raceRule = '首次GET列表响应晚于成功POST时，页面仍保留新增条目及正确数量；加载中锁定创建或按请求代次合并均可。便笺与标签分别在独立空库进行真实延迟响应检查，普通浏览器场景互不污染。';
const spec = structuredClone(plannedNotesTags.spec);
spec.summary += ' 新版另验首次加载和创建交错时的显示一致性。';
spec.acceptanceScenarios.push(raceRule);
for (const requirement of spec.requirements) if (['R-NOTES', 'R-TAGS'].includes(requirement.id)) requirement.acceptance.push(raceRule);
const requirements = plannedNotesTags.requirements + '\n\n' + raceRule;
function definitionFor(approvedRequirements) {
  const proposal = plannedNotesTags.definitionFor(approvedRequirements);
  proposal.id = 'notes-tags-dag-load-race-v2'; proposal.name = '便笺与标签四任务及延迟加载回归';
  for (const [taskId, kind, title] of [['NOTES', 'note', '便笺管理'], ['TAGS', 'tag', '标签管理']]) {
    const requirement = approvedRequirements.find(item => item.title === title || item.text?.split('\n')[0] === title);
    if (!requirement) throw new Error('新增回归必须关联完整确认需求。');
    const step = { id: `${kind}_delayed_create`, op: 'createWithDelayedLoad', session: `${kind}s`, requirementIds: [requirement.id], path: `/${kind}s.html`,
      loadPath: `/api/${kind}s`, inputTestId: `${kind}-name`, submitTestId: `${kind}-create`, listTestId: `${kind}-list`, countTestId: `${kind}-count`, value: `延迟加载中的${kind === 'note' ? '便笺' : '标签'}`, expectedCount: 1 };
    proposal.browser.steps.push(step);
    for (const scope of proposal.taskScopes) if ([taskId, 'FINAL'].includes(scope.taskId)) scope.browserStepIds.push(step.id);
  }
  return proposal;
}
export const plannedNotesTagsRegression = Object.freeze({ ...plannedNotesTags, requirements, spec, definitionFor });
