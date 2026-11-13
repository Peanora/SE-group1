import { createHash } from 'node:crypto';
import { HttpError } from './documents.mjs';
import { validateTaskGraph } from './planner.mjs';

export const MAX_PLANNING_VERSIONS = 20;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function contentRevision(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const invalid = message => { throw new HttpError(400, message); };
const text = (value, label, allowEmpty = false) => {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) invalid(`${label}必须是${allowEmpty ? '' : '非空'}文本。`);
  return value.trim();
};
const strings = (value, label, nonempty = false) => {
  if (!Array.isArray(value) || (nonempty && !value.length)) invalid(`${label}必须是${nonempty ? '非空' : ''}文本数组。`);
  return value.map(item => text(item, label));
};

export function validatePlanningSpec(raw, sourceText) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('设计规格必须是对象。');
  const spec = structuredClone(raw);
  spec.title = text(spec.title, '规格标题');
  spec.summary = text(spec.summary, '规格摘要', true);
  for (const key of ['goals', 'roles', 'acceptanceScenarios', 'constraints', 'assumptions', 'questions']) spec[key] = strings(spec[key], `规格 ${key}`);
  if (!Array.isArray(spec.requirements) || !spec.requirements.length || spec.requirements.length > 80) invalid('规格必须包含 1 至 80 条需求。');
  const ids = new Set();
  spec.requirements = spec.requirements.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('需求格式不正确。');
    const requirement = { ...item };
    for (const key of ['id', 'title', 'description']) requirement[key] = text(requirement[key], `需求 ${key}`);
    if (ids.has(requirement.id)) invalid(`需求 ID 重复：${requirement.id}`);
    ids.add(requirement.id);
    requirement.acceptance = strings(requirement.acceptance, `需求 ${requirement.id} 验收条件`, true);
    if (typeof requirement.sourceQuote !== 'string' || !requirement.sourceQuote.trim() || !sourceText.includes(requirement.sourceQuote)) invalid(`需求 ${requirement.id} 的原文引用必须逐字存在于本次运行的需求快照中。`);
    return requirement;
  });
  if (!spec.stack || typeof spec.stack !== 'object' || Array.isArray(spec.stack)) invalid('规格缺少完整技术边界。');
  for (const key of ['frontend', 'backend', 'storage']) spec.stack[key] = text(spec.stack[key], `技术边界 ${key}`);
  return spec;
}

export function preparePlanningSpec(raw, sourceText, previousQuestions = [], answers = {}) {
  const spec = validatePlanningSpec(raw, sourceText);
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) invalid('问题答复必须是问题编号到文本的对象。');
  if (new Set(spec.questions).size !== spec.questions.length) invalid('待确认问题不能重复。');
  for (const previous of previousQuestions) {
    if (previous.blocking && !String(previous.answer || '').trim() && !spec.questions.includes(previous.question)) {
      invalid('不能删除或替换尚未答复的阻塞问题，请先答复并保存处理依据。');
    }
  }
  let nextId = Math.max(0, ...previousQuestions.map(item => Number(item.id.replace(/^Q-/, '')) || 0));
  const questions = spec.questions.map(question => {
    const previous = previousQuestions.find(item => item.question === question);
    return { id: previous?.id ?? `Q-${String(++nextId).padStart(3, '0')}`, question, answer: previous?.answer ?? '', blocking: true };
  });
  for (const [id, answer] of Object.entries(answers)) {
    const question = questions.find(item => item.id === id);
    if (!question) invalid(`未知问题编号：${id}`);
    question.answer = text(answer, `问题 ${id} 答复`, true);
    if (question.answer.length > 5000) invalid('每条问题答复不能超过 5000 字符。');
  }
  // Client-supplied clarifications never grant approval or override persisted answers.
  spec.clarifications = structuredClone(questions);
  return { spec, specQuestions: questions, specRevision: contentRevision(spec) };
}

export function validatePlanningTasks(spec, raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 1000) invalid('计划必须包含 1 至 1000 项任务。');
  const tasks = structuredClone(raw);
  const known = new Set(spec.requirements.map(item => item.id));
  const covered = new Set();
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) invalid('任务格式不正确。');
    for (const key of ['id', 'title', 'description']) task[key] = text(task[key], `任务 ${key}`);
    task.dependsOn = strings(task.dependsOn, `任务 ${task.id} 依赖`);
    task.requirementIds = strings(task.requirementIds, `任务 ${task.id} 需求映射`);
    task.acceptance = strings(task.acceptance, `任务 ${task.id} 验收条件`, true);
    task.suggestedFiles = strings(task.suggestedFiles, `任务 ${task.id} 建议文件`);
    for (const id of task.requirementIds) {
      if (!known.has(id)) invalid(`任务 ${task.id} 引用了未知需求 ${id}。`);
      covered.add(id);
    }
  }
  try { validateTaskGraph(tasks); } catch (error) { invalid(error.message); }
  for (const id of known) if (!covered.has(id)) invalid(`需求 ${id} 未关联开发任务。`);
  return tasks;
}

export function planningRevision(run, tasks = run.tasks) {
  const architecture = run.artifacts.find(item => item.name === 'architecture.md')?.content;
  if (typeof architecture !== 'string' || !architecture.trim()) throw new HttpError(409, '架构产物尚未就绪。');
  return contentRevision({ specRevision: run.specRevision, architecture, tasks });
}

export function planningFeedback(value, required = false) {
  if (value === undefined && !required) return '';
  const result = text(value, '审阅意见', !required);
  if (result.length > 5000) invalid('审阅意见不能超过 5000 字符。');
  return result;
}

export function assertCurrentRevision(actual, expected) {
  if (typeof expected !== 'string' || !actual || expected !== actual) throw new HttpError(409, '版本已变化，请刷新并核对当前版本后重新操作。');
}

export function assertSpecApproval(run) {
  assertCurrentRevision(contentRevision(run.spec), run.specRevision);
  if (!run.approvals?.spec || run.approvals.spec.revision !== run.specRevision) throw new HttpError(409, '当前规格尚未确认，不能推进计划。');
  if ((run.specQuestions ?? []).some(item => item.blocking && !item.answer.trim())) throw new HttpError(409, '仍有阻塞问题未答复，请先修订规格。');
}
