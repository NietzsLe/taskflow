import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { buildSnapshot, readSnapshot, writeSnapshot, computeDiff, formatReport, getNotifierStatePath } from '../notifier';
import { getDefaultConfig, TaskFlowConfig } from '../config';
import { stringify as stringifyYaml } from 'yaml';
import { TaskYaml } from '../types';

function createTask(taskDir: string, state: string, task: Partial<TaskYaml> & { id: string; name: string }): void {
  const stateDir = path.join(taskDir, state);
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const fullTask: TaskYaml = {
    id: task.id,
    name: task.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: task.version || 1,
    description: task.description || '',
    ...task,
  };
  writeFileSync(path.join(stateDir, `${task.id}.yaml`), stringifyYaml(fullTask), 'utf-8');
}

function createLock(taskDir: string, taskId: string, sessionId: string, heartbeatAt: string): void {
  const locksDir = path.join(taskDir, 'locks');
  if (!existsSync(locksDir)) mkdirSync(locksDir, { recursive: true });
  writeFileSync(path.join(locksDir, `task-${taskId}.lock`), stringifyYaml({
    sessionId,
    agentType: 'executor',
    taskVersion: 1,
    acquiredAt: heartbeatAt,
    heartbeatAt,
  }), 'utf-8');
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('buildSnapshot', () => {
  let taskDir: string;
  let config: TaskFlowConfig;

  beforeEach(() => {
    taskDir = mkdtempSync(path.join(tmpdir(), 'notifier-test-'));
    config = getDefaultConfig();
    for (const s of ['defined', 'pending', 'processing', 'testing', 'review', 'done', 'blocked']) {
      mkdirSync(path.join(taskDir, s), { recursive: true });
    }
    mkdirSync(path.join(taskDir, 'locks'), { recursive: true });
  });

  afterEach(() => cleanupDir(taskDir));

  it('captures all tasks across all states', () => {
    createTask(taskDir, 'pending', { id: 'task-a_001', name: 'Task A', version: 1 });
    createTask(taskDir, 'processing', { id: 'task-b_001', name: 'Task B', version: 2 });
    createTask(taskDir, 'done', { id: 'task-c_001', name: 'Task C', version: 1 });

    const snapshot = buildSnapshot(taskDir, config);
    expect(Object.keys(snapshot.tasks)).toHaveLength(3);
    expect(snapshot.tasks['task-a_001'].state).toBe('pending');
    expect(snapshot.tasks['task-b_001'].state).toBe('processing');
    expect(snapshot.tasks['task-c_001'].state).toBe('done');
  });

  it('detects stale locks', () => {
    createTask(taskDir, 'processing', { id: 'task-a_001', name: 'Task A', version: 1 });
    const oldTime = new Date(Date.now() - 300000).toISOString();
    createLock(taskDir, 'task-a_001', 'session-123', oldTime);

    const snapshot = buildSnapshot(taskDir, config);
    expect(snapshot.tasks['task-a_001'].lockStale).toBe(true);
    expect(snapshot.tasks['task-a_001'].lockedBy).toBe('session-123');
  });

  it('detects active locks', () => {
    createTask(taskDir, 'processing', { id: 'task-a_001', name: 'Task A', version: 1 });
    const now = new Date().toISOString();
    createLock(taskDir, 'task-a_001', 'session-123', now);

    const snapshot = buildSnapshot(taskDir, config);
    expect(snapshot.tasks['task-a_001'].lockStale).toBe(false);
  });
});

describe('readSnapshot / writeSnapshot', () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = mkdtempSync(path.join(tmpdir(), 'notifier-test-'));
  });

  afterEach(() => cleanupDir(taskDir));

  it('returns null when no snapshot exists', () => {
    expect(readSnapshot(taskDir)).toBeNull();
  });

  it('round-trips a snapshot', () => {
    const snapshot = {
      takenAt: new Date().toISOString(),
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: new Date().toISOString(),
        },
      },
    };
    writeSnapshot(taskDir, snapshot);
    const loaded = readSnapshot(taskDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.tasks['task-a_001'].name).toBe('Task A');
    expect(loaded!.tasks['task-a_001'].state).toBe('pending');
  });

  it('returns null for corrupt snapshot', () => {
    const statePath = getNotifierStatePath(taskDir);
    const dir = path.dirname(statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, 'not-json', 'utf-8');
    expect(readSnapshot(taskDir)).toBeNull();
  });
});

