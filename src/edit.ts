import * as fs from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTaskState, getTaskFilePath, moveTask, TaskLockedError } from './core/state';
import { appendRunLog } from './core/runlog';
import { isTaskLocked, isLockStale, getTaskLockPath } from './core/lock';
import { loadConfig } from './core/config';
import { validateTaskYaml } from './core/validate';

export function editTask(
  taskDir: string,
  taskId: string,
  updates: {
    description?: string;
    implementationNotes?: string;
    testFlows?: { name: string; environment?: string; steps: string }[];
  },
  options?: { force?: boolean }
): void {
  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) {
    console.error(`Task '${taskId}' not found.`);
    process.exit(1);
  }

  // A3: check lock before editing (unless --force)
  // Stale locks (heartbeat expired) are treated as unlocked
  if (!options?.force && isTaskLocked(taskDir, taskId)) {
    const config = loadConfig(taskDir);
    const lockPath = getTaskLockPath(taskDir, taskId);
    if (!isLockStale(lockPath, config.heartbeat.staleThresholdSeconds)) {
      throw new TaskLockedError(taskId);
    }
    // Lock is stale — release it so the edit can proceed
    try { fs.unlinkSync(lockPath); } catch {}
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));
  const currentState = getTaskState(taskDir, taskId);

  if (currentState === 'done') {
    console.error("Cannot edit a done task. Create a new task instead.");
    process.exit(1);
  }

  if (currentState === 'review') {
    console.error("Task is in review. Reject it first, then edit.");
    process.exit(1);
  }

  const hasDescription = updates.description !== undefined && updates.description !== task.description;
  const hasImplNotes = updates.implementationNotes !== undefined && updates.implementationNotes !== task.implementationNotes;
  const hasTestFlows = updates.testFlows !== undefined;
  const hasChanges = hasDescription || hasImplNotes || hasTestFlows;

  if (!hasChanges) {
    console.log("No changes detected. Task not modified.");
    return;
  }

  if (currentState === 'processing' || currentState === 'testing') {
    const oldVersion = task.version;
    if (!task.versions) task.versions = {};
    if (!task.versions[`v${oldVersion}`]) {
      task.versions[`v${oldVersion}`] = {
        updatedAt: task.updatedAt,
        description: task.description,
        implementationNotes: task.implementationNotes,
        testFlows: task.testFlows ? task.testFlows.map(f => ({ ...f })) : undefined,
        bounceCount: task.bounceCount,
      };
    }
  }

  if (hasDescription) task.description = updates.description!;
  if (hasImplNotes) task.implementationNotes = updates.implementationNotes;
  if (hasTestFlows) task.testFlows = updates.testFlows;

  task.version += 1;
  task.updatedAt = new Date().toISOString();

  // Reset bounceCount on new version — this is a fresh attempt
  task.bounceCount = 0;
  task.previousBugs = undefined;

  if (task.testFlows && task.testFlows.length > 0) {
    const flows: Record<string, { pass: boolean; lastRun: string | null }> = {};
    for (const flow of task.testFlows) {
      const slug = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      flows[slug] = { pass: false, lastRun: null };
    }
    task.testResults = {
      lastRun: null,
      flows,
      passRatio: 0.0,
    };
  }

  // Preserve bugs and blockedReason — they contain context about what went wrong.
  // Previous behavior deleted them, but that loses valuable information for the
  // next agent session. Only clear blockedReason if the edit is a new description.
  // (Keep bugs[] and blockedReason intact.)

  fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');

  appendRunLog(taskDir, {
    timestamp: new Date().toISOString(),
    agentType: 'user',
    sessionId: 'cli',
    agentName: null,
    taskId,
    taskVersion: task.version,
    taskState: currentState!,
    action: 'edit',
    description: `User edited task '${taskId}' to v${task.version}`,
    result: 'success',
    duration: 0,
    error: null,
    details: null,
  });

  if (currentState === 'processing' || currentState === 'testing') {
    if (!moveTask(taskDir, taskId, 'pending', { force: options?.force })) {
      console.error(`Task '${taskId}' updated to v${task.version} but failed to move to pending. Manual intervention needed.`);
    } else {
      console.log(`Task '${taskId}' updated to v${task.version} and moved to pending.`);
    }
  } else {
    console.log(`Task '${taskId}' updated to v${task.version}.`);
  }
}