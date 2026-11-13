import { HttpError } from './documents.mjs';
import { validateEngineeringPlan } from './engineering-plan.mjs';

const TASK_FIELDS = ['id', 'title', 'description', 'requirementIds', 'dependsOn', 'writePaths', 'inputs', 'outputs', 'acceptance'];
const DEV_FIELDS = new Set([...TASK_FIELDS, 'category', 'suggestedFiles']);
const CATEGORY = '工程开发';

// The complete persisted draft is compared as data, including fields outside
// proposal. Inspect descriptors before copying so tampering cannot run getters.
function dataSnapshot(value) {
  let nodes = 0;
  const ancestors = new Set();
  function copy(item, depth) {
    if (++nodes > 40000 || depth > 20) throw new Error('工程计划结构超限。');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && item.isWellFormed() && Buffer.byteLength(item) <= 512 * 1024) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error('工程计划不是纯数据。');
    const isArray = Array.isArray(item);
    if (!(isArray ? Object.getPrototypeOf(item) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(item)))) throw new Error('工程计划不是纯对象。');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length || Object.values(descriptors).some(entry => !Object.hasOwn(entry, 'value'))) throw new Error('工程计划不能包含访问器。');
    ancestors.add(item);
    let result;
    if (isArray) {
      if (item.length > 2000 || Object.keys(item).length !== item.length || Object.keys(descriptors).some(key => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length))) throw new Error('工程计划数组无效。');
      result = Array.from({ length: item.length }, (_, index) => copy(descriptors[index].value, depth + 1));
    } else {
      if (Object.keys(descriptors).some(key => ['__proto__', 'prototype', 'constructor'].includes(key) || !key.isWellFormed() || Buffer.byteLength(key) > 512 * 1024 || !descriptors[key].enumerable)) throw new Error('工程计划字段无效。');
      result = Object.fromEntries(Object.keys(descriptors).sort().map(key => [key, copy(descriptors[key].value, depth + 1)]));
    }
    ancestors.delete(item);
    return result;
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new Error('工程计划总字节超限。');
  return result;
}

const canonical = value => JSON.stringify(dataSnapshot(value));
const text = value => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/\\/gu, '\\\\').replace(/([`*_[\]{}()#+.!|~-])/gu, '\\$1').replace(/\r\n|\r|\n/gu, '<br>');
const list = values => values.length ? values.map(value => `- ${text(value)}`).join('\n') : '- 无';
const joined = values => values.length ? values.map(text).join('、') : '无';

/** Project an already validated draft without trimming or changing its data. */
export function engineeringTasks(plan) {
  return plan.proposal.tasks.map(task => ({ ...structuredClone(task), category: CATEGORY, suggestedFiles: [...task.writePaths] }));
}

/** Render engineering data only; no commands, approvals or completion claims. */
export function renderEngineeringArchitecture(plan) {
  const { proposal, roleDefinitions, platform } = plan;
  const entities = proposal.entities.map(entity => {
    const fields = entity.fields.map(field => `- ${text(field.name)}：${text(field.type)}；必填 ${field.required ? '是' : '否'}；唯一 ${field.unique === true ? '是' : '否'}${field.references ? `；引用 ${text(field.references.entityId)}.${text(field.references.field)}` : ''}`).join('\n');
    return `### ${text(entity.id)} ${text(entity.name)}\n\n${fields}\n\n约束：\n\n${list(entity.constraints)}`;
  });
  const routes = proposal.routes.map(route => `### ${text(route.id)} ${text(route.method)} ${text(route.path)}\n\n角色：${joined(route.roles)}${route.roles.length ? '' : '（公开接口）'}\n\n需求：${joined(route.requirementIds)}\n\n请求：${text(route.request)}\n\n响应：${text(route.response)}\n\n错误：\n\n${list(route.errors.map(item => `${item.status}：${item.reason}`))}`);
  const views = proposal.views.map(view => `### ${text(view.id)} ${text(view.title)}\n\n路径：${text(view.path)}\n\n需求：${joined(view.requirementIds)}\n\n可访问选择器：\n\n${list(view.selectors.map(selector => `${selector.testId}（${selector.role}）`))}`);
  return [
    `# ${text(proposal.title)} 工程架构草案`,
    '本草案来自当前已确认规格。检查范围为 structural_only，需求映射与依赖结构有效不代表业务语义充分；仍须人工确认计划。下述任务和代码均为待开发，不代表已执行或验收。',
    text(proposal.summary),
    `## 固定运行边界\n\n- 后端：${text(platform.backend)}\n- 存储：${text(platform.storage)}\n- 应用入口：${text(platform.appModule)}，导出 ${text(platform.appExport)}，工厂输入 ${text(platform.factoryInput)}\n- 前端：${text(platform.frontend)}；目录 ${text(platform.publicRoot)}\n- 资源：${text(platform.assets)}\n- 标准输出：${text(platform.stdout)}\n- 网络：${platform.network ? '允许' : '禁止'}；Shell：${platform.shell ? '允许' : '禁止'}；安装依赖：${platform.installDependencies ? '允许' : '禁止'}`,
    `## 原规格角色\n\n${list(roleDefinitions.map(role => `${role.id}：${role.text}`))}`,
    `## 数据实体\n\n${entities.length ? entities.join('\n\n') : '无持久实体。'}`,
    `## 业务接口\n\n${routes.length ? routes.join('\n\n') : '无业务接口。'}`,
    `## 页面与交互\n\n${views.join('\n\n')}`,
    `## 内容绑定\n\n- 规格版本：${text(plan.specHash)}\n- 工程草案：${text(plan.hash)}\n- 校验策略：${text(plan.policyHash)}\n- 覆盖性质：structural_only`,
  ].join('\n\n');
}

