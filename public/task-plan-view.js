const EDITABLE_FIELDS = [
  ['title', '任务标题'],
  ['description', '任务描述'],
  ['acceptance', '验收条件'],
  ['dependsOn', '前置任务'],
  ['requirementIds', '需求来源'],
];
const identifier = value => typeof value === 'string' ? value.trim() : '';
const taskArray = value => Array.isArray(value) ? value : [];

function taskIndex(tasks) {
  const result = new Map();
  for (const task of taskArray(tasks)) {
    const id = identifier(task?.id);
    if (id && !result.has(id)) result.set(id, task);
  }
  return result;
}

function comparable(value, unordered) {
  if (Array.isArray(value)) {
    const normalized = value.map(item => typeof item === 'string' ? item.trim() : item);
    return JSON.stringify(unordered ? normalized.sort() : normalized);
  }
  return typeof value === 'string' ? value.trim() : value;
}

// Edges point from a prerequisite to the tasks waiting for it. Multiple
// versions can contribute edges so a removed dependency is still considered.
function dependants(...versions) {
  const result = new Map();
  for (const tasks of versions) {
    for (const task of taskArray(tasks)) {
      const id = identifier(task?.id);
      if (!id) continue;
      if (!result.has(id)) result.set(id, new Set());
      for (const dependency of taskArray(task.dependsOn)) {
        const prerequisite = identifier(dependency);
        if (!prerequisite) continue;
        if (!result.has(prerequisite)) result.set(prerequisite, new Set());
        result.get(prerequisite).add(id);
      }
    }
  }
  return result;
}

function descendants(graph, startingIds) {
  const visited = new Set(startingIds);
  const queue = [...visited];
  for (let index = 0; index < queue.length; index++) {
    for (const id of graph.get(queue[index]) || []) {
      if (visited.has(id)) continue;
      visited.add(id);
      queue.push(id);
    }
  }
  return visited;
}

function taskErrors(tasks) {
  if (!Array.isArray(tasks)) return ['任务计划必须是任务数组。'];
  const errors = new Set();
  if (!tasks.length) errors.add('计划至少需要一项任务。');
  if (tasks.length > 1000) errors.add('计划最多支持1000项任务，请减少任务数量。');
  const known = taskIndex(tasks);
  const seen = new Set();
  const graph = new Map([...known.keys()].map(id => [id, new Set()]));
  const incoming = new Map([...known.keys()].map(id => [id, 0]));
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    const id = identifier(task?.id);
    const label = id ? `任务 ${id}` : `第${index + 1}项任务`;
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      errors.add(`${label}格式不正确，请载入当前计划后重试。`);
      continue;
    }
    if (!id) errors.add(`${label}缺少任务编号。`);
    if (id && seen.has(id)) errors.add(`任务编号 ${id} 重复，请为任务使用不同编号。`);
    seen.add(id);
    if (typeof task.title !== 'string' || !task.title.trim()) errors.add(`${label}需要填写标题。`);
    if (typeof task.description !== 'string' || !task.description.trim()) errors.add(`${label}需要填写描述。`);
    if (!Array.isArray(task.acceptance) || !task.acceptance.length || task.acceptance.some(value => typeof value !== 'string' || !value.trim())) errors.add(`${label}需要至少一条非空验收条件。`);
    if (!Array.isArray(task.dependsOn)) {
      errors.add(`${label}的前置任务必须是任务编号数组。`);
      continue;
    }
    const dependencies = new Set();
    for (const value of task.dependsOn) {
      const dependency = identifier(value);
      if (dependencies.has(dependency)) errors.add(`${label}重复选择了前置任务 ${dependency || '（空编号）'}。`);
      dependencies.add(dependency);
      if (!dependency || !known.has(dependency)) {
        errors.add(`${label}引用了不存在的前置任务 ${dependency || '（空编号）'}。`);
        continue;
      }
      if (dependency === id) {
        errors.add(`${label}不能将自身设为前置任务。`);
        continue;
      }
      if (id && !graph.get(dependency).has(id)) {
        graph.get(dependency).add(id);
        incoming.set(id, incoming.get(id) + 1);
      }
    }
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < ready.length; index++) {
    for (const id of graph.get(ready[index])) {
      incoming.set(id, incoming.get(id) - 1);
      if (incoming.get(id) === 0) ready.push(id);
    }
  }
  if (ready.length < known.size) errors.add('任务之间存在循环依赖，请调整前置任务后再保存。');
  return [...errors];
}

/** Compare a browser draft with its saved plan; this does not grant approval. */
export function summarizeTaskChanges(savedTasks, draftTasks, { includeWritePaths = false } = {}) {
  const saved = taskIndex(savedTasks), draft = taskIndex(draftTasks);
  const orderedIds = [...new Set([...draft.keys(), ...saved.keys()])];
  const editable = includeWritePaths ? [...EDITABLE_FIELDS, ['writePaths', '可写文件']] : EDITABLE_FIELDS;
  const changed = [];
  for (const id of orderedIds) {
    const before = saved.get(id), after = draft.get(id);
    const fields = editable.flatMap(([key, label]) => {
      const unordered = ['dependsOn', 'requirementIds', 'writePaths'].includes(key);
      if (comparable(before?.[key], unordered) === comparable(after?.[key], unordered)) return [];
      return [{ key, label, before: before?.[key], after: after?.[key] }];
    });
    if (fields.length) changed.push({ id, title: after?.title || before?.title || id, fields });
  }
  const direct = new Set(changed.map(task => task.id));
  const affected = descendants(dependants(savedTasks, draftTasks), direct);
  return {
    changed,
    downstreamIds: orderedIds.filter(id => affected.has(id) && !direct.has(id)),
    errors: taskErrors(draftTasks),
  };
}

/** A task cannot depend on itself or any task already waiting for it. */
export function unavailableDependencies(tasks, taskId) {
  return descendants(dependants(tasks), identifier(taskId) ? [identifier(taskId)] : []);
}
