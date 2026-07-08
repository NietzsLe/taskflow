import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { ensureStateDirs, moveTask, TaskLockedError } from '../core/state';
import { acquireTaskLock, getTaskLockPath, isTaskLocked } from '../core/lock';
import { TaskYaml, TaskState } from '../core/types';
import { writeDefaultConfig } from '../core/test-util';

let tmpDir: string;
let taskDir: string;

function mkTask(id: string): TaskYaml {
  return {
    id,
    name: 'Test',
    createdAt: '2026-07-08T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    version: 1,
    description: '',
    testResults: { lastRun: null, flows: {}, passRatio: 0 },
  };
}

function writeTask(state: TaskState, id: string) {
  const dir = path.join(taskDir, state);
  fs.writeFileSync(path.join(dir, `${id}.yaml`), stringifyYaml(mkTask(id)), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-move-'));
  taskDir = path.join(tmpDir, '.tasks');
  ensureStateDirs(taskDir);
  writeDefaultConfig(taskDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('moveTask lock check (A2)', () => {
  it('throws TaskLockedError when task is locked', () => {
    writeTask('pending', 't1');
    acquireTaskLock(taskDir, 't1', 1, 'executor');
    expect(() => moveTask(taskDir, 't1', 'processing')).toThrow(TaskLockedError);
    // task should still be in pending (not moved)
    expect(fs.existsSync(path.join(taskDir, 'pending', 't1.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'processing', 't1.yaml'))).toBe(false);
  });

  it('allows move with force when locked', () => {
    writeTask('pending', 't2');
    acquireTaskLock(taskDir, 't2', 1, 'executor');
    expect(moveTask(taskDir, 't2', 'processing', { force: true })).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'processing', 't2.yaml'))).toBe(true);
  });

  it('allows move when not locked', () => {
    writeTask('defined', 't3');
    expect(moveTask(taskDir, 't3', 'pending')).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'pending', 't3.yaml'))).toBe(true);
  });
});

describe('isTaskLocked integration', () => {
  it('returns true after acquireTaskLock', () => {
    writeTask('pending', 't4');
    acquireTaskLock(taskDir, 't4', 1, 'executor');
    expect(isTaskLocked(taskDir, 't4')).toBe(true);
  });

  it('returns false when no lock', () => {
    writeTask('pending', 't5');
    expect(isTaskLocked(taskDir, 't5')).toBe(false);
  });
});