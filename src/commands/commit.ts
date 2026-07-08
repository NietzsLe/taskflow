import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskYaml } from '../core/types';
import { GitFlowConfig } from '../core/config';
import { getTaskFilePath, getTaskState } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { validateTaskYaml } from '../core/validate';
import { commitAll, formatCommitMessage, isGitRepo, isWorktreeClean, GitError } from '../core/git';

function assertGitFlowEnabled(config: GitFlowConfig): void {
  if (!config.enabled) {
    console.error('Git flow is disabled. Enable in .tasks/config.yaml:\n  gitFlow:\n    enabled: true');
    process.exit(1);
  }
}

/** Commit all changes in the task's worktree with a conventional commit message. */
export function commitTask(
  taskDir: string,
  taskId: string,
  message: string,
  config: GitFlowConfig
): void {
  assertGitFlowEnabled(config);
  if (!isGitRepo(process.cwd())) {
    console.error('Not a git repository.');
    process.exit(1);
  }
  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) {
    console.error(`Task '${taskId}' not found.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));

  if (!task.gitFlow?.worktreePath) {
    console.error(`Task '${taskId}' has no worktree. Run 'taskflow worktree create ${taskId}' first.`);
    process.exit(1);
  }

  const worktreePath = task.gitFlow.worktreePath;
  if (!isGitRepo(worktreePath)) {
    console.error(`Worktree at ${worktreePath} is not a git repo.`);
    process.exit(1);
  }

  const formattedMsg = formatCommitMessage(config.commitConvention, message, taskId);

  try {
    const sha = commitAll(formattedMsg, worktreePath);
    appendRunLog(taskDir, {
      timestamp: new Date().toISOString(),
      agentType: 'user',
      sessionId: 'cli',
      agentName: null,
      taskId,
      taskVersion: task.version,
      taskState: getTaskState(taskDir, taskId) || 'unknown',
      action: 'commit',
      description: `Committed in worktree: ${formattedMsg}`,
      summary: `Commit ${sha.slice(0, 8)}: ${formattedMsg}`,
      result: 'success',
      duration: 0,
      error: null,
      details: null,
    });
    console.log(`Committed: ${sha.slice(0, 8)} — ${formattedMsg}`);
  } catch (err: any) {
    if (err instanceof GitError) {
      console.error(`Commit failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}