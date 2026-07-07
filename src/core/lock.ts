import * as fs from 'fs';
import * as path from 'path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { LockFile, generateSessionId } from './types';

export function getLocksDir(taskDir: string): string {
  return path.join(taskDir, 'locks');
}

export function getTaskLockPath(taskDir: string, taskId: string): string {
  return path.join(getLocksDir(taskDir), `task-${taskId}.lock`);
}

export function getInfraLockPath(taskDir: string): string {
  return path.join(getLocksDir(taskDir), 'infra.lock');
}

export function acquireTaskLock(
  taskDir: string,
  taskId: string,
  taskVersion: number,
  agentType: 'executor' | 'tester'
): LockFile | null {
  const lockPath = getTaskLockPath(taskDir, taskId);
  const now = new Date().toISOString();
  const lock: LockFile = {
    sessionId: generateSessionId(),
    agentType,
    taskVersion,
    acquiredAt: now,
    heartbeatAt: now,
  };
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, stringifyYaml(lock), 0, 'utf-8');
    fs.closeSync(fd);
    return lock;
  } catch (err: any) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
}

export function acquireInfraLock(taskDir: string): LockFile | null {
  const lockPath = getInfraLockPath(taskDir);
  const now = new Date().toISOString();
  const lock: LockFile = {
    sessionId: generateSessionId(),
    acquiredAt: now,
    heartbeatAt: now,
  };
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, stringifyYaml(lock), 0, 'utf-8');
    fs.closeSync(fd);
    return lock;
  } catch (err: any) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
}

export function heartbeatLock(lockPath: string): void {
  if (!fs.existsSync(lockPath)) return;
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const lock = parseYaml(raw) as LockFile;
    lock.heartbeatAt = new Date().toISOString();
    fs.writeFileSync(lockPath, stringifyYaml(lock), 'utf-8');
  } catch {
    // If file was deleted concurrently, ignore
  }
}

export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // If already deleted, ignore
  }
}

export function isLockStale(lockPath: string, staleThresholdSeconds: number): boolean {
  if (!fs.existsSync(lockPath)) return false;
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const lock = parseYaml(raw) as LockFile;
    const elapsed = (Date.now() - new Date(lock.heartbeatAt).getTime()) / 1000;
    return elapsed > staleThresholdSeconds;
  } catch {
    return true;
  }
}

export function readLock(lockPath: string): LockFile | null {
  if (!fs.existsSync(lockPath)) return null;
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    return parseYaml(raw) as LockFile;
  } catch {
    return null;
  }
}

export function isTaskLocked(taskDir: string, taskId: string): boolean {
  return fs.existsSync(getTaskLockPath(taskDir, taskId));
}

export function isInfraLocked(taskDir: string): boolean {
  return fs.existsSync(getInfraLockPath(taskDir));
}

export function getStaleLocks(taskDir: string, staleThresholdSeconds: number): string[] {
  const locksDir = getLocksDir(taskDir);
  if (!fs.existsSync(locksDir)) return [];
  const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.lock'));
  const stale: string[] = [];
  for (const f of files) {
    const lockPath = path.join(locksDir, f);
    if (isLockStale(lockPath, staleThresholdSeconds)) {
      stale.push(lockPath);
    }
  }
  return stale;
}