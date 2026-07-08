import * as fs from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTaskFilePath, getTaskState } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { validateTaskYaml } from '../core/validate';

export interface StatusUpdateOptions {
  statusDescription?: string;
  lastAgentSummary?: string;
  lastAgentAction?: string;
  lastAgentType?: 'executor' | 'tester';
  agentName?: string;
  incAttempt?: boolean;
}

/**
 * Update the execution status fields on a task YAML.
 * This does NOT change the task state — it only updates metadata.
 * Writes a run log entry with action 'status-update'.
 */
export function updateTaskStatus(
  taskDir: string,
  taskId: string,
  options: StatusUpdateOptions
): void {
  // Validate agentType
  if (options.lastAgentType !== undefined && options.lastAgentType !== 'executor' && options.lastAgentType !== 'tester') {
    console.error(`--agent-type must be 'executor' or 'tester', got '${options.lastAgentType}'`);
    process.exit(1);
  }

  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) {
    console.error(`Task '${taskId}' not found.`);
    process.exit(1);
  }

  const state = getTaskState(taskDir, taskId);
  if (!state) {
    console.error(`Task '${taskId}' has no state.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));

  const now = new Date().toISOString();
  let changed = false;

  if (options.statusDescription !== undefined) {
    task.statusDescription = options.statusDescription;
    changed = true;
  }
  if (options.lastAgentSummary !== undefined) {
    task.lastAgentSummary = options.lastAgentSummary;
    changed = true;
  }
  if (options.lastAgentAction !== undefined) {
    task.lastAgentAction = options.lastAgentAction;
    changed = true;
  }
  if (options.lastAgentType !== undefined) {
    task.lastAgentType = options.lastAgentType;
    changed = true;
  }
  if (options.incAttempt) {
    task.attemptCount = (task.attemptCount || 0) + 1;
    changed = true;
  }

  // Always update lastAgentActionAt and updatedAt when any status field changes
  if (changed) {
    task.lastAgentActionAt = now;
    task.updatedAt = now;
    fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');
  }

  // Build a description for the run log
  const descParts: string[] = [];
  if (options.statusDescription) descParts.push(`status: ${options.statusDescription}`);
  if (options.lastAgentSummary) descParts.push(`summary: ${options.lastAgentSummary}`);
  if (options.lastAgentAction) descParts.push(`action: ${options.lastAgentAction}`);
  if (options.incAttempt) descParts.push(`attempt #${task.attemptCount}`);

  const description = descParts.length > 0
    ? `Agent updated task '${taskId}': ${descParts.join('; ')}`
    : `Agent updated task '${taskId}' status`;

  // Only write run log if something actually changed
  if (changed) {
    appendRunLog(taskDir, {
      timestamp: now,
      agentType: options.lastAgentType || 'executor',
      sessionId: options.agentName || 'cli',
      agentName: options.agentName || null,
      taskId,
      taskVersion: task.version,
      taskState: state,
      action: 'status-update',
      description,
      summary: options.lastAgentSummary || undefined,
      result: 'success',
      duration: 0,
      error: null,
      details: null,
    });
  }

  if (changed) {
    console.log(`Task '${taskId}' status updated (v${task.version}, ${state}).`);
  } else {
    console.log(`Task '${taskId}' — no status fields to update.`);
  }
}
