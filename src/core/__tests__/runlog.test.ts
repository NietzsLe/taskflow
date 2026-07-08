import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  appendRunLog,
  appendReleaserLog,
  readTaskLog,
  readSessionLog,
  readAllSessionLogs,
  listSessionFiles,
  getSessionsDir,
  getTasksLogDir,
  getReleaserLogPath,
  getGlobalSeqPath,
} from '../runlog';
import { ensureStateDirs } from '../state';
import { writeDefaultConfig } from '../test-util';

let tmpDir: string;
let taskDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-runlog-'));
  taskDir = path.join(tmpDir, '.tasks');
  ensureStateDirs(taskDir);
  writeDefaultConfig(taskDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entry(overrides: Partial<Parameters<typeof appendRunLog>[1]> = {}) {
  return {
    timestamp: new Date().toISOString(),
    agentType: 'user' as const,
    sessionId: 'cli',
    agentName: null,
    taskId: 'task-1',
    taskVersion: 1,
    taskState: 'pending',
    action: 'add',
    description: 'Test action',
    result: 'success' as const,
    duration: 0,
    error: null,
    details: null,
    ...overrides,
  };
}

describe('appendRunLog', () => {
  it('writes to both session and task log files', () => {
    appendRunLog(taskDir, entry({ sessionId: 'sess-1', taskId: 'task-1' }));
    const sessionLog = readSessionLog(taskDir, 'sess-1');
    const taskLog = readTaskLog(taskDir, 'task-1');
    expect(sessionLog).toContain('add');
    expect(sessionLog).toContain('**Session:** sess-1');
    expect(taskLog).toContain('add');
    expect(taskLog).toContain('**Task:** task-1');
  });

  it('increments global seq for runId', () => {
    const e1 = appendRunLog(taskDir, entry());
    const e2 = appendRunLog(taskDir, entry());
    expect(e1!.runId).toMatch(/run_\d{8}_001/);
    expect(e2!.runId).toMatch(/run_\d{8}_002/);
    expect(fs.readFileSync(getGlobalSeqPath(taskDir), 'utf-8').trim()).toBe('2');
  });

  it('writes summary field when provided', () => {
    appendRunLog(taskDir, entry({ summary: 'Did some work' }));
    const log = readSessionLog(taskDir, 'cli');
    expect(log).toContain('**Summary:**');
    expect(log).toContain('Did some work');
  });

  it('writes error field when provided', () => {
    appendRunLog(taskDir, entry({ error: 'Something broke' }));
    const log = readSessionLog(taskDir, 'cli');
    expect(log).toContain('**Error:**');
    expect(log).toContain('Something broke');
  });

  it('writes details field when provided', () => {
    appendRunLog(taskDir, entry({ details: 'Step 1 done\nStep 2 done' }));
    const log = readSessionLog(taskDir, 'cli');
    expect(log).toContain('**Details:**');
    expect(log).toContain('Step 1 done');
  });

  it('returns null when runLog.enabled is false', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'runLog:\n  enabled: false\n',
      'utf-8'
    );
    const result = appendRunLog(taskDir, entry());
    expect(result).toBeNull();
  });

  it('creates sessions/ and tasks/ dirs if missing', () => {
    fs.rmSync(getSessionsDir(taskDir), { recursive: true, force: true });
    fs.rmSync(getTasksLogDir(taskDir), { recursive: true, force: true });
    appendRunLog(taskDir, entry());
    expect(fs.existsSync(getSessionsDir(taskDir))).toBe(true);
    expect(fs.existsSync(getTasksLogDir(taskDir))).toBe(true);
  });
});

describe('appendReleaserLog', () => {
  it('appends to releaser-log.md', () => {
    appendReleaserLog(taskDir, 'Released stale lock task-x.lock');
    const log = fs.readFileSync(getReleaserLogPath(taskDir), 'utf-8');
    expect(log).toContain('Released stale lock');
    expect(log).toMatch(/^## /m);
  });

  it('is no-op when runLog disabled (file not created)', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'runLog:\n  enabled: false\n',
      'utf-8'
    );
    // create the file first so read doesn't throw
    const releaserPath = getReleaserLogPath(taskDir);
    fs.mkdirSync(path.dirname(releaserPath), { recursive: true });
    fs.writeFileSync(releaserPath, '# initial\n', 'utf-8');
    appendReleaserLog(taskDir, 'should not appear');
    const log = fs.readFileSync(releaserPath, 'utf-8');
    expect(log).not.toContain('should not appear');
  });
});

describe('readAllSessionLogs', () => {
  it('returns concatenated content of all sessions', () => {
    appendRunLog(taskDir, entry({ sessionId: 'sess-a', taskId: 'task-a' }));
    appendRunLog(taskDir, entry({ sessionId: 'sess-b', taskId: 'task-b' }));
    const all = readAllSessionLogs(taskDir);
    expect(all).toContain('task-a');
    expect(all).toContain('task-b');
  });

  it('filters by agent type', () => {
    appendRunLog(taskDir, entry({ sessionId: 's1', agentType: 'executor', taskId: 'exec-task' }));
    appendRunLog(taskDir, entry({ sessionId: 's2', agentType: 'tester', taskId: 'test-task' }));
    const execLogs = readAllSessionLogs(taskDir, 'executor');
    expect(execLogs).toContain('exec-task');
    expect(execLogs).not.toContain('test-task');
  });

  it('returns empty string when no sessions', () => {
    expect(readAllSessionLogs(taskDir)).toBe('');
  });
});

describe('listSessionFiles', () => {
  it('lists session files sorted by mtime descending', () => {
    appendRunLog(taskDir, entry({ sessionId: 'old' }));
    // small delay to ensure different mtime
    appendRunLog(taskDir, entry({ sessionId: 'new' }));
    const files = listSessionFiles(taskDir);
    expect(files).toHaveLength(2);
    // newest first (higher mtime)
    expect(files[0].mtime).toBeGreaterThanOrEqual(files[1].mtime);
  });

  it('returns empty array when no sessions', () => {
    expect(listSessionFiles(taskDir)).toEqual([]);
  });
});