import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { ensureStateDirs, TaskLockedError } from '../core/state';
import { acquireTaskLock } from '../core/lock';
import { TaskYaml, TaskState } from '../core/types';
import { editTask } from '../edit';
import { writeDefaultConfig } from '../core/test-util';

let tmpDir: string;
let taskDir: string;

function mkTask(id: string, desc = 'original'): TaskYaml {
  return {
    id,
    name: 'Test',
    createdAt: '2026-07-08T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    version: 1,
    description: desc,
    testResults: { lastRun: null, flows: {}, passRatio: 0 },
  };
}

function writeTask(state: TaskState, id: string, task: TaskYaml = mkTask(id)) {
  const dir = path.join(taskDir, state);
  fs.writeFileSync(path.join(dir, `${id}.yaml`), stringifyYaml(task), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-edit-'));
  taskDir = path.join(tmpDir, '.tasks');
  ensureStateDirs(taskDir);
  writeDefaultConfig(taskDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('editTask lock check (A3)', () => {
  it('throws TaskLockedError when task is locked', () => {
    writeTask('pending', 't1');
    acquireTaskLock(taskDir, 't1', 1, 'executor');
    expect(() => editTask(taskDir, 't1', { description: 'new' })).toThrow(TaskLockedError);
    // file unchanged
    const raw = fs.readFileSync(path.join(taskDir, 'pending', 't1.yaml'), 'utf-8');
    expect(raw).toContain('original');
  });

  it('allows edit with force when locked', () => {
    writeTask('pending', 't2');
    acquireTaskLock(taskDir, 't2', 1, 'executor');
    editTask(taskDir, 't2', { description: 'forced' }, { force: true });
    const raw = fs.readFileSync(path.join(taskDir, 'pending', 't2.yaml'), 'utf-8');
    expect(raw).toContain('forced');
  });

  it('allows edit when not locked', () => {
    writeTask('defined', 't3');
    editTask(taskDir, 't3', { description: 'updated' });
    const raw = fs.readFileSync(path.join(taskDir, 'defined', 't3.yaml'), 'utf-8');
    expect(raw).toContain('updated');
  });

  it('rejects editing a done task', () => {
    writeTask('done', 't4');
    let exitCode = 0;
    const origExit = process.exit;
    (process as any).exit = ((code: number) => { exitCode = code; throw new Error('exit'); }) as any;
    try {
      editTask(taskDir, 't4', { description: 'nope' });
    } catch {
      // expected
    }
    (process as any).exit = origExit;
    expect(exitCode).toBe(1);
  });

  it('rejects editing a task in review', () => {
    writeTask('review', 't5');
    let exitCode = 0;
    const origExit = process.exit;
    (process as any).exit = ((code: number) => { exitCode = code; throw new Error('exit'); }) as any;
    try {
      editTask(taskDir, 't5', { description: 'nope' });
    } catch {
      // expected
    }
    (process as any).exit = origExit;
    expect(exitCode).toBe(1);
  });

  it('versioning flow: processing task moves to pending after edit', () => {
    writeTask('processing', 't6', mkTask('t6', 'v1 content'));
    acquireTaskLock(taskDir, 't6', 1, 'executor');
    editTask(taskDir, 't6', { description: 'v2 content' }, { force: true });
    // should be in pending now
    expect(fs.existsSync(path.join(taskDir, 'pending', 't6.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'processing', 't6.yaml'))).toBe(false);
    const raw = fs.readFileSync(path.join(taskDir, 'pending', 't6.yaml'), 'utf-8');
    const task = parseYaml(raw) as TaskYaml;
    expect(task.version).toBe(2);
    expect(task.description).toBe('v2 content');
    expect(task.versions?.v1).toBeDefined();
    expect(task.versions?.v1.description).toBe('v1 content');
  });
});