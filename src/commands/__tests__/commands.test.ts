import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stringify as stringifyYaml } from 'yaml';
import { ensureStateDirs } from '../../core/state';
import { TaskYaml, TaskState } from '../../core/types';
import { writeDefaultConfig } from '../../core/test-util';
import { answerQuestion } from '../answer';
import { deleteTask } from '../delete';
import { runDoctor } from '../doctor';

let tmpDir: string;
let cwd: string;

function mkTask(id: string, overrides: Partial<TaskYaml> = {}): TaskYaml {
  return {
    id,
    name: 'Test',
    createdAt: '2026-07-08T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    version: 1,
    description: 'test desc',
    testResults: { lastRun: null, flows: {}, passRatio: 0 },
    ...overrides,
  };
}

function writeTask(state: TaskState, task: TaskYaml) {
  const dir = path.join(tmpDir, '.tasks', state);
  fs.writeFileSync(path.join(dir, `${task.id}.yaml`), stringifyYaml(task), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cmd-'));
  cwd = process.cwd();
  process.chdir(tmpDir);
  const taskDir = path.join(tmpDir, '.tasks');
  ensureStateDirs(taskDir);
  writeDefaultConfig(taskDir);
  // create archive dir
  fs.mkdirSync(path.join(taskDir, 'archive'), { recursive: true });
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('answerQuestion', () => {
  it('answers a pending question on a blocked task', () => {
    const task = mkTask('t1', {
      previousState: 'processing',
      pendingQuestions: [
        { id: 'q1', askedAt: '2026-07-08T00:00:00Z', askedBy: 'executor', category: 'impl', question: 'Which auth?', answered: false },
      ],
    });
    writeTask('blocked', task);
    answerQuestion(path.join(tmpDir, '.tasks'), 't1', 'q1', 'Use NextAuth.js');
    const raw = fs.readFileSync(path.join(tmpDir, '.tasks', 'blocked', 't1.yaml'), 'utf-8');
    const { parse: parseYaml } = require('yaml');
    const updated = parseYaml(raw);
    expect(updated.pendingQuestions[0].answered).toBe(true);
    expect(updated.pendingQuestions[0].answer).toBe('Use NextAuth.js');
    expect(updated.pendingQuestions[0].answeredAt).toBeTruthy();
  });

  it('errors if task not found', () => {
    const origExit = process.exit;
    let exitCode = 0;
    (process as any).exit = ((c: number) => { exitCode = c; throw new Error('exit'); }) as any;
    try {
      answerQuestion(path.join(tmpDir, '.tasks'), 'ghost', 'q1', 'nope');
    } catch {}
    (process as any).exit = origExit;
    expect(exitCode).toBe(1);
  });

  it('errors if task is not blocked', () => {
    const task = mkTask('t2');
    writeTask('pending', task);
    const origExit = process.exit;
    let exitCode = 0;
    (process as any).exit = ((c: number) => { exitCode = c; throw new Error('exit'); }) as any;
    try {
      answerQuestion(path.join(tmpDir, '.tasks'), 't2', 'q1', 'nope');
    } catch {}
    (process as any).exit = origExit;
    expect(exitCode).toBe(1);
  });

  it('errors if question not found', () => {
    const task = mkTask('t3', {
      previousState: 'processing',
      pendingQuestions: [
        { id: 'q1', askedAt: '2026-07-08T00:00:00Z', askedBy: 'executor', category: 'impl', question: 'Which?', answered: false },
      ],
    });
    writeTask('blocked', task);
    const origExit = process.exit;
    let exitCode = 0;
    (process as any).exit = ((c: number) => { exitCode = c; throw new Error('exit'); }) as any;
    try {
      answerQuestion(path.join(tmpDir, '.tasks'), 't3', 'bogus', 'nope');
    } catch {}
    (process as any).exit = origExit;
    expect(exitCode).toBe(1);
  });
});

describe('deleteTask', () => {
  it('archives a task to archive/', () => {
    const task = mkTask('t4');
    writeTask('pending', task);
    deleteTask(path.join(tmpDir, '.tasks'), 't4');
    expect(fs.existsSync(path.join(tmpDir, '.tasks', 'pending', 't4.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.tasks', 'archive', 't4.yaml'))).toBe(true);
    const raw = fs.readFileSync(path.join(tmpDir, '.tasks', 'archive', 't4.yaml'), 'utf-8');
    expect(raw).toContain('Deleted by user');
  });

  it('errors if task not found', () => {
    const origExit = process.exit;
    let exitCode = 0;
    (process as any).exit = ((c: number) => { exitCode = c; throw new Error('exit'); }) as any;
    try {
      deleteTask(path.join(tmpDir, '.tasks'), 'ghost');
    } catch {}
    (process as any).exit = origExit;
    expect(exitCode).toBe(1);
  });

  it('errors on done task', () => {
    const task = mkTask('t5');
    writeTask('done', task);
    const origExit = process.exit;
    let exitCode = 0;
    (process as any).exit = ((c: number) => { exitCode = c; throw new Error('exit'); }) as any;
    try {
      deleteTask(path.join(tmpDir, '.tasks'), 't5');
    } catch {}
    (process as any).exit = origExit;
    expect(exitCode).toBe(1);
  });
});

describe('runDoctor', () => {
  it('passes when everything is in place', () => {
    // create skills dir
    const skillsDir = path.join(tmpDir, '.agents', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillNames = ['taskflow-init', 'taskflow-executor', 'taskflow-tester', 'taskflow-lock-releaser', 'taskflow-notifier', 'taskflow-user'];
    for (const s of skillNames) {
      fs.mkdirSync(path.join(skillsDir, s), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, s, 'SKILL.md'), `---\nname: ${s}\ndescription: test\n---\n`, 'utf-8');
    }
    const result = runDoctor(path.join(tmpDir, '.tasks'));
    expect(result.ok).toBe(true);
    const fails = result.checks.filter(c => c.status === 'fail');
    expect(fails).toHaveLength(0);
  });

  it('fails when state dir missing', () => {
    fs.rmSync(path.join(tmpDir, '.tasks', 'defined'), { recursive: true, force: true });
    const result = runDoctor(path.join(tmpDir, '.tasks'));
    expect(result.ok).toBe(false);
    const dirFail = result.checks.find(c => c.name === 'dir/defined');
    expect(dirFail?.status).toBe('fail');
  });

  it('warns on orphan lock', () => {
    const locksDir = path.join(tmpDir, '.tasks', 'locks');
    fs.writeFileSync(path.join(locksDir, 'task-ghost.lock'), 'sessionId: x\nacquiredAt: y\nheartbeatAt: z\n', 'utf-8');
    const result = runDoctor(path.join(tmpDir, '.tasks'));
    const orphan = result.checks.find(c => c.name === 'lock/ghost');
    expect(orphan?.status).toBe('warn');
  });
});