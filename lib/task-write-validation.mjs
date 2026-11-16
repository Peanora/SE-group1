import { validateProjectFiles } from './project-files.mjs';
const need = (value, message) => { if (!value) throw new Error(message); };

/** Shared admission rule for planned tasks: exact paths and ordered shared writers. */
export function validateTaskWriteConflicts(items) {
  const tasks = new Map(items.map(task => [task.id, task])), writers = new Map(), files = new Map();
  for (const task of items) {
    const paths = task.writePaths ?? task.suggestedFiles ?? [];
    need(Array.isArray(paths), '任务文件范围必须为数组。');
    const normalized = validateProjectFiles(paths.map(path => ({ path, content: '' })));
    for (const { path } of normalized) {
      const folded = path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
      need(!files.has(folded) || files.get(folded) === path, '全图可写文件不能大小写混淆。'); files.set(folded, path);
      if (!writers.has(path)) writers.set(path, []); writers.get(path).push(task.id);
    }
  }
  validateProjectFiles([...files.values()].map(path => ({ path, content: '' })));
  const visiting = new Set(), ancestors = new Map();
  function visit(id) {
    if (ancestors.has(id)) return ancestors.get(id); need(!visiting.has(id), '开发任务依赖存在循环。'); need(tasks.has(id), '开发任务引用未知依赖。'); visiting.add(id);
    const result = new Set(); for (const dependency of tasks.get(id).dependsOn) { result.add(dependency); for (const ancestor of visit(dependency)) result.add(ancestor); }
    visiting.delete(id); ancestors.set(id, result); return result;
  }
  for (const id of tasks.keys()) visit(id);
  for (const ids of writers.values()) for (let first = 0; first < ids.length; first++) for (let second = first + 1; second < ids.length; second++) need(ancestors.get(ids[first]).has(ids[second]) || ancestors.get(ids[second]).has(ids[first]), '共享文件的任务必须处于明确串行依赖链，不能并行多写。');
}
