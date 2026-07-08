import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskYaml } from '../core/types';
import { GitFlowConfig } from '../core/config';
import { getTaskFilePath, getTaskState } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { validateTaskYaml } from '../core/validate';
import { mergeBranch as gitMergeBranch, checkoutBranch, getCurrentBranch, isGitRepo, GitError } from '../core/git';

function assertGitFlowEnabled(config: GitFlowConfig): void {
  if (!config.enabled) {
    console.error('Git flow is disabled. Enable in .tasks/config.yaml:\n  gitFlow:\n    enabled: true');
    process.exit(1);
  }
}

/** Merge the task's worktree branch into baseBranch. */
export function mergeTaskBranch(taskDir: string, taskId: string, config: GitFlowConfig): void {
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

  if (!task.gitFlow?.branchName) {
    console.error(`Task '${taskId}' has no gitFlow.branchName. Run 'taskflow worktree create ${taskId}' first.`);
    process.exit(1);
  }

  const originalBranch = getCurrentBranch();
  try {
    // Checkout base branch, merge feature branch
    checkoutBranch(config.baseBranch);
    const result = gitMergeBranch(task.gitFlow.branchName, config.mergeStrategy);

    // Record merge commit in task YAML
    task.gitFlow.mergeCommit = result.mergeCommit;
    task.gitFlow.baseBranchAtMerge = result.mergeCommit; // base HEAD after merge
    task.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');

    appendRunLog(taskDir, {
      timestamp: new Date().toISOString(),
      agentType: 'user',
      sessionId: 'cli',
      agentName: null,
      taskId,
      taskVersion: task.version,
      taskState: getTaskState(taskDir, taskId) || 'unknown',
      action: 'merge',
      description: `Merged ${task.gitFlow.branchName} into ${config.baseBranch} (${result.strategy})`,
      summary: `Merge commit: ${result.mergeCommit.slice(0, 8)}. Strategy: ${result.strategy}.`,
      result: 'success',
      duration: 0,
      error: null,
      details: null,
    });

    console.log(`Merged ${task.gitFlow.branchName} into ${config.baseBranch}.`);
    console.log(`Merge commit: ${result.mergeCommit.slice(0, 8)}`);
  } catch (err: any) {
    // Restore original branch on failure
    try { checkoutBranch(originalBranch); } catch {}
    if (err instanceof GitError) {
      console.error(`Merge failed: ${err.message}`);
      console.error('Resolve conflicts manually or use a different mergeStrategy.');
      process.exit(1);
    }
    throw err;
  }
}