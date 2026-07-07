import * as fs from 'fs';
import * as path from 'path';
import { TaskState } from './types';

const STATE_DIRS: TaskState[] = ['defined', 'pending', 'processing', 'testing', 'review', 'done'];

export type Actor = 'executor' | 'tester' | 'user';

export const VALID_TRANSITIONS: Record<TaskState, { to: TaskState; actor: Actor }[]> = {
  defined:    [{ to: 'pending', actor: 'user' }],
  pending:    [{ to: 'processing', actor: 'executor' }, { to: 'processing', actor: 'user' },
               { to: 'testing', actor: 'user' }, { to: 'review', actor: 'user' }, { to: 'done', actor: 'user' }],
  processing: [{ to: 'testing', actor: 'executor' }, { to: 'pending', actor: 'executor' }],
  testing:    [{ to: 'review', actor: 'tester' }, { to: 'processing', actor: 'tester' }],
  review:     [{ to: 'done', actor: 'user' }, { to: 'pending', actor: 'user' }],
  done:       [],
};

export function validateTransition(from: TaskState, to: TaskState, actor: Actor): boolean {
  const allowed = VALID_TRANSITIONS[from] || [];
  return allowed.some(t => t.to === to && t.actor === actor);
}

export function getStateDir(taskDir: string, state: TaskState): string {
  return path.join(taskDir, state);
}

export function ensureStateDirs(taskDir: string): void {
  for (const dir of STATE_DIRS) {
    const dirPath = path.join(taskDir, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
  const locksDir = path.join(taskDir, 'locks');
  if (!fs.existsSync(locksDir)) {
    fs.mkdirSync(locksDir, { recursive: true });
  }
  const runsDir = path.join(taskDir, 'runs');
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }
  const sessionsDir = path.join(runsDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
  const tasksLogDir = path.join(runsDir, 'tasks');
  if (!fs.existsSync(tasksLogDir)) {
    fs.mkdirSync(tasksLogDir, { recursive: true });
  }
}

export function getTaskState(taskDir: string, taskId: string): TaskState | null {
  for (const state of STATE_DIRS) {
    const dirPath = getStateDir(taskDir, state);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath);
    const match = files.find(f => f === `${taskId}.yaml`);
    if (match) return state;
  }
  return null;
}

export function getTaskFilePath(taskDir: string, taskId: string): string | null {
  for (const state of STATE_DIRS) {
    const dirPath = getStateDir(taskDir, state);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath);
    const match = files.find(f => f === `${taskId}.yaml`);
    if (match) return path.join(dirPath, match);
  }
  return null;
}

export function moveTask(taskDir: string, taskId: string, toState: TaskState): boolean {
  const currentPath = getTaskFilePath(taskDir, taskId);
  if (!currentPath) return false;
  const filename = path.basename(currentPath);
  const destPath = path.join(getStateDir(taskDir, toState), filename);
  try {
    fs.renameSync(currentPath, destPath);
    return true;
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(currentPath, destPath);
      fs.unlinkSync(currentPath);
      return true;
    }
    return false;
  }
}

export function listTasks(taskDir: string, state?: TaskState): { id: string; state: TaskState; filename: string }[] {
  const result: { id: string; state: TaskState; filename: string }[] = [];
  const dirs = state ? [state] : STATE_DIRS;
  for (const s of dirs) {
    const dirPath = getStateDir(taskDir, s);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.yaml'));
    for (const f of files) {
      const id = f.replace(/\.yaml$/, '');
      result.push({ id, state: s, filename: f });
    }
  }
  return result;
}

export function getNextSeq(taskDir: string, datePrefix: string): number {
  const definedDir = getStateDir(taskDir, 'defined');
  if (!fs.existsSync(definedDir)) return 1;
  const files = fs.readdirSync(definedDir).filter(f => f.startsWith(datePrefix));
  if (files.length === 0) return 1;
  const seqs = files.map(f => {
    const match = f.match(/_(\d+)\.yaml$/);
    return match ? parseInt(match[1], 10) : 0;
  });
  return Math.max(...seqs) + 1;
}