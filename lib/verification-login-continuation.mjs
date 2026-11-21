import { isDeepStrictEqual } from 'node:util';
import { findMissingBrowserLogin } from './planned-failure-help.mjs';
import { draftMissingBrowserLogin } from './verification-login-revision.mjs';

const loginRequirement = '每个测试窗口都先准备该角色独立的测试账号并完成登录，再打开需要登录的页面。登录是否成功必须有后续检查；不能借用接口检查或其他浏览器窗口的登录及数据。公开页面仍检查无登录访问，保留既有权限和业务预期。';

export const loginRevisionNote = (version, detail) => `验收修订第${version}版。${detail} ${loginRequirement}`;

export function loginRevisionTask(tasks) {
  return tasks?.find(task => task.writePaths?.some(file => file.startsWith('public/'))) ?? tasks?.[0];
}

export function previousLoginPlan(run) {
  if (run.status !== 'succeeded' || run.approvals?.plan?.revision !== run.planRevision) return null;
  const previous = run.revisionHistory?.plan?.at(-1);
  const decision = run.decisions?.findLast(item => item.action === 'revise_plan' && item.newRevision === run.planRevision);
  if (!previous || !decision || previous.version + 1 !== run.planVersion || decision.revision !== previous.revision
    || previous.specRevision !== run.specRevision || decision.specRevision !== run.specRevision
    || previous.approvals?.plan?.revision !== previous.revision) return null;
  const note = decision.feedback;
  if (typeof note !== 'string' || !note.startsWith(`验收修订第${run.planVersion}版。`) || !note.endsWith(` ${loginRequirement}`)) return null;
  if (!previous.engineeringPlan?.proposal || !run.engineeringPlan?.proposal) return null;
  const withoutTasks = proposal => Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== 'tasks'));
  if (!isDeepStrictEqual(withoutTasks(previous.engineeringPlan.proposal), withoutTasks(run.engineeringPlan.proposal))) return null;
  const tasks = structuredClone(previous.tasks);
  const task = loginRevisionTask(tasks);
  if (!task) return null;
  task.description += `\n\n${note}`;
  if (!isDeepStrictEqual(tasks, run.tasks)) return null;
  return { revision: previous.revision, note };
}

export function loginContinuationDraft({ run, previous, proposals, executions }) {
  const original = executions.findLast(item => item.binding?.planRevision === previous.revision);
  if (original?.status !== 'failed' || original.active || original.failureHelp?.action !== 'review_checklist'
    || loginRevisionNote(run.planVersion, original.failureHelp.detail) !== previous.note) return null;
  const prior = proposals.find(item => item.id === original.proposalId && item.revision === original.revision
    && item.status === 'approved' && item.approval?.revision === item.revision
    && item.binding?.planRevision === previous.revision && item.binding?.specRevision === run.specRevision
    && item.binding?.sourceRevision === run.sourceRevision && item.binding?.sourceGeneration === (run.sourceGeneration ?? 0));
  if (!prior) return null;
  const login = findMissingBrowserLogin({ definition: prior.proposal, browserReport: { checks: original.checks?.browser } });
  if (!login) return null;
  const draft = draftMissingBrowserLogin({ definition: prior.proposal, evidence: login,
    browserReport: { checks: original.checks.browser }, engineeringContract: run.engineeringPlan.proposal });
  if (!draft) return null;
  return {
    proposal: draft.proposal,
    feedback: `从已认可的历史清单 ${prior.id} 补齐独立浏览器登录，供当前计划审阅。需要建号时，等待提交完成并清空账号输入后再继续。原检查与预期结果保留。`,
  };
}