export function renderEngineeringTasks(planner, spec, tasks) {
  const boundaries = tasks.map(task => `### ${text(task.id)} ${text(task.title)}\n\n可写精确文件：\n\n${list(task.writePaths)}\n\n输入：\n\n${list(task.inputs)}\n\n输出：\n\n${list(task.outputs)}`).join('\n\n');
  return `${planner.renderTasks(spec, tasks)}\n\n## 工程任务输入、输出与可写范围\n\n以下为待开发计划，structural_only 不表示代码已执行或业务验收通过。\n\n${boundaries}`;
}

/** A stored draft must match both its current context and its DevTask view. */
export function assertEngineeringAlignment(run) {
  try {
    const stored = dataSnapshot(run.engineeringPlan);
    const validated = validateEngineeringPlan({ proposal: stored.proposal, spec: run.spec,
      binding: { projectId: run.projectId, runId: run.id, specRevision: run.specRevision } });
    if (canonical(stored) !== canonical(validated)) throw new Error('工程草案内容与校验结果不一致。');
    if (!Array.isArray(run.tasks) || run.tasks.length && canonical(run.tasks) !== canonical(engineeringTasks(validated))) throw new Error('开发任务与工程草案不一致。');
    return validated;
  } catch {
    throw new HttpError(409, '工程草案或任务与当前规格版本不一致，请重新生成或修订计划。');
  }
}

/** Keep APIs and the complete allowed file domain fixed during task editing. */
export function reviseEngineeringTasks(run, tasks) {
  const current = assertEngineeringAlignment(run);
  try {
    const copied = dataSnapshot(tasks);
    if (!Array.isArray(copied) || !copied.length) throw new Error('工程任务不能为空。');
    for (const task of copied) {
      if (!task || Array.isArray(task) || Object.keys(task).some(key => !DEV_FIELDS.has(key)) || [...DEV_FIELDS].some(key => !Object.hasOwn(task, key)) || task.category !== CATEGORY) throw new Error('工程任务字段或类别无效。');
      if (!Array.isArray(task.suggestedFiles) || !Array.isArray(task.writePaths) || task.suggestedFiles.some(value => typeof value !== 'string') || task.writePaths.some(value => typeof value !== 'string') || canonical([...task.suggestedFiles].sort()) !== canonical([...task.writePaths].sort())) throw new Error('建议文件必须与工程可写范围一致。');
    }
    const proposal = { ...current.proposal, tasks: copied.map(task => Object.fromEntries(TASK_FIELDS.map(key => [key, task[key]]))) };
    const engineeringPlan = validateEngineeringPlan({ proposal, spec: run.spec, binding: current.binding });
    const domain = plan => [...new Set(plan.proposal.tasks.flatMap(task => task.writePaths))].sort();
    if (canonical(domain(current)) !== canonical(domain(engineeringPlan))) throw new Error('工程任务修订不能增删原可写文件范围。');
    return { engineeringPlan, tasks: engineeringTasks(engineeringPlan) };
  } catch {
    throw new HttpError(400, '工程任务修订无效；请保留原可写文件集合、接口边界及有效任务依赖。');
  }
}
