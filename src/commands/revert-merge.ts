import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TaskYaml } from '../core/types';
import { GitFlowConfig } from '../core/config';
import { getTaskFilePath, getTaskState } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { validateTaskYaml } from '../core/validate';
import { revertMerge as gitRevertMerge, isGitRepo, GitError } from '../core/git';

function assertGitFlowEnabled(config: GitFlowConfig): void {
  if (!config.enabled) {
    console.error('Git flow is disabled. Enable in .tasks/config.yaml:\n  gitFlow:\n    enabled: true');
    process.exit(1);
  }
}

/** Revert the last merge commit recorded in the task's gitFlow. */
export function revertTaskMerge(taskDir: string, taskId: string, config: GitFlowConfig): void {
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

  if (!task.gitFlow?.mergeCommit) {
    console.error(`Task '${taskId}' has no recorded merge commit. Nothing to revert.`);
    process.exit(1);
  }

  try {
    const revertSha = gitRevertMerge(task.gitFlow.mergeCommit);

    // Clear merge commit in task YAML
    task.gitFlow.mergeCommit = undefined;
    task.gitFlow.baseBranchAtMerge = undefined;
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
      action: 'revert-merge',
      description: `Reverted merge commit for task '${taskId}'`,
      summary: `Revert commit: ${revertSha.slice(0, 8)}. Task code removed from base branch.`,
      result: 'success',
      duration: 0,
      error: null,
      details: null,
    });

    console.log(`Reverted merge for task '${taskId}'.`);
    console.log(`Revert commit: ${revertSha.slice(0, 8)}`);
  } catch (err: any) {
    if (err instanceof GitError) {
      console.error(`Revert failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}