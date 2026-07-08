import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTaskFilePath, getTaskState, moveTask } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { isTaskLocked, isLockStale, getTaskLockPath } from '../core/lock';
import { loadConfig } from '../core/config';
import { validateTaskYaml } from '../core/validate';

/**
 * Delete a task by moving it to .tasks/archive/ with a "deleted by user" note.
 * Refuses to delete a locked task (use unlock first). Stale locks are auto-released.
 */
export function deleteTask(taskDir: string, taskId: string): void {
  const state = getTaskState(taskDir, taskId);
  if (!state) {
    console.error(`Task '${taskId}' not found.`);
    process.exit(1);
  }
  if (state === 'done') {
    console.error(`Task '${taskId}' is already done. Use 'taskflow clean' to archive done tasks.`);
    process.exit(1);
  }
  // Stale locks (heartbeat expired) are treated as unlocked
  if (isTaskLocked(taskDir, taskId)) {
    const config = loadConfig(taskDir);
    const lockPath = getTaskLockPath(taskDir, taskId);
    if (!isLockStale(lockPath, config.heartbeat.staleThresholdSeconds)) {
      console.error(`Task '${taskId}' is locked. Run 'taskflow unlock ${taskId}' first.`);
      process.exit(1);
    }
    // Lock is stale — release it so the delete can proceed
    try { fs.unlinkSync(lockPath); } catch {}
  }

  // Ensure archive/ exists
  const archiveDir = path.join(taskDir, 'archive');
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) {
    console.error(`Task '${taskId}' file not found.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));
  task.blockedReason = `Deleted by user at ${new Date().toISOString()}`;
  task.updatedAt = new Date().toISOString();

  const filename = path.basename(filePath);
  const destPath = path.join(archiveDir, filename);
  fs.writeFileSync(destPath, stringifyYaml(task), 'utf-8');
  fs.unlinkSync(filePath);

  appendRunLog(taskDir, {
    timestamp: new Date().toISOString(),
    agentType: 'user',
    sessionId: 'cli',
    agentName: null,
    taskId,
    taskVersion: task.version,
    taskState: state,
    action: 'delete',
    description: `User deleted task '${taskId}' (was in ${state}), moved to archive/`,
    summary: `Task moved from ${state} to archive/. Reason: Deleted by user.`,
    result: 'success',
    duration: 0,
    error: null,
    details: null,
  });

  console.log(`Task '${taskId}' archived (was in ${state}).`);
}