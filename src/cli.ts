#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { initTaskDir, installSkills } from './init';
import { loadConfig } from './core/config';
import { listTasks, getTaskState, getTaskFilePath, moveTask, getNextSeq, getStateDir, validateTransition, getValidTransitions, TaskLockedError } from './core/state';
import { readLock, releaseLock, getTaskLockPath, getInfraLockPath, acquireTaskLock, acquireInfraLock, heartbeatLock, isTaskLocked } from './core/lock';
import { appendRunLog, readTaskLog, readSessionLog, readAllSessionLogs, listSessionFiles } from './core/runlog';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskYaml, TaskState, VALID_STATES, VALID_AGENTS } from './core/types';
import { validateTaskYaml } from './core/validate';
import { editTask } from './edit';
import { answerQuestion } from './commands/answer';
import { deleteTask } from './commands/delete';
import { runDoctor } from './commands/doctor';
import { configGet, configSet, configList } from './commands/config-cmd';
import { listSkills, verifySkills } from './commands/skills';
import { exportTask } from './commands/export';
import { importTask } from './commands/import';
import { cleanDone } from './commands/clean';
import { checkInfrastructure } from './commands/check-infra';
import { diffTask } from './commands/diff';
import { rollbackTask } from './commands/rollback';
import { worktreeCreate, worktreeRemove, worktreeList } from './commands/worktree';
import { mergeTaskBranch } from './commands/merge';
import { revertTaskMerge } from './commands/revert-merge';
import { commitTask } from './commands/commit';
import { cleanupWorktrees } from './commands/cleanup-worktrees';
import { recoverStuckTasks } from './commands/recover';
import { updateTaskStatus } from './commands/status-update';
import { testFail, resetBounceCount } from './commands/test-fail';
import { buildSnapshot, readSnapshot, writeSnapshot, computeDiff, formatReport, getNotifierStatePath } from './core/notifier';
import { appendNotifierLog } from './core/runlog';

const program = new Command();

/**
 * Helper to reduce repeated "read task → parse → get version → append run log" pattern.
 * Used by user-facing CLI commands (add, move, approve, reject, resolve-blocked, etc.)
 */
function logUserAction(
  taskDir: string,
  action: string,
  taskId: string,
  taskState: string,
  description: string,
  extra?: { summary?: string; details?: string | null; error?: string | null; result?: 'success' | 'failure' | 'stale' | 'skipped'; taskVersion?: number; startTime?: number; fromState?: string; toState?: string }
): void {
  let taskVersion = extra?.taskVersion ?? 0;
  if (extra?.taskVersion === undefined) {
    const filePath = getTaskFilePath(taskDir, taskId);
    if (filePath) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const task = validateTaskYaml(parseYaml(raw));
        taskVersion = task.version || 0;
      } catch {}
    }
  }
  const duration = extra?.startTime ? Math.round((Date.now() - extra.startTime) / 1000) : 0;
  appendRunLog(taskDir, {
    timestamp: new Date().toISOString(),
    agentType: 'user',
    sessionId: 'cli',
    agentName: null,
    taskId,
    taskVersion,
    taskState,
    fromState: extra?.fromState,
    toState: extra?.toState,
    action,
    description,
    summary: extra?.summary,
    result: extra?.result ?? 'success',
    duration,
    error: extra?.error ?? null,
    details: extra?.details ?? null,
  });
}

program
  .name('taskflow')
  .description('Automation task management framework')
  .version('1.0.0');

program
  .command('init')
  .description('Scaffold .tasks/ directory and install skills')
  .option('--no-skills', 'Skip installing agent skills')
  .option('--force', 'Backup existing .tasks/ and re-init from scratch')
  .option('--update-skills', 'Overwrite existing skill files with latest templates')
  .action((options) => {
    const targetDir = process.cwd();
    initTaskDir(targetDir, { force: options.force });
    if (options.skills !== false) {
      installSkills(targetDir, { updateSkills: options.updateSkills });
    }
  });

program
  .command('add <name>')
  .description('Create a new task in defined/')
  .option('-d, --description <text>', 'Task description')
  .option('-i, --implementation-notes <text>', 'Implementation notes')
  .option('-t, --test-flows <json>', 'Test flows (JSON array)')
  .action((name: string, options: { description?: string; implementationNotes?: string; testFlows?: string }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const now = new Date();
    const datePrefix = now.toISOString().slice(0, 10);
    const seq = getNextSeq(taskDir, datePrefix);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `${datePrefix}_${slug}_${seq.toString().padStart(3, '0')}`;
    const filename = `${id}.yaml`;

    let testFlows: { name: string; environment?: string; steps: string }[] | undefined;
    if (options.testFlows) {
      try {
        testFlows = JSON.parse(options.testFlows);
      } catch {
        console.error('Invalid JSON for --test-flows');
        process.exit(1);
      }
    }

    const task: TaskYaml = {
      id,
      name,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 1,
      description: options.description || '',
      implementationNotes: options.implementationNotes,
      testFlows,
      testResults: {
        lastRun: null,
        flows: {},
        passRatio: 0.0,
      },
    };

    const destPath = path.join(taskDir, 'defined', filename);
    fs.writeFileSync(destPath, stringifyYaml(task), 'utf-8');

    logUserAction(taskDir, 'add', id, 'defined', `User created task '${id}'`, { taskVersion: 1 });

    console.log(`Task created: .tasks/defined/${filename}`);
    if (!options.description) {
      console.log(`Next: npx taskflow edit ${id} -d "..." to add details, then npx taskflow move ${id} pending`);
    } else {
      console.log(`Next: npx taskflow move ${id} pending to make it available for executor`);
    }
  });

