import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTaskFilePath, getTaskState, moveTask } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { loadConfig } from '../core/config';
import { validateTaskYaml } from '../core/validate';
import { TaskYaml, Bug } from '../core/types';

export interface TestFailOptions {
  reason?: string;
  bugs?: Bug[];
  agentName?: string;
}

/**
 * Called by the tester when a test fails. Handles bounce detection:
 * 1. Increments bounceCount
 * 2. Detects if the same bugs are repeating (same-bugs detector)
 * 3. If bounceCount >= maxBounces OR same bugs detected → auto-block
 * 4. Otherwise → move to pending for executor re-pickup
 * 5. Updates statusDescription, lastAgentSummary, previousBugs
 * 6. Writes run log
 */
export function testFail(
  taskDir: string,
  taskId: string,
  options: TestFailOptions = {}
): void {
  const config = loadConfig(taskDir);
  const maxBounces = config.test.maxBounces ?? 3;

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

  if (state !== 'testing') {
    console.error(`Task '${taskId}' is not in testing (current: ${state}). test-fail can only be called from testing.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));
  const now = new Date().toISOString();

  // Increment bounceCount
  const newBounceCount = (task.bounceCount || 0) + 1;

  // Same-bugs detector: compare new bugs with previousBugs
  const newBugs = options.bugs || task.bugs || [];
  const previousBugs = task.previousBugs || [];
  const sameBugsDetected = detectSameBugs(newBugs, previousBugs);

  // Determine if auto-block is needed
  const exceededBounces = newBounceCount >= maxBounces;
  const shouldAutoBlock = exceededBounces || sameBugsDetected;

  // Update task fields
  task.bounceCount = newBounceCount;
  task.previousBugs = newBugs.map(b => ({ ...b }));
  task.statusDescription = shouldAutoBlock
    ? `Auto-blocked: ${exceededBounces ? `exceeded ${maxBounces} bounces` : 'same bugs detected'}`
    : `Test failed (bounce ${newBounceCount}/${maxBounces})`;
  task.lastAgentSummary = options.reason || `Test failed. Bounce ${newBounceCount}/${maxBounces}.`;
  task.lastAgentType = 'tester';
  task.lastAgentAction = shouldAutoBlock ? 'test-bounce-blocked' : 'test-fail';
  task.lastAgentActionAt = now;
  task.updatedAt = now;

  if (shouldAutoBlock) {
    // Auto-block
    task.blockedReason = exceededBounces
      ? `Task bounced ${newBounceCount} times (max: ${maxBounces}). Last failure: ${options.reason || 'unspecified'}`
      : `Same bugs detected multiple times. Bugs: ${newBugs.map(b => b.flow).join(', ')}`;
    task.previousState = 'testing';

    // Write updated YAML
    fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');

    // Release lock will be done by tester before calling test-fail
    // Move to blocked
    if (!moveTask(taskDir, taskId, 'blocked', { force: true })) {
      console.error(`Failed to move task '${taskId}' to blocked.`);
      process.exit(1);
    }

    appendRunLog(taskDir, {
      timestamp: now,
      agentType: 'tester',
      sessionId: options.agentName || 'tester',
      agentName: options.agentName || null,
      taskId,
      taskVersion: task.version,
      taskState: 'testing',
      action: 'test-bounce-blocked',
      description: `Auto-blocked task '${taskId}' after ${newBounceCount} bounces${sameBugsDetected ? ' (same bugs detected)' : ''}. Reason: ${options.reason || 'unspecified'}`,
      summary: `Task auto-blocked: ${task.blockedReason}`,
      result: 'success',
      duration: 0,
      error: null,
      details: sameBugsDetected ? `Same bugs as previous cycle: ${newBugs.map(b => b.flow).join(', ')}` : null,
    });

    console.log(`Task '${taskId}' auto-blocked after ${newBounceCount} bounces${sameBugsDetected ? ' (same bugs detected)' : ''}. Moved to blocked.`);
    console.log(`Reason: ${task.blockedReason}`);
  } else {
    // Move to pending for executor re-pickup
    fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');

    if (!moveTask(taskDir, taskId, 'pending', { force: true })) {
      console.error(`Failed to move task '${taskId}' to pending.`);
      process.exit(1);
    }

    appendRunLog(taskDir, {
      timestamp: now,
      agentType: 'tester',
      sessionId: options.agentName || 'tester',
      agentName: options.agentName || null,
      taskId,
      taskVersion: task.version,
      taskState: 'testing',
      action: 'test-fail',
      description: `Test failed for task '${taskId}'. Bounce ${newBounceCount}/${maxBounces}. Moved to pending. Reason: ${options.reason || 'unspecified'}`,
      summary: `Test failed (bounce ${newBounceCount}/${maxBounces}). ${options.reason || ''}`.trim(),
      result: 'success',
      duration: 0,
      error: null,
      details: newBugs.length > 0 ? `Bugs: ${newBugs.map(b => `${b.flow}: ${b.description.slice(0, 80)}`).join('\n')}` : null,
    });

    console.log(`Task '${taskId}' test failed (bounce ${newBounceCount}/${maxBounces}). Moved to pending.`);
    if (maxBounces - newBounceCount <= 1) {
      console.log(`WARNING: Only ${maxBounces - newBounceCount} bounce(s) left before auto-block!`);
    }
  }
}

/**
 * Detect if the same bugs are repeating from the previous test cycle.
 * Compares bug flow names — if ≥1 bug has the same flow, it's a repeat.
 * Even a single recurring bug (e.g. "login fails every time") should trigger.
 */
function detectSameBugs(currentBugs: Bug[], previousBugs: Bug[]): boolean {
  if (currentBugs.length === 0 || previousBugs.length === 0) return false;
  const previousFlows = new Set(previousBugs.map(b => b.flow));
  const matchingCount = currentBugs.filter(b => previousFlows.has(b.flow)).length;
  // Any matching bug is a repeat — even a single recurring bug is significant
  return matchingCount >= 1;
}

/**
 * Reset bounceCount and previousBugs on a task.
 * Called when: task approved, resolve-blocked, edit (new version), test pass.
 */
export function resetBounceCount(taskDir: string, taskId: string): void {
  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) return;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const task = validateTaskYaml(parseYaml(raw));
    task.bounceCount = 0;
    task.previousBugs = undefined;
    task.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');
  } catch {
    // silently ignore — task may have been moved
  }
}