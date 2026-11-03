// 업무 목록(.office/tasks.json) 읽기·원자적 저장. office.mjs CLI, 대시보드 서버(승인·반려), runner(직원 직접 지시)가 같이 쓴다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { officeDir, renameWithRetry } from './paths.mjs';

// review는 이전 버전의 승인 대기 상태다. 검토 후 전달은 바로 done으로 기록한다.
export const TASK_STATUSES = ['active', 'review', 'done', 'blocked'];

export const tasksFile = (root) => join(officeDir(root), 'tasks.json');

export function loadTasks(root) {
  const file = tasksFile(root);
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`배열 형식이어야 합니다: ${file}`);
  return data;
}

export function saveTasks(root, tasks) {
  const file = tasksFile(root);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(tasks, null, 2) + '\n');
  renameWithRetry(tmp, file);
}

// 한 업무를 고친다. fn(task)가 false를 반환하면 저장하지 않는다. 반환: 고친 업무(없으면 null)
export function updateTask(root, id, fn) {
  const tasks = loadTasks(root);
  const task = tasks.find((t) => t && t.id === id);
  if (!task) return null;
  if (fn(task) === false) return task;
  saveTasks(root, tasks);
  return task;
}

export function addTask(root, task) {
  const tasks = loadTasks(root);
  if (tasks.some((t) => t && t.id === task.id)) throw new Error(`이미 있는 업무입니다: ${task.id}`);
  tasks.push(task);
  saveTasks(root, tasks);
  return task;
}

export function completeTask(root, id) {
  return updateTask(root, id, (task) => {
    if (task.status === 'done') return false;
    task.status = 'done';
    task.completedAt = task.updated = new Date().toISOString();
    delete task.resultSeenAt;
    delete task.historyArchivedAt;
    return true;
  });
}
