import { describe, it, expect } from 'vitest';
import { validateTaskYaml, validateLockFile, ValidationError } from '../validate';
import { TaskYaml } from '../types';

function validTask(overrides: Partial<TaskYaml> = {}): TaskYaml {
  return {
    id: 't1',
    name: 'Test',
    createdAt: '2026-07-08T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    version: 1,
    description: '',
    testResults: { lastRun: null, flows: {}, passRatio: 0 },
    ...overrides,
  };
}

describe('validateTaskYaml', () => {
  it('validates a well-formed task', () => {
    const raw = validTask();
    const task = validateTaskYaml(raw);
    expect(task.id).toBe('t1');
    expect(task.version).toBe(1);
  });

  it('throws on missing id', () => {
    const raw = validTask();
    delete (raw as any).id;
    expect(() => validateTaskYaml(raw)).toThrow(ValidationError);
  });

  it('throws on missing name', () => {
    const raw = validTask();
    delete (raw as any).name;
    expect(() => validateTaskYaml(raw)).toThrow(ValidationError);
  });

  it('throws on non-number version', () => {
    const raw = validTask({ version: 'abc' as any });
    expect(() => validateTaskYaml(raw)).toThrow(ValidationError);
  });

  it('coerces string version to number', () => {
    const raw = validTask({ version: '3' as any });
    const task = validateTaskYaml(raw);
    expect(task.version).toBe(3);
  });

  it('coerces missing testResults to default', () => {
    const raw = validTask();
    delete (raw as any).testResults;
    const task = validateTaskYaml(raw);
    expect(task.testResults).toEqual({ lastRun: null, flows: {}, passRatio: 0 });
  });

  it('validates testFlows array', () => {
    const raw = validTask({
      testFlows: [
        { name: 'Happy path', steps: '1. Open /login' },
        { name: 'Bad', environment: 'dev', steps: '1. Fail' },
      ],
    });
    const task = validateTaskYaml(raw);
    expect(task.testFlows).toHaveLength(2);
    expect(task.testFlows![0].name).toBe('Happy path');
    expect(task.testFlows![1].environment).toBe('dev');
  });

  it('throws on testFlow missing steps', () => {
    const raw = validTask({
      testFlows: [{ name: 'No steps' } as any],
    });
    expect(() => validateTaskYaml(raw)).toThrow(ValidationError);
  });

  it('validates pendingQuestions', () => {
    const raw = validTask({
      pendingQuestions: [
        {
          id: 'q1',
          askedAt: '2026-07-08T00:00:00Z',
          askedBy: 'executor',
          category: 'impl',
          question: 'Which auth?',
          answered: false,
        },
      ],
    });
    const task = validateTaskYaml(raw);
    expect(task.pendingQuestions).toHaveLength(1);
    expect(task.pendingQuestions![0].id).toBe('q1');
    expect(task.pendingQuestions![0].answered).toBe(false);
  });

  it('validates previousState as TaskState', () => {
    const raw = validTask({ previousState: 'processing' });
    expect(validateTaskYaml(raw).previousState).toBe('processing');
  });

  it('throws on invalid previousState', () => {
    const raw = validTask({ previousState: 'foobar' as any });
    expect(() => validateTaskYaml(raw)).toThrow(ValidationError);
  });

  it('throws on non-object input', () => {
    expect(() => validateTaskYaml('just a string')).toThrow(ValidationError);
    expect(() => validateTaskYaml(null)).toThrow(ValidationError);
    expect(() => validateTaskYaml(42)).toThrow(ValidationError);
  });

  it('validates bugs array', () => {
    const raw = validTask({
      bugs: [
        { flow: 'Happy', description: 'failed', foundAt: '2026-07-08T00:00:00Z' },
      ],
    });
    const task = validateTaskYaml(raw);
    expect(task.bugs).toHaveLength(1);
    expect(task.bugs![0].flow).toBe('Happy');
  });

  it('validates versions record', () => {
    const raw = validTask({
      versions: {
        v1: {
          updatedAt: '2026-07-07T00:00:00Z',
          description: 'old desc',
        },
      },
    });
    const task = validateTaskYaml(raw);
    expect(task.versions!.v1.description).toBe('old desc');
  });
});

describe('validateLockFile', () => {
  it('validates a well-formed lock', () => {
    const raw = {
      sessionId: 'abc-123',
      agentType: 'executor',
      taskVersion: 2,
      acquiredAt: '2026-07-08T00:00:00Z',
      heartbeatAt: '2026-07-08T00:00:00Z',
    };
    const lock = validateLockFile(raw);
    expect(lock).not.toBeNull();
    expect(lock!.sessionId).toBe('abc-123');
    expect(lock!.agentType).toBe('executor');
    expect(lock!.taskVersion).toBe(2);
  });

  it('returns null for non-object', () => {
    expect(validateLockFile('just a string')).toBeNull();
    expect(validateLockFile(null)).toBeNull();
    expect(validateLockFile(42)).toBeNull();
  });

  it('returns null for missing sessionId', () => {
    expect(validateLockFile({ acquiredAt: 'x', heartbeatAt: 'y' })).toBeNull();
  });

  it('returns null for missing timestamps', () => {
    expect(validateLockFile({ sessionId: 's1' })).toBeNull();
  });

  it('ignores invalid agentType', () => {
    const raw = { sessionId: 's1', acquiredAt: 'a', heartbeatAt: 'h', agentType: 'bogus' };
    const lock = validateLockFile(raw);
    expect(lock).not.toBeNull();
    expect(lock!.agentType).toBeUndefined();
  });
});