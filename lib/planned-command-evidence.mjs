const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const operations = new Set(['init', 'add', 'commit', 'rev-parse', 'status', 'diff', 'clone', 'merge', 'fetch', 'show', 'cat-file', 'ls-tree', 'rev-list', 'checkout']);
const natural = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(value) ? value : null;

/** Deliberately excludes argv paths, output, environment, process IDs and control handles. */
export function plannedCommandEvidence(record) {
  const result = [];
  function append(item, phase, taskId, tool) {
    if (!item || typeof item !== 'object' || result.length >= 500) return;
    result.push({ id: `command-${result.length + 1}`, taskId: typeof taskId === 'string' && ID.test(taskId) ? taskId : null, phase, tool,
      startedAt: date(item.startedAt), durationMs: natural(item.durationMs), exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
      terminationConfirmed: item.terminationConfirmed === true,
      status: item.terminationConfirmed !== true ? 'unknown' : item.exitCode !== 0 || item.sourceUnchanged === false || ['failed', 'timed_out', 'reconciliation_required'].includes(item.status) ? 'failed' : 'completed' });
  }
  function collect(value, taskId) {
    if (!value || typeof value !== 'object') return;
    for (const item of Array.isArray(value.gitCommands) ? value.gitCommands : []) {
      const op = Array.isArray(item?.args) && operations.has(item.args[0]) ? item.args[0] : null;
      append(item, 'source', taskId, op ? `git ${op}` : 'git');
    }
    for (const version of Array.isArray(value.versions) ? value.versions : []) {
      for (const [phase, check] of [['self', version?.selfCheck], ['test', version?.acceptance?.test], ['browser', version?.acceptance?.browser]]) {
        for (const item of Array.isArray(check?.processes) ? check.processes : []) append(item, phase, taskId, item?.kind === 'browser' ? 'browser' : 'isolated_web_runtime');
      }
    }
  }
  if (record?.profileId === 'planned-task-run-v1') {
    for (const task of Array.isArray(record.tasks) ? record.tasks : []) {
      for (const past of Array.isArray(task?.history) ? task.history : []) collect(past, task?.id);
      collect(task?.record, task?.id);
    }
  } else collect(record, record?.taskId);
  return result;
}
