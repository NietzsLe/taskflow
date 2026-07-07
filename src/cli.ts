#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { initTaskDir, installSkills } from './init';
import { loadConfig } from './core/config';
import { listTasks, getTaskState, getTaskFilePath, moveTask, getNextSeq, getStateDir, validateTransition } from './core/state';
import { readLock, releaseLock, getTaskLockPath, getInfraLockPath } from './core/lock';
import { appendRunLog, readTaskLog, readSessionLog, readAllSessionLogs, listSessionFiles } from './core/runlog';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskYaml, TaskState } from './core/types';
import { editTask } from './edit';

const VALID_STATES: TaskState[] = ['defined', 'pending', 'processing', 'testing', 'review', 'done'];
const VALID_AGENTS = ['executor', 'tester', 'user', 'lock-releaser'];

const program = new Command();

program
  .name('taskflow')
  .description('Automation task management framework')
  .version('1.0.0');

program
  .command('init')
  .description('Scaffold .tasks/ directory and install skills')
  .option('--no-skills', 'Skip installing agent skills')
  .action((options) => {
    const targetDir = process.cwd();
    initTaskDir(targetDir);
    if (options.skills !== false) {
      installSkills(targetDir);
    }
  });

program
  .command('add <name>')
  .description('Create a new task in pending/')
  .action((name: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const now = new Date();
    const datePrefix = now.toISOString().slice(0, 10);
    const seq = getNextSeq(taskDir, datePrefix);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `${datePrefix}_${slug}_${seq.toString().padStart(3, '0')}`;
    const filename = `${id}.yaml`;

    const task: TaskYaml = {
      id,
      name,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 1,
      description: '',
      testResults: {
        lastRun: null,
        flows: {},
        passRatio: 0.0,
      },
    };

    const destPath = path.join(taskDir, 'defined', filename);
    fs.writeFileSync(destPath, stringifyYaml(task), 'utf-8');

    appendRunLog(taskDir, {
      timestamp: now.toISOString(),
      agentType: 'user',
      sessionId: 'cli',
      agentName: null,
      taskId: id,
      taskVersion: 1,
      taskState: 'defined',
      action: 'add',
      description: `User created task '${id}'`,
      result: 'success',
      duration: 0,
      error: null,
      details: null,
    });

    console.log(`Task created: .tasks/defined/${filename}`);
  });

program
  .command('list')
  .description('List tasks by state')
  .argument('[state]', 'Filter by state (pending|processing|testing|review|done)')
  .action((state?: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    if (state && !VALID_STATES.includes(state as TaskState)) {
      console.error(`Invalid state '${state}'. Valid: ${VALID_STATES.join(', ')}`);
      process.exit(1);
    }
    const validState = state as TaskState | undefined;
    const tasks = listTasks(taskDir, validState);

    if (tasks.length === 0) {
      console.log('No tasks found.');
      return;
    }

    const grouped = new Map<TaskState, typeof tasks>();
    for (const t of tasks) {
      const list = grouped.get(t.state) || [];
      list.push(t);
      grouped.set(t.state, list);
    }

    for (const [state, items] of grouped) {
      console.log(`\n=== ${state.toUpperCase()} (${items.length} tasks) ===`);
      for (const item of items) {
        const filePath = path.join(taskDir, state, item.filename);
        let extra = '';
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const task = parseYaml(raw) as TaskYaml;
          extra = ` | ${task.name} | v${task.version}`;
          if (state === 'testing' && task.testResults) {
            extra += ` | passRatio: ${task.testResults.passRatio}`;
          }
        } catch {
          extra = ' | (parse error)';
        }
        console.log(`  ${item.id}${extra}`);
      }
    }
  });