describe('computeDiff', () => {
  let config: TaskFlowConfig;

  beforeEach(() => {
    config = getDefaultConfig();
  });

  it('detects state transitions', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'processing' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.transitions).toHaveLength(1);
    expect(diff.transitions[0]).toEqual({
      taskId: 'task-a_001', name: 'Task A', from: 'pending', to: 'processing',
    });
  });

  it('detects new tasks', () => {
    const prev = { takenAt: '2026-07-08T10:00:00Z', tasks: {} };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.newTasks).toHaveLength(1);
    expect(diff.newTasks[0].taskId).toBe('task-a_001');
  });

  it('detects removed tasks', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = { takenAt: '2026-07-08T10:05:00Z', tasks: {} };
    const diff = computeDiff(prev, current, config);
    expect(diff.removedTasks).toHaveLength(1);
    expect(diff.removedTasks[0].taskId).toBe('task-a_001');
  });

  it('detects version bumps', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 2, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.versionBumps).toHaveLength(1);
    expect(diff.versionBumps[0]).toEqual({
      taskId: 'task-a_001', name: 'Task A', from: 1, to: 2,
    });
  });

  it('detects newly blocked tasks', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'testing' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'blocked' as const,
          version: 1, bounceCount: 3, attemptCount: 0,
          blockedReason: 'Max bounces exceeded',
          pendingQuestionCount: 2, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.newlyBlocked).toHaveLength(1);
    expect(diff.newlyBlocked[0].taskId).toBe('task-a_001');
    expect(diff.newlyBlocked[0].previousState).toBe('testing');
  });

  it('detects resolved blocks', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'blocked' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.resolvedBlocks).toHaveLength(1);
    expect(diff.resolvedBlocks[0].taskId).toBe('task-a_001');
  });

  it('detects bounce threshold hit', () => {
    config.test.maxBounces = 3;
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'testing' as const,
          version: 1, bounceCount: 2, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'testing' as const,
          version: 1, bounceCount: 3, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.bounceThresholdHit).toHaveLength(1);
    expect(diff.bounceThresholdHit[0].bounceCount).toBe(3);
  });

  it('detects stale locks', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'processing' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, lockedBy: 'session-123',
          updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'processing' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: true, lockedBy: 'session-123',
          updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.staleLocks).toHaveLength(1);
    expect(diff.staleLocks[0].sessionId).toBe('session-123');
  });
});

describe('formatReport', () => {
  it('formats summary section', () => {
    const diff = {
      transitions: [{ taskId: 'a_001', name: 'Task A', from: 'pending' as const, to: 'processing' as const }],
      newTasks: [{ taskId: 'b_001', name: 'Task B', state: 'pending' as const }],
      removedTasks: [],
      newlyBlocked: [],
      bounceThresholdHit: [],
      staleLocks: [],
      versionBumps: [{ taskId: 'c_001', name: 'Task C', from: 1, to: 2 }],
      resolvedBlocks: [{ taskId: 'd_001', toState: 'pending' as const }],
    };
    const snapshot = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'a_001': { id: 'a_001', name: 'Task A', state: 'processing' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'b_001': { id: 'b_001', name: 'Task B', state: 'pending' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'c_001': { id: 'c_001', name: 'Task C', state: 'pending' as const, version: 2, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'd_001': { id: 'd_001', name: 'Task D', state: 'pending' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
      },
    };
    const config = getDefaultConfig();
    const report = formatReport(diff, snapshot, config);
    expect(report).toContain('Task A');
    expect(report).toContain('pending → processing');
    expect(report).toContain('Task B');
    expect(report).toContain('v1 → v2');
    expect(report).toContain('4 tasks');
  });

  it('formats issues section', () => {
    const diff = {
      transitions: [],
      newTasks: [],
      removedTasks: [],
      newlyBlocked: [{
        taskId: 'a_001', name: 'Task A', questions: [],
        previousState: 'testing' as const, blockedReason: 'Max bounces',
      }],
      bounceThresholdHit: [{
        taskId: 'b_001', name: 'Task B', bounceCount: 3, maxBounces: 3,
      }],
      staleLocks: [{
        taskId: 'c_001', sessionId: 'session-123', elapsedSeconds: 150,
      }],
      versionBumps: [],
      resolvedBlocks: [],
    };
    const snapshot = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'a_001': { id: 'a_001', name: 'Task A', state: 'blocked' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'b_001': { id: 'b_001', name: 'Task B', state: 'testing' as const, version: 1, bounceCount: 3, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'c_001': { id: 'c_001', name: 'Task C', state: 'processing' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
      },
    };
    const config = getDefaultConfig();
    const report = formatReport(diff, snapshot, config);
    expect(report).toContain('BLOCKED');
    expect(report).toContain('bounced 3/3');
    expect(report).toContain('stale lock');
    expect(report).toContain('3 tasks');
  });
});
