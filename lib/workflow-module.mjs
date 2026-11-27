export const WORKFLOW_MODULE_LABELS = Object.freeze({ group: 40, name: 60 });

export function workflowLabel(value, max) {
  if (typeof value !== 'string' || !value.isWellFormed()) return '';
  return Array.from(value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim().normalize('NFC')).slice(0, max).join('');
}

export function workflowCapabilityName(title) {
  if (typeof title !== 'string') return '';
  const capability = title.trim()
    .replace(/^(?:用户|系统|管理员|会员|访客|教师|学生)\s*(?:需要|必须|应当|应该|可以|能够|支持|可|能)\s*/u, '')
    .replace(/^(?:实现|构建|落实)\s*/u, '');
  return workflowLabel(capability, WORKFLOW_MODULE_LABELS.name);
}

export function moduleIdentity({ group, name }) {
  return JSON.stringify([group, name]);
}

/** Give distinct modules with indistinguishable source titles stable names. */
export function addWorkflowModule(used, group, preferredName, separator) {
  let name = preferredName, duplicate = 1;
  const key = workflowLabel(separator, 16);
  while (used.has(moduleIdentity({ group, name }))) {
    const suffix = duplicate === 1 ? `（${key}）` : `（${key}-${duplicate}）`;
    name = workflowLabel(preferredName, WORKFLOW_MODULE_LABELS.name - Array.from(suffix).length) + suffix;
    duplicate++;
  }
  const module = { group, name };
  used.add(moduleIdentity(module));
  return module;
}

export function normalizeWorkflowModule(value) {
  const error = () => new Error('工作流模块必须包含简明的功能板块与模块名称。');
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = Object.entries(WORKFLOW_MODULE_LABELS);
  if (Reflect.ownKeys(value).length !== fields.length) throw error();
  return Object.fromEntries(fields.map(([key, max]) => {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw error();
    const text = descriptor.value;
    if (typeof text !== 'string' || !text.isWellFormed() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)
      || !text.trim() || Array.from(text).length > max) throw error();
    return [key, text.trim().normalize('NFC')];
  }));
}

/** Use the same trusted task projection for manifest hashing and delivery. */
export function executionWorkflowTask(task) {
  return {
    id: task.id, title: task.title, description: task.description, requirementIds: task.requirementIds,
    dependsOn: task.dependsOn, inputs: task.inputs, outputs: task.outputs, acceptance: task.acceptance,
    writePaths: task.writePaths ?? task.suggestedFiles,
    ...(task.workflowModule ? { workflowModule: task.workflowModule } : {}),
  };
}