program
  .command('status <id>')
  .description('Show detailed info about a task')
  .action((id: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const filePath = getTaskFilePath(taskDir, id);
    if (!filePath) {
      console.error(`Task '${id}' not found.`);
      process.exit(1);
    }
    const state = getTaskState(taskDir, id);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const task = parseYaml(raw) as TaskYaml;
    const lock = readLock(getTaskLockPath(taskDir, id));

    console.log(`ID: ${task.id}`);
    console.log(`Name: ${task.name}`);
    console.log(`State: ${state}`);
    console.log(`Version: ${task.version}`);
    console.log(`Created: ${task.createdAt}`);
    console.log(`Updated: ${task.updatedAt}`);
    const desc = task.description || '';
    const displayDesc = desc.length > 100 ? desc.slice(0, 100) + '...' : desc;
    console.log(`Description: ${displayDesc}`);
    if (task.testResults) {
      console.log(`passRatio: ${task.testResults.passRatio}`);
    }
    if (lock) {
      console.log(`Locked by: ${lock.sessionId} (${lock.agentType})`);
      console.log(`Heartbeat: ${lock.heartbeatAt}`);
    }
    if (task.blockedReason) {
      console.log(`Blocked: ${task.blockedReason.slice(0, 200)}`);
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
  .description('Move a task to another state (from defined or pending only by default)')
  .action((id: string, state: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);
    const currentState = getTaskState(taskDir, id);
    if (!currentState) {
      console.error(`Task '${id}' not found.`);
      process.exit(1);
    }
    if (config.user.allowMoveFromStates.length > 0 && !config.user.allowMoveFromStates.includes(currentState)) {
      console.error(`Task '${id}' is in '${currentState}'. Move is only allowed from: ${config.user.allowMoveFromStates.join(', ')}.`);
      process.exit(1);
    }
    if (!VALID_STATES.includes(state as TaskState)) {
      console.error(`Invalid state '${state}'. Valid: ${VALID_STATES.join(', ')}`);
      process.exit(1);
    }
    if (!validateTransition(currentState, state as TaskState, 'user')) {
      console.error(`Invalid transition: ${currentState} → ${state} (actor: user). Check the state machine rules.`);
      process.exit(1);
    }
    if (moveTask(taskDir, id, state as TaskState)) {
      let taskVersion = 0;
      const filePath = getTaskFilePath(taskDir, id);
      if (filePath) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const task = parseYaml(raw) as TaskYaml;
          taskVersion = task.version || 0;
        } catch {}
      }
      appendRunLog(taskDir, {
        timestamp: new Date().toISOString(),
        agentType: 'user',
        sessionId: 'cli',
        agentName: null,
        taskId: id,
        taskVersion,
        taskState: currentState,
        action: 'move',
        description: `User moved task '${id}' from ${currentState} to ${state}`,
        result: 'success',
        duration: 0,
        error: null,
        details: null,
      });
      console.log(`Task '${id}' moved to ${state}.`);
    } else {
      console.error(`Failed to move task '${id}'.`);
      process.exit(1);
    }
  });

program
  .command('approve <id>')
  .description('Move task from review to done')
  .action((id: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const state = getTaskState(taskDir, id);
    if (state !== 'review') {
      console.error(`Task '${id}' is not in review (current: ${state}).`);
      process.exit(1);
    }
    if (moveTask(taskDir, id, 'done')) {
      let taskVersion = 0;
      const filePath = getTaskFilePath(taskDir, id);
      if (filePath) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const task = parseYaml(raw) as TaskYaml;
          taskVersion = task.version || 0;
        } catch {}
      }
      appendRunLog(taskDir, {
        timestamp: new Date().toISOString(),
        agentType: 'user',
        sessionId: 'cli',
        agentName: null,
        taskId: id,
        taskVersion,
        taskState: 'review',
        action: 'approve',
        description: `User approved task '${id}'`,
        result: 'success',
        duration: 0,
        error: null,
        details: null,
      });
      console.log(`Task '${id}' approved and moved to done.`);
    } else {
      console.error(`Failed to move task '${id}'.`);
      process.exit(1);
    }
  });

