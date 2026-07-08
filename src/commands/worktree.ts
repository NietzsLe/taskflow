import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskYaml } from '../core/types';
import { GitFlowConfig } from '../core/config';
import { getTaskFilePath, getTaskState, listTasks } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { validateTaskYaml } from '../core/validate';
import {
  createWorktree as gitCreateWorktree,
  removeWorktree as gitRemoveWorktree,
  listWorktrees as gitListWorktrees,
  deleteBranch,
  getCurrentBranch,
  isGitRepo,
} from '../core/git';

function assertGitFlowEnabled(config: GitFlowConfig): void {
  if (!config.enabled) {
    console.error('Git flow is disabled. Enable in .tasks/config.yaml:\n  gitFlow:\n    enabled: true');
    process.exit(1);
  }
}

function loadTask(taskDir: string, taskId: string): { filePath: string; task: TaskYaml } {
  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) {
    console.error(`Task '${taskId}' not found.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));
  return { filePath, task };
}

function saveTask(filePath: string, task: TaskYaml): void {
  fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');
}

/** Create a worktree for a task. */
export function worktreeCreate(taskDir: string, taskId: string, config: GitFlowConfig): void {
  assertGitFlowEnabled(config);
  if (!isGitRepo(process.cwd())) {
    console.error('Not a git repository. Run from a git repo root.');
    process.exit(1);
  }
  const { filePath, task } = loadTask(taskDir, taskId);
  if (task.gitFlow?.worktreePath) {
    console.error(`Task '${taskId}' already has a worktree at ${task.gitFlow.worktreePath}.`);
    process.exit(1);
  }

  const branchName = `${config.branchPrefix}${taskId}`;
  const worktreePath = path.resolve(process.cwd(), config.worktreeDir, taskId);

  try {
    gitCreateWorktree(config.baseBranch, branchName, worktreePath);
  } catch (err: any) {
    console.error(`Failed to create worktree: ${err.message}`);
    process.exit(1);
  }

  task.gitFlow = { worktreePath, branchName };
  task.updatedAt = new Date().toISOString();
  saveTask(filePath, task);

  appendRunLog(taskDir, {
    timestamp: new Date().toISOString(),
    agentType: 'user',
    sessionId: 'cli',
    agentName: null,
    taskId,
    taskVersion: task.version,
    taskState: getTaskState(taskDir, taskId) || 'unknown',
    action: 'worktree-create',
    description: `Created worktree at ${worktreePath} on branch ${branchName}`,
    summary: `Worktree created from ${config.baseBranch}. Branch: ${branchName}.`,
    result: 'success',
    duration: 0,
    error: null,
    details: null,
  });

  console.log(`Worktree created: ${worktreePath}`);
  console.log(`Branch: ${branchName}`);
  console.log(`Next: cd ${worktreePath} && implement, then npx taskflow merge ${taskId}`);
}

/** Remove a worktree for a task. */
export function worktreeRemove(taskDir: string, taskId: string, config: GitFlowConfig): void {
  assertGitFlowEnabled(config);
  const { filePath, task } = loadTask(taskDir, taskId);
  if (!task.gitFlow?.worktreePath) {
    console.error(`Task '${taskId}' has no worktree.`);
    process.exit(1);
  }

  const worktreePath = task.gitFlow.worktreePath;
  const branchName = task.gitFlow.branchName;

  try {
    gitRemoveWorktree(worktreePath);
    if (branchName) {
      try {
        deleteBranch(branchName);
      } catch {
        // branch may not exist or already merged — ignore
      }
    }
  } catch (err: any) {
    console.error(`Failed to remove worktree: ${err.message}`);
  }

  task.gitFlow = undefined;
  task.updatedAt = new Date().toISOString();
  saveTask(filePath, task);

  appendRunLog(taskDir, {
    timestamp: new Date().toISOString(),
    agentType: 'user',
    sessionId: 'cli',
    agentName: null,
    taskId,
    taskVersion: task.version,
    taskState: getTaskState(taskDir, taskId) || 'unknown',
    action: 'worktree-remove',
    description: `Removed worktree at ${worktreePath}`,
    summary: `Worktree and branch ${branchName || '(none)'} cleaned up.`,
    result: 'success',
    duration: 0,
    error: null,
    details: null,
  });

  console.log(`Worktree removed: ${worktreePath}`);
}

/** List all worktrees with their associated tasks. */
export function worktreeList(taskDir: string, config: GitFlowConfig): void {
  if (!isGitRepo(process.cwd())) {
    console.error('Not a git repository.');
    process.exit(1);
  }
  const worktrees = gitListWorktrees();
  if (worktrees.length === 0) {
    console.log('No worktrees.');
    return;
  }
  // Build a map of worktreePath -> taskId from task YAMLs
  const allTasks = listTasks(taskDir);
  const pathToTask = new Map<string, string>();
  for (const t of allTasks) {
    const fp = getTaskFilePath(taskDir, t.id);
    if (!fp) continue;
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const task = validateTaskYaml(parseYaml(raw));
      if (task.gitFlow?.worktreePath) {
        pathToTask.set(path.resolve(task.gitFlow.worktreePath), t.id);
      }
    } catch {}
  }

  console.log('Worktrees:\n');
  for (const wt of worktrees) {
    const resolvedPath = path.resolve(wt.path);
    const taskId = pathToTask.get(resolvedPath) || '(unassociated)';
    console.log(`  ${wt.path}`);
    console.log(`    Branch: ${wt.branch || "(detached)"}`);
    console.log(`    SHA: ${wt.sha.slice(0, 8)}`);
    console.log(`    Task: ${taskId}`);
    console.log('');
  }
}