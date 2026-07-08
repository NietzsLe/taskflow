import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskState, LockFile } from './types';
import { validateLockFile } from './validate';

export const STATE_DIRS: TaskState[] = ['defined', 'pending', 'processing', 'testing', 'review', 'done', 'blocked'];

export type Actor = 'executor' | 'tester' | 'user';

export class TaskLockedError extends Error {
  constructor(public taskId: string) {
    super(`Task '${taskId}' is locked. Use --force to override.`);
    this.name = 'TaskLockedError';
  }
}

/**
 * Check if a lock file is held by a specific session.
 * Returns the parsed LockFile if the session matches, null otherwise.
 */
export function isLockHeldBySession(lockPath: string, sessionId: string): LockFile | null {
  if (!fs.existsSync(lockPath)) return null;
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const lock = validateLockFile(parseYaml(raw));
    if (!lock) return null;
    if (lock.sessionId === sessionId) return lock;
    return null;
  } catch {
    return null;
  }
}

export const VALID_TRANSITIONS: Record<TaskState, { to: TaskState; actor: Actor }[]> = {
  defined:    [{ to: 'pending', actor: 'user' }],
  pending:    [{ to: 'processing', actor: 'executor' }, { to: 'processing', actor: 'user' },
               { to: 'testing', actor: 'user' }, { to: 'review', actor: 'user' }, { to: 'done', actor: 'user' }],
  processing: [{ to: 'testing', actor: 'executor' }, { to: 'pending', actor: 'executor' }, { to: 'blocked', actor: 'executor' }],
  testing:    [{ to: 'review', actor: 'tester' }, { to: 'pending', actor: 'tester' }, { to: 'processing', actor: 'tester' }, { to: 'blocked', actor: 'tester' }],
  blocked:    [{ to: 'processing', actor: 'user' }, { to: 'testing', actor: 'user' }, { to: 'pending', actor: 'user' }],
  review:     [{ to: 'done', actor: 'user' }, { to: 'pending', actor: 'user' }],
  done:       [],
};

export function validateTransition(from: TaskState, to: TaskState, actor: Actor): boolean {
  const allowed = VALID_TRANSITIONS[from] || [];
  return allowed.some(t => t.to === to && t.actor === actor);
}

export function getValidTransitions(from: TaskState, actor: Actor): TaskState[] {
  const allowed = VALID_TRANSITIONS[from] || [];
  return allowed.filter(t => t.actor === actor).map(t => t.to);
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

export function moveTask(
  taskDir: string,
  taskId: string,
  toState: TaskState,
  options?: { force?: boolean; sessionId?: string; updateTimestamp?: boolean }
): boolean {
  const currentPath = getTaskFilePath(taskDir, taskId);
  if (!currentPath) return false;
  // A2: check lock unless --force or sessionId matches lock holder
  if (!options?.force) {
    const lockPath = path.join(taskDir, 'locks', `task-${taskId}.lock`);
    if (fs.existsSync(lockPath)) {
      // If sessionId is provided and matches the lock holder, allow the move
      if (options?.sessionId) {
        if (!isLockHeldBySession(lockPath, options.sessionId)) {
          throw new TaskLockedError(taskId);
        }
        // Lock is held by this session — allow move
      } else {
        throw new TaskLockedError(taskId);
      }
    }
  }
  const filename = path.basename(currentPath);
  const destPath = path.join(getStateDir(taskDir, toState), filename);

  // If updateTimestamp is requested, update the YAML's updatedAt before moving
  if (options?.updateTimestamp) {
    try {
      const raw = fs.readFileSync(currentPath, 'utf-8');
      const task = parseYaml(raw) as any;
      if (task && typeof task === 'object') {
        task.updatedAt = new Date().toISOString();
        fs.writeFileSync(currentPath, stringifyYaml(task), 'utf-8');
      }
    } catch {
      // If we can't update the timestamp, proceed with the move anyway
    }
  }

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
  // Sort by id for stable output (A6)
  result.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return result;
}

export function getNextSeq(taskDir: string, datePrefix: string): number {
  // Scan all state dirs to ensure unique seq across the whole framework (A5).
  let maxSeq = 0;
  for (const s of STATE_DIRS) {
    const dirPath = getStateDir(taskDir, s);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath).filter(f => f.startsWith(datePrefix));
    for (const f of files) {
      const match = f.match(/_(\d+)\.yaml$/);
      if (match) {
        const seq = parseInt(match[1], 10);
        if (seq > maxSeq) maxSeq = seq;
      }
    }
  }
  return maxSeq + 1;
}