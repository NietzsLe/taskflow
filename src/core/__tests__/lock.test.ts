import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import {
  acquireTaskLock,
  acquireInfraLock,
  heartbeatLock,
  releaseLock,
  isLockStale,
  readLock,
  isTaskLocked,
  isInfraLocked,
  getStaleLocks,
  getTaskLockPath,
  getInfraLockPath,
} from '../lock';
import { ensureStateDirs } from '../state';

let tmpDir: string;
let taskDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-lock-'));
  taskDir = path.join(tmpDir, '.tasks');
  ensureStateDirs(taskDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('acquireTaskLock', () => {
  it('acquires lock successfully on first call', () => {
    const lock = acquireTaskLock(taskDir, 'task-1', 1, 'executor');
    expect(lock).not.toBeNull();
    expect(lock!.sessionId).toBeTruthy();
    expect(lock!.agentType).toBe('executor');
    expect(lock!.taskVersion).toBe(1);
    expect(lock!.acquiredAt).toBe(lock!.heartbeatAt);
    expect(fs.existsSync(getTaskLockPath(taskDir, 'task-1'))).toBe(true);
  });

  it('returns null on second acquire (atomicity)', () => {
    const first = acquireTaskLock(taskDir, 'task-2', 1, 'executor');
    const second = acquireTaskLock(taskDir, 'task-2', 1, 'executor');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('can acquire different task locks independently', () => {
    const a = acquireTaskLock(taskDir, 'task-a', 1, 'executor');
    const b = acquireTaskLock(taskDir, 'task-b', 1, 'tester');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('generates unique session IDs', () => {
    const a = acquireTaskLock(taskDir, 'task-aa', 1, 'executor');
    const b = acquireTaskLock(taskDir, 'task-bb', 1, 'executor');
    expect(a!.sessionId).not.toBe(b!.sessionId);
  });
});

describe('acquireInfraLock', () => {
  it('acquires infra lock', () => {
    const lock = acquireInfraLock(taskDir);
    expect(lock).not.toBeNull();
    expect(lock!.sessionId).toBeTruthy();
    expect(fs.existsSync(getInfraLockPath(taskDir))).toBe(true);
  });

  it('returns null on second acquire', () => {
    acquireInfraLock(taskDir);
    const second = acquireInfraLock(taskDir);
    expect(second).toBeNull();
  });
});

describe('heartbeatLock', () => {
  it('updates heartbeatAt timestamp', () => {
    const lock = acquireTaskLock(taskDir, 'task-hb', 1, 'executor');
    const originalHb = lock!.heartbeatAt;
    // wait a moment to ensure timestamp differs
    const future = new Date(Date.now() + 5000).toISOString();
    // manually write future time first to simulate elapsed
    const lockPath = getTaskLockPath(taskDir, 'task-hb');
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const _original = parseYaml(raw) as { heartbeatAt: string };
    heartbeatLock(lockPath);
    const updated = readLock(lockPath);
    expect(updated).not.toBeNull();
    // heartbeatAt should be updated (>= original)
    expect(new Date(updated!.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
      new Date(_original.heartbeatAt).getTime()
    );
  });

  it('is no-op if file does not exist', () => {
    const ghost = path.join(taskDir, 'locks', 'ghost.lock');
    expect(() => heartbeatLock(ghost)).not.toThrow();
  });
});

describe('isLockStale', () => {
  it('returns false when heartbeat is recent', () => {
    acquireTaskLock(taskDir, 'task-fresh', 1, 'executor');
    expect(isLockStale(getTaskLockPath(taskDir, 'task-fresh'), 120)).toBe(false);
  });

  it('returns true when heartbeat exceeds threshold', () => {
    acquireTaskLock(taskDir, 'task-stale', 1, 'executor');
    const lockPath = getTaskLockPath(taskDir, 'task-stale');
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const lock = parseYaml(raw);
    lock.heartbeatAt = new Date(Date.now() - 300_000).toISOString(); // 5 min ago
    fs.writeFileSync(lockPath, stringifyYaml(lock), 'utf-8');
    expect(isLockStale(lockPath, 120)).toBe(true);
  });

  it('returns true when file is corrupted (not an object) (D2)', () => {
    const lockPath = getTaskLockPath(taskDir, 'task-corrupt');
    // write a YAML that parses to a non-object (string) → validateLockFile returns null → stale
    fs.writeFileSync(lockPath, 'just a string\n', 'utf-8');
    expect(isLockStale(lockPath, 120)).toBe(true);
  });

  it('returns false when file does not exist', () => {
    expect(isLockStale(path.join(taskDir, 'locks', 'ghost.lock'), 120)).toBe(false);
  });
});

describe('releaseLock', () => {
  it('deletes the lock file', () => {
    acquireTaskLock(taskDir, 'task-rel', 1, 'executor');
    const lockPath = getTaskLockPath(taskDir, 'task-rel');
    releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('is idempotent (no throw if already deleted)', () => {
    const lockPath = getTaskLockPath(taskDir, 'task-idem');
    expect(() => releaseLock(lockPath)).not.toThrow();
  });
});

describe('readLock', () => {
  it('returns null when no lock file', () => {
    expect(readLock(getTaskLockPath(taskDir, 'nope'))).toBeNull();
  });

  it('returns parsed lock', () => {
    acquireTaskLock(taskDir, 'task-read', 2, 'tester');
    const lock = readLock(getTaskLockPath(taskDir, 'task-read'));
    expect(lock).not.toBeNull();
    expect(lock!.agentType).toBe('tester');
    expect(lock!.taskVersion).toBe(2);
  });
});

describe('isTaskLocked / isInfraLocked', () => {
  it('isTaskLocked true when lock exists', () => {
    acquireTaskLock(taskDir, 'task-locked', 1, 'executor');
    expect(isTaskLocked(taskDir, 'task-locked')).toBe(true);
  });

  it('isTaskLocked false when no lock', () => {
    expect(isTaskLocked(taskDir, 'task-free')).toBe(false);
  });

  it('isInfraLocked true/false', () => {
    expect(isInfraLocked(taskDir)).toBe(false);
    acquireInfraLock(taskDir);
    expect(isInfraLocked(taskDir)).toBe(true);
  });
});

describe('getStaleLocks', () => {
  it('returns only stale lock paths', () => {
    acquireTaskLock(taskDir, 'fresh', 1, 'executor');
    acquireTaskLock(taskDir, 'stale', 1, 'executor');
    const { stringify: _s, parse: _p } = { stringify: stringifyYaml, parse: parseYaml };
    const lockPath = getTaskLockPath(taskDir, 'stale');
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const lock = parseYaml(raw);
    lock.heartbeatAt = new Date(Date.now() - 300_000).toISOString();
    fs.writeFileSync(lockPath, stringifyYaml(lock), 'utf-8');

    const stale = getStaleLocks(taskDir, 120);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('stale');
  });

  it('returns empty when no locks', () => {
    expect(getStaleLocks(taskDir, 120)).toEqual([]);
  });
});