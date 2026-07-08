import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  validateTransition,
  getStateDir,
  ensureStateDirs,
  getTaskState,
  getTaskFilePath,
  moveTask,
  listTasks,
  getNextSeq,
} from '../state';
import { stringify as stringifyYaml } from 'yaml';
import { TaskYaml, TaskState } from '../types';

let tmpDir: string;
let taskDir: string;

function mkTask(id: string, name = 'Test', version = 1): TaskYaml {
  return {
    id,
    name,
    createdAt: '2026-07-08T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    version,
    description: '',
    testResults: { lastRun: null, flows: {}, passRatio: 0 },
  };
}

function writeTask(state: TaskState, id: string, task: TaskYaml = mkTask(id)) {
  const dir = path.join(taskDir, state);
  fs.writeFileSync(path.join(dir, `${id}.yaml`), stringifyYaml(task), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-state-'));
  taskDir = path.join(tmpDir, '.tasks');
  ensureStateDirs(taskDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('validateTransition', () => {
  it('allows defined -> pending by user', () => {
    expect(validateTransition('defined', 'pending', 'user')).toBe(true);
  });

  it('allows pending -> processing by executor', () => {
    expect(validateTransition('pending', 'processing', 'executor')).toBe(true);
  });

  it('allows pending -> processing by user override', () => {
    expect(validateTransition('pending', 'processing', 'user')).toBe(true);
  });

  it('allows pending -> testing/review/done by user override', () => {
    expect(validateTransition('pending', 'testing', 'user')).toBe(true);
    expect(validateTransition('pending', 'review', 'user')).toBe(true);
    expect(validateTransition('pending', 'done', 'user')).toBe(true);
  });

  it('allows processing -> testing/pending/blocked by executor', () => {
    expect(validateTransition('processing', 'testing', 'executor')).toBe(true);
    expect(validateTransition('processing', 'pending', 'executor')).toBe(true);
    expect(validateTransition('processing', 'blocked', 'executor')).toBe(true);
  });

  it('allows testing -> review/processing/blocked by tester', () => {
    expect(validateTransition('testing', 'review', 'tester')).toBe(true);
    expect(validateTransition('testing', 'processing', 'tester')).toBe(true);
    expect(validateTransition('testing', 'blocked', 'tester')).toBe(true);
  });

  it('allows blocked -> processing/testing/pending by user', () => {
    expect(validateTransition('blocked', 'processing', 'user')).toBe(true);
    expect(validateTransition('blocked', 'testing', 'user')).toBe(true);
    expect(validateTransition('blocked', 'pending', 'user')).toBe(true);
  });

  it('allows review -> done/pending by user', () => {
    expect(validateTransition('review', 'done', 'user')).toBe(true);
    expect(validateTransition('review', 'pending', 'user')).toBe(true);
  });

  it('rejects done -> anything (terminal)', () => {
    expect(validateTransition('done', 'pending', 'user')).toBe(false);
    expect(validateTransition('done', 'processing', 'executor')).toBe(false);
  });

  it('rejects wrong actor for transition', () => {
    expect(validateTransition('defined', 'pending', 'executor')).toBe(false);
    expect(validateTransition('processing', 'testing', 'user')).toBe(false);
    expect(validateTransition('review', 'done', 'executor')).toBe(false);
  });

  it('rejects invalid from->to pair', () => {
    expect(validateTransition('defined', 'done', 'user')).toBe(false);
    expect(validateTransition('defined', 'testing', 'user')).toBe(false);
  });
});

describe('ensureStateDirs', () => {
  it('creates all 7 state dirs + locks + runs + sessions + tasksLog', () => {
    const states: TaskState[] = ['defined', 'pending', 'processing', 'testing', 'review', 'done', 'blocked'];
    for (const s of states) {
      expect(fs.existsSync(path.join(taskDir, s))).toBe(true);
    }
    expect(fs.existsSync(path.join(taskDir, 'locks'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'runs'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'runs', 'sessions'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'runs', 'tasks'))).toBe(true);
  });

  it('is idempotent', () => {
    ensureStateDirs(taskDir);
    ensureStateDirs(taskDir);
    expect(fs.existsSync(path.join(taskDir, 'defined'))).toBe(true);
  });
});

describe('getTaskState', () => {
  it('returns state when task exists', () => {
    writeTask('pending', 't1');
    expect(getTaskState(taskDir, 't1')).toBe('pending');
  });

  it('returns null when task not found', () => {
    expect(getTaskState(taskDir, 'nonexistent')).toBeNull();
  });
});

describe('getTaskFilePath', () => {
  it('returns full path to task file', () => {
    writeTask('defined', 't2');
    const fp = getTaskFilePath(taskDir, 't2');
    expect(fp).toBeTruthy();
    expect(fp).toContain('defined');
    expect(fp).toContain('t2.yaml');
  });

  it('returns null when not found', () => {
    expect(getTaskFilePath(taskDir, 'nope')).toBeNull();
  });
});

describe('moveTask', () => {
  it('moves task from defined to pending', () => {
    writeTask('defined', 't3');
    expect(moveTask(taskDir, 't3', 'pending')).toBe(true);
    expect(getTaskState(taskDir, 't3')).toBe('pending');
    expect(fs.existsSync(path.join(taskDir, 'defined', 't3.yaml'))).toBe(false);
  });

  it('returns false when task not found', () => {
    expect(moveTask(taskDir, 'ghost', 'pending')).toBe(false);
  });

  it('handles cross-device move via copy+delete', () => {
    writeTask('defined', 't4');
    expect(moveTask(taskDir, 't4', 'done')).toBe(true);
    expect(getTaskState(taskDir, 't4')).toBe('done');
  });
});

describe('listTasks', () => {
  it('lists tasks across all states when no filter', () => {
    writeTask('defined', 'a1');
    writeTask('pending', 'a2');
    writeTask('done', 'a3');
    const tasks = listTasks(taskDir);
    expect(tasks).toHaveLength(3);
    const ids = tasks.map(t => t.id).sort();
    expect(ids).toEqual(['a1', 'a2', 'a3']);
  });

  it('filters by state', () => {
    writeTask('defined', 'b1');
    writeTask('pending', 'b2');
    const tasks = listTasks(taskDir, 'pending');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('b2');
    expect(tasks[0].state).toBe('pending');
  });

  it('returns empty array when no tasks', () => {
    expect(listTasks(taskDir)).toEqual([]);
  });

  it('returns sorted by id', () => {
    writeTask('defined', 'zebra');
    writeTask('defined', 'alpha');
    writeTask('defined', 'mango');
    const tasks = listTasks(taskDir, 'defined');
    const ids = tasks.map(t => t.id);
    expect(ids).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('ignores non-yaml files', () => {
    writeTask('defined', 'c1');
    fs.writeFileSync(path.join(taskDir, 'defined', 'readme.txt'), 'hello');
    fs.writeFileSync(path.join(taskDir, 'defined', '.DS_Store'), 'x');
    const tasks = listTasks(taskDir, 'defined');
    expect(tasks).toHaveLength(1);
  });
});

describe('getNextSeq', () => {
  it('returns 1 when no tasks for date', () => {
    expect(getNextSeq(taskDir, '2026-07-08')).toBe(1);
  });

  it('returns next seq based on existing tasks for date', () => {
    writeTask('defined', '2026-07-08_task_001');
    writeTask('defined', '2026-07-08_task_002');
    expect(getNextSeq(taskDir, '2026-07-08')).toBe(3);
  });

  it('ignores tasks from other dates', () => {
    writeTask('defined', '2026-07-07_task_005');
    expect(getNextSeq(taskDir, '2026-07-08')).toBe(1);
  });

  it('scans all state dirs not just defined (A5)', () => {
    writeTask('defined', '2026-07-08_first_001');
    moveTask(taskDir, '2026-07-08_first_001', 'pending');
    // now defined/ is empty but pending/ has _001
    expect(getNextSeq(taskDir, '2026-07-08')).toBe(2);
  });
});