program
  .command('list')
  .description('List tasks by state')
  .argument('[state]', 'Filter by state (defined, pending, processing, testing, review, done, blocked)')
  .option('--json', 'Output as JSON array')
  .option('--quiet', 'Output only task IDs (one per line)')
  .action((state?: string, options?: { json?: boolean; quiet?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    if (state && !VALID_STATES.includes(state as TaskState)) {
      console.error(`Invalid state '${state}'. Valid: ${VALID_STATES.join(', ')}`);
      process.exit(1);
    }
    const validState = state as TaskState | undefined;
    const tasks = listTasks(taskDir, validState);

    if (tasks.length === 0) {
      if (options?.json) { console.log('[]'); return; }
      console.log('No tasks found.');
      return;
    }

    if (options?.quiet) {
      for (const t of tasks) console.log(t.id);
      return;
    }

    // Enrich tasks with name+version for JSON output
    const enriched = tasks.map(t => {
      const filePath = path.join(taskDir, t.state, t.filename);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const task = validateTaskYaml(parseYaml(raw));
        return { id: t.id, state: t.state, name: task.name, version: task.version, passRatio: t.state === 'testing' ? task.testResults?.passRatio : undefined };
      } catch {
        return { id: t.id, state: t.state, name: '(parse error)', version: 0 };
      }
    });

    if (options?.json) {
      console.log(JSON.stringify(enriched, null, 2));
      return;
    }

    const grouped = new Map<TaskState, typeof enriched>();
    for (const t of enriched) {
      const list = grouped.get(t.state) || [];
      list.push(t);
      grouped.set(t.state, list);
    }

    for (const [st, items] of grouped) {
      console.log(`\n=== ${st.toUpperCase()} (${items.length} tasks) ===`);
      for (const item of items) {
        let extra = ` | ${item.name} | v${item.version}`;
        if (st === 'testing' && item.passRatio !== undefined) {
          extra += ` | passRatio: ${item.passRatio}`;
        }
        console.log(`  ${item.id}${extra}`);
      }
    }
  });

