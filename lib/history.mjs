// 실행 중·결정 대기인 대화와 감시의 연결 관계를 보존하며 종료 내역만 고른다.
export function historySelection(runs, tasks, desiredMonitors = new Set()) {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  const rootOf = (run) => run.rootId || run.id;
  const protectedRoots = new Set(desiredMonitors);
  for (const run of runs) {
    if (['running', 'queued'].includes(run.status) || run.needsReply && status.get(run.task) !== 'done'
      || run.task && status.has(run.task) && status.get(run.task) !== 'done') protectedRoots.add(rootOf(run));
  }
  let previous;
  do {
    previous = protectedRoots.size;
    for (const run of runs) if (run.monitorId && (protectedRoots.has(run.monitorId) || protectedRoots.has(rootOf(run)))) {
      protectedRoots.add(run.monitorId); protectedRoots.add(rootOf(run));
    }
  } while (previous !== protectedRoots.size);
  const removed = runs.filter((run) => !protectedRoots.has(rootOf(run)) && !['running', 'queued'].includes(run.status)
    && /^[A-Za-z0-9_-]{1,100}$/.test(run.id));
  const removeIds = new Set(removed.map((run) => run.id));
  const kept = runs.filter((run) => !removeIds.has(run.id));
  const keptTasks = new Set(kept.map((run) => run.task));
  return { removed, kept, taskIds: tasks.filter((task) => task.status === 'done' && !task.historyArchivedAt && !keptTasks.has(task.id)).map((task) => task.id) };
}
