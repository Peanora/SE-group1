export function renderTaskSchedule({ key, tasks, selected, simulation, preview, planConfirmed, statusNames = {}, escape }) {
  const simulated = new Map((simulation?.tasks ?? []).map(task => [task.id, task.status]));
  const changed = new Set(preview?.changedIds);
  const affected = new Set(preview?.downstreamIds);
  const selectedId = selected?.id ?? tasks[0]?.id;
  const identifiers = ids => ids?.length
    ? `<div class="task-schedule-identifiers">${ids.map(id => `<span>${escape(id)}</span>`).join('')}</div>`
    : '<span class="task-schedule-none">无</span>';

  const rows = tasks.map(task => {
    const picked = task.id === selectedId;
    const status = simulated.get(task.id);
    const [tone, label] = simulation ? [status ? `sim-${status}` : 'unknown', statusNames[status] || '待核对']
      : changed.has(task.id) ? ['changed', '未保存改动']
      : affected.has(task.id) ? ['affected', '下游待核对']
      : planConfirmed ? ['confirmed', '已纳入计划'] : ['pending', '待计划确认'];

    return `<tr role="row" data-current="${picked}">
      <th role="rowheader" scope="row"><button type="button" class="task-schedule-pick" data-task="${escape(task.id)}" data-task-schedule data-focus-key="task-schedule-${escape(task.id)}" aria-pressed="${picked}" tabindex="${picked ? 0 : -1}">
        <span>${escape(task.id)}${task.workflowModule?.group ? ' · ' + escape(task.workflowModule.group) : ''}</span><strong>${escape(task.workflowModule?.name || task.title || task.id)}</strong>
      </button></th>
      <td role="cell"><span class="task-schedule-label" aria-hidden="true">直接前置</span>${identifiers(task.dependsOn)}</td>
      <td role="cell"><span class="task-schedule-label" aria-hidden="true">关联需求</span>${identifiers(task.requirementIds)}</td>
      <td role="cell"><span class="task-schedule-label" aria-hidden="true">状态</span><span class="task-schedule-status" data-state="${escape(tone)}">${escape(label)}</span></td>
    </tr>`;
  }).join('');

  const label = simulation ? '模拟任务清单' : preview ? '计划修订清单' : '开发计划清单';
  return `<div class="task-schedule">
    <div class="task-schedule-head"><h3 id="task-schedule-title">${label}</h3><span>${tasks.length} 项任务</span></div>
    <div class="task-schedule-scroll" data-graph-context="${escape(key)}">
      <table role="table" aria-labelledby="task-schedule-title">
        <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">任务</th><th role="columnheader" scope="col">直接前置</th><th role="columnheader" scope="col">关联需求</th><th role="columnheader" scope="col">状态</th></tr></thead>
        <tbody role="rowgroup">${rows}</tbody>
      </table>
    </div>
  </div>`;
}

export function wireTaskSchedule(host) {
  host.addEventListener('keydown', event => {
    const control = event.target.closest('[data-task-schedule]');
    if (!control || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = Array.from(host.querySelectorAll('[data-task-schedule]'));
    const index = items.indexOf(control);
    let next;
    if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items.at(-1);
    else if (event.key === 'ArrowUp') next = items[Math.max(0, index - 1)];
    else if (event.key === 'ArrowDown') next = items[Math.min(items.length - 1, index + 1)];
    if (!next) return;

    event.preventDefault();
    const id = next.dataset.task;
    next.click();
    const selected = Array.from(host.querySelectorAll('[data-task-schedule]')).find(item => item.dataset.task === id);
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}