program
  .command('reject <id>')
  .description('Move task from review back to pending')
  .action((id: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const state = getTaskState(taskDir, id);
    if (state !== 'review') {
      console.error(`Task '${id}' is not in review (current: ${state}).`);
      process.exit(1);
    }
    if (moveTask(taskDir, id, 'pending')) {
      let taskVersion = 0;
      const filePath = getTaskFilePath(taskDir, id);
      if (filePath) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const task = parseYaml(raw) as TaskYaml;
          taskVersion = task.version || 0;
        } catch {}
      }
      appendRunLog(taskDir, {
        timestamp: new Date().toISOString(),
        agentType: 'user',
        sessionId: 'cli',
        agentName: null,
        taskId: id,
        taskVersion,
        taskState: 'review',
        action: 'reject',
        description: `User rejected task '${id}'`,
        result: 'success',
        duration: 0,
        error: null,
        details: null,
      });
      console.log(`Task '${id}' rejected and moved to pending.`);
    } else {
      console.error(`Failed to move task '${id}'.`);
      process.exit(1);
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
  .command('edit <id>')
  .description('Edit a task (creates new version if in processing/testing)')
  .option('-d, --description <text>', 'New description')
  .option('-i, --implementation-notes <text>', 'New implementation notes')
  .option('-t, --test-flows <json>', 'New test flows (JSON array)')
  .action((id: string, options: { description?: string; implementationNotes?: string; testFlows?: string }) => {
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
    editTask(taskDir, id, {
      description: options.description,
      implementationNotes: options.implementationNotes,
      testFlows,
    });
  });

program
  .command('runs')
  .description('View run logs organized by session or task')
  .option('--task <id>', 'View run log for a specific task')
  .option('--session <id>', 'View run log for a specific session')
  .option('--agent <type>', 'Filter by agent type (executor|tester|user|lock-releaser)')
  .action((options: { task?: string; session?: string; agent?: string }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);
    if (!config.runLog.enabled) {
      console.log('Run log is disabled in config.');
      return;
    }

    if (options.agent && !VALID_AGENTS.includes(options.agent)) {
      console.error(`Invalid agent '${options.agent}'. Valid: ${VALID_AGENTS.join(', ')}`);
      process.exit(1);
    }

    if (options.task) {
      const content = readTaskLog(taskDir, options.task);
      if (!content) {
        console.log(`No run log found for task '${options.task}'.`);
        return;
      }
      console.log(`=== Task: ${options.task} ===\n`);
      console.log(content);
      return;
    }

    if (options.session) {
      const content = readSessionLog(taskDir, options.session);
      if (!content) {
        console.log(`No run log found for session '${options.session}'.`);
        return;
      }
      console.log(`=== Session: ${options.session} ===\n`);
      console.log(content);
      return;
    }

    const sessions = listSessionFiles(taskDir);
    if (sessions.length === 0) {
      console.log('No run log entries found.');
      return;
    }

    if (options.agent) {
      const content = readAllSessionLogs(taskDir, options.agent);
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
  .command('answer-questions')
  .description('Check tasks for unanswered pending questions')
  .argument('[id]', 'Specific task ID to check')
  .action((id?: string) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const { listTasks } = require('./core/state');
    const tasks = id
      ? listTasks(taskDir).filter((t: { id: string }) => t.id === id)
      : listTasks(taskDir);

    let found = false;
    for (const t of tasks) {
      const filePath = getTaskFilePath(taskDir, t.id);
      if (!filePath) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const task = parseYaml(raw) as TaskYaml;
        if (task.pendingQuestions && task.pendingQuestions.length > 0) {
          const unanswered = task.pendingQuestions.filter(q => !q.answered);
          if (unanswered.length > 0) {
            found = true;
            console.log(`\n=== ${t.id} (${t.state}) ===`);
            for (const q of unanswered) {
              console.log(`  [${q.id}] Asked by ${q.askedBy} at ${q.askedAt}`);
              console.log(`  Question: ${q.question}`);
              console.log();
            }
          }
        }
      } catch {}
    }
    if (!found) {
      console.log('No unanswered pending questions found.');
    }
  });

program.parse(process.argv);