program
  .command('status <id>')
  .description('Show detailed info about a task')
  .option('--full', 'Show full description and blockedReason without truncation')
  .action((id: string, options: { full?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const filePath = getTaskFilePath(taskDir, id);
    if (!filePath) {
      console.error(`Task '${id}' not found.`);
      process.exit(1);
    }
    const state = getTaskState(taskDir, id);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const task = validateTaskYaml(parseYaml(raw));
    const lock = readLock(getTaskLockPath(taskDir, id));

    console.log(`ID: ${task.id}`);
    console.log(`Name: ${task.name}`);
    console.log(`State: ${state}`);
    console.log(`Version: ${task.version}`);
    console.log(`Created: ${task.createdAt}`);
    console.log(`Updated: ${task.updatedAt}`);
    const desc = task.description || '';
    const displayDesc = (options.full || desc.length <= 100) ? desc : desc.slice(0, 100) + '...';
    console.log(`Description: ${displayDesc}`);
    if (task.testResults) {
      console.log(`passRatio: ${task.testResults.passRatio}`);
    }
    // Execution status fields
    if (task.statusDescription) {
      console.log(`Status: ${task.statusDescription}`);
    }
    if (task.lastAgentSummary) {
      const s = task.lastAgentSummary;
      const displayS = (options.full || s.length <= 200) ? s : s.slice(0, 200) + '...';
      console.log(`Last summary: ${displayS}`);
    }
    if (task.lastAgentAction) {
      console.log(`Last action: ${task.lastAgentAction} at ${task.lastAgentActionAt || '?'}`);
    }
    if (task.lastAgentType) {
      console.log(`Last agent: ${task.lastAgentType}`);
    }
    if (task.attemptCount !== undefined && task.attemptCount > 0) {
      console.log(`Attempts: ${task.attemptCount}`);
    }
    if (task.bounceCount !== undefined && task.bounceCount > 0) {
      const config = loadConfig(taskDir);
      const maxB = config.test.maxBounces ?? 3;
      console.log(`Bounces: ${task.bounceCount}/${maxB}`);
    }
    if (lock) {
      console.log(`Locked by: ${lock.sessionId} (${lock.agentType})`);
      console.log(`Heartbeat: ${lock.heartbeatAt}`);
    }
    if (task.blockedReason) {
      const br = task.blockedReason;
      const displayBr = (options.full || br.length <= 200) ? br : br.slice(0, 200) + '...';
      console.log(`Blocked: ${displayBr}`);
    }
    if (task.bugs && task.bugs.length > 0) {
      console.log(`Bugs (${task.bugs.length}):`);
      for (const bug of task.bugs) {
        console.log(`  - ${bug.flow}: ${bug.description.slice(0, 100)}`);
      }
    }
  });

program
  .command('move <id> <state>')
  .description('Move a task to another state (from defined, pending, or blocked only by default)')
  .option('--force', 'Override lock check and state transition rules (use with caution)')
  .option('--user', 'Confirm this is a user action (required when --force and target is "done")')
  .action((id: string, state: string, options: { force?: boolean; user?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);
    const currentState = getTaskState(taskDir, id);
    if (!currentState) {
      console.error(`Task '${id}' not found.`);
      process.exit(1);
    }
    // Guard: moving to 'done' with --force requires --user flag
    // This prevents agents from auto-approving tasks
    if (options.force && state === 'done' && !options.user) {
      console.error("Moving a task to 'done' with --force requires the --user flag.");
      console.error("Agents MUST NOT move tasks to done — only the user can approve tasks.");
      console.error("If you are a user, run: npx taskflow move <id> done --force --user");
      process.exit(1);
    }
    // Guard: moving to 'review' requires passRatio >= passRatioRequired
    // This prevents testers from moving untested/failed tasks to review
    // --force bypasses this, but agents should NOT use --force for this purpose
    if (state === 'review' && !options.force) {
      const filePath = getTaskFilePath(taskDir, id);
      if (filePath) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const task = validateTaskYaml(parseYaml(raw));
          const passRatio = task.testResults?.passRatio ?? 0;
          const required = config.test.passRatioRequired;
          if (passRatio < required) {
            console.error(`Task '${id}' cannot be moved to review: passRatio ${passRatio} < required ${required}.`);
            console.error(`Run tests first. If tests fail, use 'npx taskflow test-fail <id>' instead.`);
            console.error('Use --force to override (NOT recommended for agents — this allows untested tasks into review).');
            process.exit(1);
          }
        } catch (e: any) {
          console.error(`Cannot read task '${id}': ${e.message}`);
          process.exit(1);
        }
      }
    }
    if (!options.force) {
      if (config.user.allowMoveFromStates.length > 0 && !config.user.allowMoveFromStates.includes(currentState)) {
        console.error(`Task '${id}' is in '${currentState}'. Move is only allowed from: ${config.user.allowMoveFromStates.join(', ')}.`);
        console.error('Use --force to override.');
        process.exit(1);
      }
      if (!validateTransition(currentState, state as TaskState, 'user')) {
        const valid = getValidTransitions(currentState, 'user');
        console.error(`Invalid transition: ${currentState} → ${state} (actor: user).`);
        console.error(`Valid transitions from '${currentState}' for user: ${valid.length > 0 ? valid.join(', ') : '(none — terminal state)'}`);
        console.error('Use --force to override.');
        process.exit(1);
      }
    }
    if (!VALID_STATES.includes(state as TaskState)) {
      console.error(`Invalid state '${state}'. Valid: ${VALID_STATES.join(', ')}`);
      process.exit(1);
    }
    try {
      if (moveTask(taskDir, id, state as TaskState, { force: options.force })) {
        logUserAction(taskDir, 'move', id, currentState, `User moved task '${id}' from ${currentState} to ${state}${options.force ? ' (forced)' : ''}${options.user ? ' (user-confirmed)' : ''}`, {
          fromState: currentState,
          toState: state,
        });
        console.log(`Task '${id}' moved to ${state}.`);
      } else {
        console.error(`Failed to move task '${id}'.`);
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof TaskLockedError) {
        console.error(`Task '${id}' is locked. Use --force to override.`);
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command('status-update <id>')
  .description('Update the execution status of a task (for agent use). Updates statusDescription, lastAgentSummary, etc.')
  .option('-s, --status <text>', 'Current working status description')
  .option('-S, --summary <text>', 'Natural language summary of what the agent did')
  .option('-a, --action <text>', 'Last action performed (e.g. pickup, implement-start, test-flow-pass)')
  .option('-t, --agent-type <type>', 'Agent type (executor|tester)')
  .option('-n, --agent-name <text>', 'Agent name/ID for run log')
  .option('--inc-attempt', 'Increment attemptCount')
  .action((id: string, options: { status?: string; summary?: string; action?: string; agentType?: string; agentName?: string; incAttempt?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    updateTaskStatus(taskDir, id, {
      statusDescription: options.status,
      lastAgentSummary: options.summary,
      lastAgentAction: options.action,
      lastAgentType: options.agentType as 'executor' | 'tester' | undefined,
      agentName: options.agentName,
      incAttempt: options.incAttempt,
    });
  });

program
  .command('recover')
  .description('Recover stuck tasks: find tasks in processing/testing with no lock or stale lock and move them to pending')
  .option('--dry-run', 'List tasks that would be recovered without moving them')
  .action((options: { dryRun?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    recoverStuckTasks(taskDir, { dryRun: options.dryRun });
  });

program
  .command('test-fail <id>')
  .description('Report a test failure. Auto-increments bounceCount, auto-blocks if maxBounces exceeded or same bugs detected.')
  .option('-r, --reason <text>', 'Reason for test failure')
  .option('-n, --agent-name <text>', 'Agent name/ID for run log')
  .action((id: string, options: { reason?: string; agentName?: string }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    testFail(taskDir, id, {
      reason: options.reason,
      agentName: options.agentName,
    });
  });

program
  .command('approve <id>')
  .description('Move task from review to done — USER ONLY, agents must NOT call this')
  .option('--user', 'Confirm this is a user action (required to prevent agents from auto-approving)')
  .action((id: string, options: { user?: boolean }) => {
    // Guard: approve requires --user flag to prevent agents from auto-approving
    if (!options.user) {
      console.error("The 'approve' command requires the --user flag.");
      console.error("Agents MUST NOT approve tasks — only the user can approve tasks.");
      console.error("If you are a user, run: npx taskflow approve <id> --user");
      process.exit(1);
    }
    const taskDir = path.join(process.cwd(), '.tasks');
    const state = getTaskState(taskDir, id);
    if (state !== 'review') {
      console.error(`Task '${id}' is not in review (current: ${state}).`);
      process.exit(1);
    }
    // Reset bounceCount and update statusDescription before approving
    const filePath = getTaskFilePath(taskDir, id);
    if (filePath) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const task = validateTaskYaml(parseYaml(raw));
        task.bounceCount = 0;
        task.previousBugs = undefined;
        task.statusDescription = 'Approved and moved to done';
        task.updatedAt = new Date().toISOString();
        fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');
      } catch {}
    }
    try {
      if (moveTask(taskDir, id, 'done')) {
        logUserAction(taskDir, 'approve', id, 'review', `User approved task '${id}'`, {
          summary: 'Task approved. Bounce count reset.',
          fromState: 'review',
          toState: 'done',
        });
        console.log(`Task '${id}' approved and moved to done.`);
      } else {
        console.error(`Failed to move task '${id}'.`);
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof TaskLockedError) {
        console.error(`Task '${id}' is locked. Use 'taskflow unlock ${id}' first.`);
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command('reject <id>')
  .description('Move task from review back to pending')
  .option('-r, --reason <text>', 'Reason for rejection (written into blockedReason)')
  .action((id: string, options: { reason?: string }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const state = getTaskState(taskDir, id);
    if (state !== 'review') {
      console.error(`Task '${id}' is not in review (current: ${state}).`);
      process.exit(1);
    }
    let blockedReason: string | undefined;
    let taskVersion = 0;
    const filePath = getTaskFilePath(taskDir, id);
    if (filePath) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const task = validateTaskYaml(parseYaml(raw));
        taskVersion = task.version || 0;
        if (options.reason) {
          task.blockedReason = options.reason;
        }
        task.statusDescription = `Rejected: ${options.reason || 'no reason given'}`;
        task.updatedAt = new Date().toISOString();
        fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');
        blockedReason = options.reason;
      } catch {}
    }
    try {
      if (moveTask(taskDir, id, 'pending')) {
        logUserAction(taskDir, 'reject', id, 'review', `User rejected task '${id}'${blockedReason ? `: ${blockedReason}` : ''}`, {
          taskVersion,
          summary: blockedReason ? `Rejection reason: ${blockedReason}` : undefined,
          fromState: 'review',
          toState: 'pending',
        });
        console.log(`Task '${id}' rejected and moved to pending.${blockedReason ? ` Reason: ${blockedReason}` : ''}`);
      } else {
        console.error(`Failed to move task '${id}'.`);
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof TaskLockedError) {
        console.error(`Task '${id}' is locked. Use 'taskflow unlock ${id}' first.`);
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command('unlock')
  .description('Force release a lock. Without args: release infra lock. With <id>: release task lock. With --all: release all locks.')
  .argument('[id]', 'Task ID to unlock (omit for infra lock)')
  .option('--all', 'Release all locks')
  .action((id?: string, options?: { all?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const opts = options || { all: false };

    if (opts.all) {
      const locksDir = path.join(taskDir, 'locks');
      if (fs.existsSync(locksDir)) {
        const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.lock'));
        for (const f of files) {
          releaseLock(path.join(locksDir, f));
          console.log(`Released: ${f}`);
        }
      }
      return;
    }

    if (id) {
      const lockPath = getTaskLockPath(taskDir, id);
      if (fs.existsSync(lockPath)) {
        releaseLock(lockPath);
        console.log(`Released lock for task '${id}'.`);
      } else {
        console.log(`No lock found for task '${id}'.`);
      }
      return;
    }

    const infraLockPath = getInfraLockPath(taskDir);
    if (fs.existsSync(infraLockPath)) {
      releaseLock(infraLockPath);
      console.log('Released infra lock.');
    } else {
      console.log('No infra lock found.');
    }
  });

program
  .command('lock <id>')
  .description('Acquire a task lock or infra lock (for agent use). Prints the lock YAML on success, exits 1 if already locked.')
  .option('--infra', 'Acquire the infra lock instead of a task lock')
  .option('--agent <type>', 'Agent type for task lock (executor|tester)', 'executor')
  .action((id: string, options: { infra?: boolean; agent?: string }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    if (options.infra) {
      const lock = acquireInfraLock(taskDir);
      if (lock) {
        console.log(stringifyYaml(lock));
      } else {
        console.error('Infra lock is already held.');
        process.exit(1);
      }
      return;
    }
    const agentType = (options.agent === 'tester' ? 'tester' : 'executor') as 'executor' | 'tester';
    // read task version for lock
    const filePath = getTaskFilePath(taskDir, id);
    if (!filePath) {
      console.error(`Task '${id}' not found.`);
      process.exit(1);
    }
    let taskVersion = 0;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const task = validateTaskYaml(parseYaml(raw));
      taskVersion = task.version || 0;
    } catch {}
    const lock = acquireTaskLock(taskDir, id, taskVersion, agentType);
    if (lock) {
      console.log(stringifyYaml(lock));
    } else {
      console.error(`Task '${id}' is already locked by another session.`);
      process.exit(1);
    }
  });

program
  .command('heartbeat <id>')
  .description('Update the heartbeat on a task or infra lock (for agent use).')
  .option('--infra', 'Heartbeat the infra lock instead of a task lock')
  .action((id: string, options: { infra?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const lockPath = options.infra ? getInfraLockPath(taskDir) : getTaskLockPath(taskDir, id);
    if (!fs.existsSync(lockPath)) {
      console.error(`No ${options.infra ? 'infra' : `task '${id}'`} lock found.`);
      process.exit(1);
    }
    heartbeatLock(lockPath);
    console.log(`Heartbeat updated for ${options.infra ? 'infra lock' : `task '${id}'`}.`);
  });

program
  .command('edit <id>')
  .description('Edit a task (always creates new version snapshot)')
  .option('-d, --description <text>', 'New description')
  .option('-i, --implementation-notes <text>', 'New implementation notes')
  .option('-t, --test-flows <json>', 'New test flows (JSON array)')
  .option('-c, --change-description <text>', 'Reason for this edit (stored in version snapshot)')
  .option('--force', 'Override lock check (use with caution)')
  .action((id: string, options: { description?: string; implementationNotes?: string; testFlows?: string; changeDescription?: string; force?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    let testFlows: { name: string; environment?: string; steps: string }[] | undefined;
    if (options.testFlows) {
      try {
        testFlows = JSON.parse(options.testFlows);
      } catch {
        console.error('Invalid JSON for --test-flows');
        process.exit(1);
      }
    }
    try {
      editTask(taskDir, id, {
        description: options.description,
        implementationNotes: options.implementationNotes,
        testFlows,
        changeDescription: options.changeDescription,
      }, { force: options.force });
    } catch (err) {
      if (err instanceof TaskLockedError) {
        console.error(`Task '${id}' is locked by another session. Use --force to override.`);
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command('runs')
  .description('View run logs organized by session or task')
  .option('--task <id>', 'View run log for a specific task')
  .option('--session <id>', 'View run log for a specific session')
  .option('--agent <type>', 'Filter by agent type (executor|tester|user|lock-releaser)')
  .option('--since <date>', 'Only show entries at or after this ISO date')
  .option('--grep <pattern>', 'Only show entries matching this text pattern')
  .option('--result <type>', 'Filter by result (success|failure|stale|skipped)')
  .option('--limit <n>', 'Limit number of entries shown (default 50)')
  .action((options: { task?: string; session?: string; agent?: string; since?: string; grep?: string; result?: string; limit?: string }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);
    if (!config.runLog.enabled) {
      console.log('Run log is disabled in config.');
      return;
    }

    if (options.agent && !(VALID_AGENTS as readonly string[]).includes(options.agent)) {
      console.error(`Invalid agent '${options.agent}'. Valid: ${VALID_AGENTS.join(', ')}`);
      process.exit(1);
    }

    const validResults = ['success', 'failure', 'stale', 'skipped'];
    if (options.result && !validResults.includes(options.result)) {
      console.error(`Invalid result '${options.result}'. Valid: ${validResults.join(', ')}`);
      process.exit(1);
    }

    const sinceDate = options.since ? new Date(options.since) : null;
    if (options.since && Number.isNaN(sinceDate!.getTime())) {
      console.error(`Invalid --since date: '${options.since}'. Use ISO format, e.g. 2026-07-08.`);
      process.exit(1);
    }

    const limit = options.limit ? parseInt(options.limit, 10) : 50;

    function filterContent(content: string): string {
      if (!content) return '';
      // Split into entries (each entry starts with ### )
      const entries = content.split(/(?=^### )/m).filter(e => e.trim());
      let filtered = entries;
      if (sinceDate) {
        filtered = filtered.filter(e => {
          const tsMatch = e.match(/^### (\S+)/);
          if (!tsMatch) return false;
          const ts = new Date(tsMatch[1]);
          return !Number.isNaN(ts.getTime()) && ts >= sinceDate!;
        });
      }
      if (options.grep) {
        const pattern = options.grep;
        filtered = filtered.filter(e => e.includes(pattern));
      }
      if (options.result) {
        filtered = filtered.filter(e => e.includes(`**Result:** ${options.result}`));
      }
      return filtered.slice(-limit).join('');
    }

    if (options.task) {
      const content = readTaskLog(taskDir, options.task);
      const filtered = filterContent(content);
      if (!filtered) {
        console.log(`No run log entries found for task '${options.task}'.`);
        return;
      }
      console.log(`=== Task: ${options.task} ===\n`);
      console.log(filtered);
      return;
    }

    if (options.session) {
      const content = readSessionLog(taskDir, options.session);
      const filtered = filterContent(content);
      if (!filtered) {
        console.log(`No run log entries found for session '${options.session}'.`);
        return;
      }
      console.log(`=== Session: ${options.session} ===\n`);
      console.log(filtered);
      return;
    }

    const sessions = listSessionFiles(taskDir);
    if (sessions.length === 0) {
      console.log('No run log entries found.');
      return;
    }

    if (options.agent) {
      let content = readAllSessionLogs(taskDir, options.agent);
      content = filterContent(content);
      if (!content) {
        console.log(`No run log entries found for agent '${options.agent}'.`);
        return;
      }
      console.log(`=== Agent: ${options.agent} ===\n`);
      console.log(content);
      return;
    }

    console.log('Recent sessions:\n');
    for (const s of sessions.slice(0, 10)) {
      console.log(`  ${s.name} (modified: ${new Date(s.mtime).toISOString()})`);
    }
    console.log(`\nUse --session <id>, --task <id>, or --agent <type> to view details.`);
    console.log('Filters: --since <date>, --grep <pattern>, --result <type>, --limit <n>');
  });

program
  .command('setup-custom')
  .description('Show instructions for configuring custom instructions for executor or tester')
  .argument('<agent>', 'executor or tester')
  .action((agent: string) => {
    if (agent !== 'executor' && agent !== 'tester') {
      console.error("Agent must be 'executor' or 'tester'.");
      process.exit(1);
    }
    console.log(`To set up custom instructions for ${agent}:`);
    console.log(`1. Edit .tasks/config.yaml`);
    console.log(`2. Under '${agent}:', update 'customInstructions' with your guidance`);
    console.log(`3. Add custom skills under 'customSkills:'`);
    console.log(`4. Add custom tools under 'customTools:'`);
    console.log(`\nThe agent will read these when running the ${agent} skill.`);
    console.log(`\nExample:`);
    console.log(`  ${agent}:`);
    console.log(`    customInstructions: |`);
    console.log(`      Use brainstorming skill before implementing`);
    console.log(`      Reference docs/design before writing code`);
    console.log(`    customSkills:`);
    console.log(`      - name: "my-skill"`);
     console.log(`        path: ".agents/skills/my-skill/SKILL.md"`);
     console.log(`    customTools: []`);
  });

program
  .command('answer <id> <questionId> <text>')
  .description('Answer a pending question on a blocked task (B1)')
  .action((id: string, questionId: string, text: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    answerQuestion(taskDir, id, questionId, text);
  });

program
  .command('delete <id>')
  .description('Archive a task (move to .tasks/archive/ with a deletion note) (B2)')
  .action((id: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    deleteTask(taskDir, id);
  });

program
  .command('doctor')
  .description('Run health checks on .tasks/ directory, config, locks, and skills (B4)')
  .option('--fix', 'Automatically fix issues (recover stuck tasks, clean orphan locks)')
  .action((options: { fix?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const result = runDoctor(taskDir, { fix: options.fix });
    for (const c of result.checks) {
      const icon = c.status === 'ok' ? '✓' : c.status === 'fail' ? '✗' : '○';
      console.log(`  ${icon} ${c.name}: ${c.message}`);
    }
    if (!result.ok) {
      console.error('\nSome checks failed.');
      process.exit(1);
    } else {
      console.log('\nAll critical checks passed.');
    }
  });

program
  .command('config [action] [key] [value]')
  .description('Get/set/list config values (E7). e.g. config get heartbeat.staleThresholdSeconds')
  .action((action?: string, key?: string, value?: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    if (!action || action === 'list') {
      configList(taskDir);
    } else if (action === 'get') {
      if (!key) { console.error('Usage: taskflow config get <key>'); process.exit(1); }
      configGet(taskDir, key);
    } else if (action === 'set') {
      if (!key || value === undefined) { console.error('Usage: taskflow config set <key> <value>'); process.exit(1); }
      configSet(taskDir, key, value);
    } else {
      console.error(`Unknown action '${action}'. Use: list, get, set`);
      process.exit(1);
    }
  });

program
  .command('skills [action]')
  .description('List or verify installed agent skills (E9)')
  .action((action?: string) => {
    const targetDir = process.cwd();
    if (!action || action === 'list') {
      listSkills(targetDir);
    } else if (action === 'verify') {
      verifySkills(targetDir);
    } else {
      console.error(`Unknown action '${action}'. Use: list, verify`);
      process.exit(1);
    }
  });

program
  .command('export <id>')
  .description('Export a task to JSON or YAML on stdout (B10)')
  .option('-f, --format <format>', 'Output format: json or yaml', 'json')
  .action((id: string, options: { format?: string }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const fmt = (options.format === 'yaml' ? 'yaml' : 'json') as 'json' | 'yaml';
    exportTask(taskDir, id, fmt);
  });

program
  .command('import <file>')
  .description('Import a task from a JSON or YAML file into .tasks/defined/ (B10)')
  .action((file: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    importTask(taskDir, file);
  });

program
  .command('clean')
  .description('Archive done tasks (move to .tasks/archive/) (B9)')
  .option('--before <date>', 'Only archive tasks updated before this ISO date')
  .option('--dry-run', 'List tasks that would be archived without moving them')
  .action((options: { before?: string; dryRun?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    cleanDone(taskDir, options);
  });

program
  .command('check-infra [env]')
  .description('Check infrastructure services for an environment (H4)')
  .action(async (env?: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    await checkInfrastructure(taskDir, env);
  });

program
  .command('diff <id> [v1] [v2]')
  .description('Show diff between two versions of a task (H2). Without args: latest snapshot vs current.')
  .action((id: string, v1?: string, v2?: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    diffTask(taskDir, id, v1, v2);
  });

program
  .command('rollback <id> <version>')
  .description('Rollback a task to a previous version snapshot (creates a new version) (H2)')
  .action((id: string, version: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    rollbackTask(taskDir, id, version);
  });

program
  .command('worktree <action> [id]')
  .description('Manage worktrees (create|remove|list) for git flow')
  .action((action: string, id?: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);
    if (action === 'list') {
      worktreeList(taskDir, config.gitFlow);
    } else if (action === 'create') {
      if (!id) { console.error('Usage: taskflow worktree create <id>'); process.exit(1); }
      worktreeCreate(taskDir, id, config.gitFlow);
    } else if (action === 'remove') {
      if (!id) { console.error('Usage: taskflow worktree remove <id>'); process.exit(1); }
      worktreeRemove(taskDir, id, config.gitFlow);
    } else {
      console.error(`Unknown action '${action}'. Use: create, remove, list`);
      process.exit(1);
    }
  });

program
  .command('merge <id>')
  .description('Merge the task worktree branch into baseBranch (git flow)')
  .action((id: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);
    mergeTaskBranch(taskDir, id, config.gitFlow);
  });

program
  .command('revert-merge <id>')
  .description('Revert the last merge commit for a task (git flow)')
  .action((id: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);
    revertTaskMerge(taskDir, id, config.gitFlow);
  });

program
  .command('commit <id>')
  .description('Commit all changes in the task worktree with conventional commit message (git flow)')
  .option('-m, --message <text>', 'Commit message')
  .action((id: string, options: { message?: string }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);
    if (!options.message) { console.error('Usage: taskflow commit <id> -m "<message>"'); process.exit(1); }
    commitTask(taskDir, id, options.message, config.gitFlow);
  });

program
  .command('cleanup-worktrees')
  .description('Remove worktrees for done/blocked tasks and orphan worktrees (git flow)')
  .action(() => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);
    cleanupWorktrees(taskDir, config.gitFlow);
  });

program
  .command('resolve-blocked')
  .description('List blocked tasks with pending questions and resolve them')
  .argument('[id]', 'Specific task ID to resolve')
  .action((id?: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const tasks = id
      ? listTasks(taskDir, 'blocked').filter((t: { id: string }) => t.id === id)
      : listTasks(taskDir, 'blocked');

    if (tasks.length === 0) {
      console.log('No blocked tasks found.');
      return;
    }

    for (const t of tasks) {
      const filePath = getTaskFilePath(taskDir, t.id);
      if (!filePath) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const task = validateTaskYaml(parseYaml(raw));
        console.log(`\n=== ${t.id} (blocked, was: ${task.previousState || 'unknown'}) ===`);
        console.log(`Name: ${task.name}`);
        console.log(`Description: ${task.description?.slice(0, 200)}`);
        if (task.pendingQuestions && task.pendingQuestions.length > 0) {
          const unanswered = task.pendingQuestions.filter(q => !q.answered);
          if (unanswered.length > 0) {
            console.log(`\nQuestions (${unanswered.length}):`);
            for (const q of unanswered) {
              console.log(`  [${q.id}] Category: ${q.category}`);
              console.log(`  Asked by ${q.askedBy} at ${q.askedAt}`);
              console.log(`  Question: ${q.question}`);
              if (q.context) console.log(`  Context: ${q.context}`);
              console.log();
            }
            console.log(`To resolve: edit the task YAML and set answered: true with your answer.`);
            console.log(`Then run: npx taskflow resolve-blocked ${t.id}`);
            continue;
          }
        }
        // All questions answered (or none) — attempt unblock
        const prevState: TaskState = (task.previousState as TaskState) || 'pending';
        // A4: validate transition before moving
        if (!validateTransition('blocked', prevState, 'user')) {
          console.error(`Cannot unblock: previousState '${prevState}' is not a valid transition from 'blocked' (actor: user). Valid: processing, testing, pending.`);
          continue;
        }
        const summary = (task.pendingQuestions && task.pendingQuestions.length > 0)
          ? `All pending questions answered. Task moved from blocked back to ${prevState}.`
          : `No pending questions present. Task moved from blocked back to ${prevState}.`;
        const desc = (task.pendingQuestions && task.pendingQuestions.length > 0)
          ? `User resolved blocked task '${t.id}', moved back to ${prevState}`
          : `User unblocked task '${t.id}' (no pending questions), moved back to ${prevState}`;
        try {
          // Update statusDescription and reset bounceCount before moving
          task.statusDescription = `Unblocked, moved back to ${prevState}`;
          task.bounceCount = 0;
          task.previousBugs = undefined;
          task.updatedAt = new Date().toISOString();
          fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');

          if (moveTask(taskDir, t.id, prevState)) {
            logUserAction(taskDir, 'resolve-blocked', t.id, 'blocked', desc, {
              taskVersion: task.version,
              summary,
              fromState: 'blocked',
              toState: prevState,
            });
            console.log(`Task '${t.id}' moved back to ${prevState}.`);
          }
        } catch (err) {
          if (err instanceof TaskLockedError) {
            console.error(`Task '${t.id}' is locked. Use 'taskflow unlock ${t.id}' first.`);
          } else {
            throw err;
          }
        }
      } catch {}
    }
  });

program
  .command('notify')
  .description('Run one notifier check cycle — detect task state changes and notify through enabled channels')
  .option('--dry-run', 'Show report without sending to channels')
  .option('--reset', 'Clear snapshot (next run reports all as new)')
  .action((options: { dryRun?: boolean; reset?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);

    if (!config.notification.enabled) {
      console.log('Notifications are disabled in config.');
      return;
    }

    if (options.reset) {
      const statePath = getNotifierStatePath(taskDir);
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
        console.log('Notifier snapshot cleared. Next run will report all tasks as new.');
      } else {
        console.log('No snapshot to clear.');
      }
      return;
    }

    // Build current snapshot
    const currentSnapshot = buildSnapshot(taskDir, config);

    // Read previous snapshot
    const prevSnapshot = readSnapshot(taskDir);

    if (!prevSnapshot) {
      // First run — report all tasks as new
      const report = formatReport({
        transitions: [],
        newTasks: Object.values(currentSnapshot.tasks).map(t => ({
          taskId: t.id, name: t.name, state: t.state,
        })),
        removedTasks: [],
        newlyBlocked: [],
        bounceThresholdHit: [],
        staleLocks: [],
        versionBumps: [],
        resolvedBlocks: [],
      }, currentSnapshot, config);

      if (options.dryRun) {
        console.log(report);
        return;
      }

      // Send through all enabled channels
      for (const channel of config.notification.channels) {
        if (!channel.enabled) continue;
        if (channel.type === 'console') {
          console.log(report);
        } else if (channel.type === 'file' && channel.path) {
          fs.appendFileSync(path.join(taskDir, channel.path), `\n## ${new Date().toISOString()}\n${report}\n`, 'utf-8');
        }
      }

      // Log
      appendNotifierLog(taskDir, `- First run: ${Object.keys(currentSnapshot.tasks).length} tasks found\n- Sent initial report through console, file`);
      appendRunLog(taskDir, {
        timestamp: new Date().toISOString(),
        agentType: 'notifier',
        sessionId: 'cli',
        agentName: null,
        taskId: '(all)',
        taskVersion: 0,
        taskState: '(all)',
        action: 'notify-cycle',
        description: `First notifier run: ${Object.keys(currentSnapshot.tasks).length} tasks found, initial report sent`,
        result: 'success',
        duration: 0,
        error: null,
        details: null,
      });

      writeSnapshot(taskDir, currentSnapshot);
      console.log('Notifier snapshot saved. Next run will detect changes.');
      return;
    }

    // Compute diff
    const diff = computeDiff(prevSnapshot, currentSnapshot, config);

    // Check if anything changed
    const hasChanges = diff.transitions.length > 0 || diff.newTasks.length > 0 ||
      diff.removedTasks.length > 0 || diff.newlyBlocked.length > 0 ||
      diff.bounceThresholdHit.length > 0 || diff.staleLocks.length > 0 ||
      diff.versionBumps.length > 0 || diff.resolvedBlocks.length > 0;

    if (!hasChanges && !config.notification.reportOnNoChange) {
      // Nothing changed — just update snapshot
      writeSnapshot(taskDir, currentSnapshot);
      return;
    }

    // Format report
    const report = formatReport(diff, currentSnapshot, config);

    if (options.dryRun) {
      console.log(report);
      return;
    }

    // Send through all enabled channels
    for (const channel of config.notification.channels) {
      if (!channel.enabled) continue;
      if (channel.type === 'console') {
        console.log(report);
      } else if (channel.type === 'file' && channel.path) {
        fs.appendFileSync(path.join(taskDir, channel.path), `\n## ${new Date().toISOString()}\n${report}\n`, 'utf-8');
      }
    }

    // Log
    const changeCount = diff.transitions.length + diff.newTasks.length + diff.removedTasks.length +
      diff.newlyBlocked.length + diff.bounceThresholdHit.length + diff.staleLocks.length +
      diff.versionBumps.length + diff.resolvedBlocks.length;
    appendNotifierLog(taskDir, `- Checked tasks: ${Object.keys(currentSnapshot.tasks).length}\n- Changes detected: ${changeCount}\n- Transitions: ${diff.transitions.length}, New: ${diff.newTasks.length}, Blocked: ${diff.newlyBlocked.length}, Bounces: ${diff.bounceThresholdHit.length}, Stale locks: ${diff.staleLocks.length}, Version bumps: ${diff.versionBumps.length}, Resolved: ${diff.resolvedBlocks.length}`);
    appendRunLog(taskDir, {
      timestamp: new Date().toISOString(),
      agentType: 'notifier',
      sessionId: 'cli',
      agentName: null,
      taskId: '(all)',
      taskVersion: 0,
      taskState: '(all)',
      action: 'notify-cycle',
      description: `Notifier cycle: ${changeCount} changes detected`,
      summary: `${diff.transitions.length} transitions, ${diff.newTasks.length} new, ${diff.newlyBlocked.length} blocked, ${diff.bounceThresholdHit.length} bounces, ${diff.staleLocks.length} stale locks, ${diff.versionBumps.length} version bumps, ${diff.resolvedBlocks.length} resolved`,
      result: 'success',
      duration: 0,
      error: null,
      details: null,
    });

    writeSnapshot(taskDir, currentSnapshot);
  });

try {
  program.parse(process.argv);
} catch (err: any) {
  if (err && err.name === 'CommanderError') {
    // Commander already printed the error
    process.exit(1);
  }
  console.error(`Error: ${err.message || err}`);
  if (process.argv.includes('--debug')) {
    console.error(err.stack);
  }
  process.exit(1);
}