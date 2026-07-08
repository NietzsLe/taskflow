import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { ensureStateDirs, TaskLockedError } from '../core/state';
import { acquireTaskLock } from '../core/lock';
import { TaskYaml, TaskState } from '../core/types';
import { editTask } from '../edit';
import { writeDefaultConfig } from '../core/test-util';
import { validateTaskYaml } from '../core/validate';

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

  it('creates version snapshot when editing a defined task', () => {
    const taskDir2 = mkdtempSync(path.join(tmpdir(), 'edit-test-'));
    for (const s of ['defined', 'pending', 'processing', 'testing', 'review', 'done', 'blocked']) {
      fs.mkdirSync(path.join(taskDir2, s), { recursive: true });
    }
    fs.mkdirSync(path.join(taskDir2, 'locks'), { recursive: true });
    fs.mkdirSync(path.join(taskDir2, 'runs'), { recursive: true });
    const task: TaskYaml = {
      id: 'test-task_001',
      name: 'Test Task',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      description: 'v1 content',
      testResults: { lastRun: null, flows: {}, passRatio: 0 },
    };
    fs.writeFileSync(path.join(taskDir2, 'defined', 'test-task_001.yaml'), stringifyYaml(task), 'utf-8');

    editTask(taskDir2, 'test-task_001', { description: 'v2 content', changeDescription: 'Updated description' });

    const raw = fs.readFileSync(path.join(taskDir2, 'defined', 'test-task_001.yaml'), 'utf-8');
    const updated = validateTaskYaml(parseYaml(raw));
    expect(updated.version).toBe(2);
    expect(updated.description).toBe('v2 content');
    expect(updated.versions?.v1).toBeDefined();
    expect(updated.versions!.v1.description).toBe('v1 content');
    expect(updated.versions!.v1.changeDescription).toBe('Updated description');
    fs.rmSync(taskDir2, { recursive: true, force: true });
  });

  it('status-update does not bump version', () => {
    const taskDir2 = mkdtempSync(path.join(tmpdir(), 'edit-test-'));
    for (const s of ['pending', 'processing', 'testing', 'review', 'done', 'blocked', 'defined']) {
      fs.mkdirSync(path.join(taskDir2, s), { recursive: true });
    }
    fs.mkdirSync(path.join(taskDir2, 'locks'), { recursive: true });
    fs.mkdirSync(path.join(taskDir2, 'runs'), { recursive: true });
    const task: TaskYaml = {
      id: 'test-task_001',
      name: 'Test Task',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      description: 'test',
      testResults: { lastRun: null, flows: {}, passRatio: 0 },
    };
    fs.writeFileSync(path.join(taskDir2, 'pending', 'test-task_001.yaml'), stringifyYaml(task), 'utf-8');

    const filePath = path.join(taskDir2, 'pending', 'test-task_001.yaml');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const t = validateTaskYaml(parseYaml(raw));
    t.statusDescription = 'Working on it';
    t.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, stringifyYaml(t), 'utf-8');

    const updated = validateTaskYaml(parseYaml(fs.readFileSync(filePath, 'utf-8')));
    expect(updated.version).toBe(1);
    expect(updated.statusDescription).toBe('Working on it');
    fs.rmSync(taskDir2, { recursive: true, force: true });
  });
});