import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTaskFilePath, getTaskState, moveTask } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { validateTaskYaml } from '../core/validate';
import { TaskYaml } from '../core/types';

/**
 * Rollback a task to a previous version snapshot.
 * Creates a new version (max + 1) with content from the old snapshot.
 * The task must be in defined/pending/blocked (not actively processing/testing).
 */
export function rollbackTask(taskDir: string, taskId: string, targetVersion: string): void {
  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) {
    console.error(`Task '${taskId}' not found.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));

  if (!task.versions || !task.versions[targetVersion]) {
    const available = task.versions ? Object.keys(task.versions).join(', ') : '(none)';
    console.error(`Version '${targetVersion}' not found. Available: ${available}`);
    process.exit(1);
  }

  const snap = task.versions[targetVersion];
  const newVersion = task.version + 1;

  // Snapshot current before rollback (keep audit trail)
  if (!task.versions) task.versions = {};
  task.versions[`v${task.version}`] = {
    updatedAt: task.updatedAt,
    description: task.description,
    implementationNotes: task.implementationNotes,
    testFlows: task.testFlows ? task.testFlows.map(f => ({ ...f })) : undefined,
    bounceCount: task.bounceCount,
    changeDescription: `Rollback to ${targetVersion}`,
  };

  // Restore content from target snapshot
  task.description = snap.description;
  task.implementationNotes = snap.implementationNotes;
  task.testFlows = snap.testFlows ? snap.testFlows.map(f => ({ ...f })) : undefined;
  task.version = newVersion;
  task.updatedAt = new Date().toISOString();

  // Reset testResults
  if (task.testFlows && task.testFlows.length > 0) {
    const flows: Record<string, { pass: boolean; lastRun: string | null }> = {};
    for (const flow of task.testFlows) {
      const slug = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      flows[slug] = { pass: false, lastRun: null };
    }
    task.testResults = { lastRun: null, flows, passRatio: 0 };
  } else {
    task.testResults = { lastRun: null, flows: {}, passRatio: 0 };
  }

  // Clear blocked context
  delete task.bugs;
  delete task.blockedReason;
  delete task.previousState;
  delete task.pendingQuestions;

  fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');

  const actualState = getTaskState(taskDir, taskId) || 'pending';

  appendRunLog(taskDir, {
    timestamp: new Date().toISOString(),
    agentType: 'user',
    sessionId: 'cli',
    agentName: null,
    taskId,
    taskVersion: newVersion,
    taskState: actualState,
    fromState: actualState,
    toState: actualState,
    action: 'rollback',
    description: `User rolled back task '${taskId}' to ${targetVersion} content (new version v${newVersion})`,
    summary: `Restored content from ${targetVersion}. Old v${newVersion - 1} snapshotted. New version: v${newVersion}.`,
    result: 'success',
    duration: 0,
    error: null,
    details: null,
  });

  console.log(`Task '${taskId}' rolled back to ${targetVersion} content. New version: v${newVersion}.`);
  console.log(`Old v${newVersion - 1} snapshotted for audit trail.`);
}