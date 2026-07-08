import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTaskFilePath, moveTask, listTasks } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { getStaleLocks, getTaskLockPath, releaseLock } from '../core/lock';
import { loadConfig } from '../core/config';
import { validateTaskYaml } from '../core/validate';
import { TaskState } from '../core/types';

export interface RecoverOptions {
  dryRun?: boolean;
}

/**
 * Recover stuck tasks:
 * - Find tasks in processing/ or testing/ with no lock file or stale lock
 * - Move them to pending/
 * - Update statusDescription to indicate recovery
 * - Write run log
 */
export function recoverStuckTasks(taskDir: string, options: RecoverOptions = {}): void {
  const config = loadConfig(taskDir);
  const staleThreshold = config.heartbeat.staleThresholdSeconds;

  // Get all stale lock paths
  const staleLocks = getStaleLocks(taskDir, staleThreshold);
  const staleTaskIds = new Set<string>();
  for (const lockPath of staleLocks) {
    const basename = path.basename(lockPath);
    const match = basename.match(/^task-(.+)\.lock$/);
    if (match) staleTaskIds.add(match[1]);
  }

  // Check processing/ and testing/ for tasks that are stuck
  const stuckStates: TaskState[] = ['processing', 'testing'];
  const recovered: { id: string; from: TaskState; reason: string }[] = [];

  for (const state of stuckStates) {
    const tasks = listTasks(taskDir, state);
    for (const t of tasks) {
      const lockPath = getTaskLockPath(taskDir, t.id);
      const lockExists = fs.existsSync(lockPath);
      const isStale = staleTaskIds.has(t.id);

      if (lockExists && !isStale) {
        // Lock exists and is fresh — task is actively being worked on
        continue;
      }

      const reason = lockExists
        ? `stale lock (heartbeat exceeded ${staleThreshold}s threshold)`
        : 'no lock file (abandoned)';

      if (options.dryRun) {
        recovered.push({ id: t.id, from: state, reason });
        continue;
      }

      // Release stale lock if it exists
      if (lockExists) {
        releaseLock(lockPath);
      }

      // Read task YAML to update status and get version before moving
      const filePath = getTaskFilePath(taskDir, t.id);
      if (filePath) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const task = validateTaskYaml(parseYaml(raw));
          task.statusDescription = `Recovered from ${state}: ${reason}`;
          task.lastAgentSummary = `Task was in ${state} with ${reason}. Moved to pending by recover command.`;
          task.lastAgentAction = 'recover-stuck';
          task.lastAgentActionAt = new Date().toISOString();
          // Clear lastAgentType — recovery is by user/CLI, not an agent
          task.lastAgentType = undefined;
          task.updatedAt = new Date().toISOString();
          fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');

          // Move to pending
          if (moveTask(taskDir, t.id, 'pending', { force: true })) {
            recovered.push({ id: t.id, from: state, reason });
            appendRunLog(taskDir, {
              timestamp: new Date().toISOString(),
              agentType: 'user',
              sessionId: 'cli',
              agentName: null,
              taskId: t.id,
              taskVersion: task.version,
              taskState: state,
              fromState: state,
              toState: 'pending',
              action: 'recover-stuck',
              description: `Recovered task '${t.id}' from ${state} to pending. Reason: ${reason}`,
              summary: `Task was stuck in ${state} with ${reason}. Moved to pending for re-pickup.`,
              result: 'success',
              duration: 0,
              error: null,
              details: null,
            });
          } else {
            console.error(`Failed to move task '${t.id}' from ${state} to pending.`);
          }
        } catch {
          // If we can't read the YAML, try to move anyway
          if (moveTask(taskDir, t.id, 'pending', { force: true })) {
            recovered.push({ id: t.id, from: state, reason });
          } else {
            console.error(`Failed to move task '${t.id}' from ${state} to pending.`);
          }
        }
      }
    }
  }

  if (recovered.length === 0) {
    console.log('No stuck tasks found.');
    return;
  }

  if (options.dryRun) {
    console.log(`\n=== DRY RUN — ${recovered.length} task(s) would be recovered ===\n`);
    for (const r of recovered) {
      console.log(`  ${r.id} (${r.from}): ${r.reason}`);
    }
    console.log('\nRun without --dry-run to recover these tasks.');
  } else {
    console.log(`\nRecovered ${recovered.length} task(s):\n`);
    for (const r of recovered) {
      console.log(`  ${r.id} (${r.from} → pending): ${r.reason}`);
    }
  }
}
