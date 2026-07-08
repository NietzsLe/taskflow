import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GitFlowConfig } from '../core/config';
import { listTasks, getTaskFilePath, getTaskState } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { validateTaskYaml } from '../core/validate';
import { removeWorktree, deleteBranch, listWorktrees, isGitRepo } from '../core/git';

/**
 * Clean up worktrees for tasks that are done or no longer being worked on.
 * This is the command the user runs (via taskflow-user skill) to let the agent
 * help clean up finished worktrees.
 */
export function cleanupWorktrees(taskDir: string, config: GitFlowConfig): void {
  if (!config.enabled) {
    console.error('Git flow is disabled. Nothing to clean up.');
    return;
  }
  if (!isGitRepo(process.cwd())) {
    console.error('Not a git repository.');
    process.exit(1);
  }

  const allTasks = listTasks(taskDir);
  // Build task-id → { state, gitFlow } map
  const taskInfo = new Map<string, { state: string; gitFlow?: any; filePath: string }>();
  for (const t of allTasks) {
    const fp = getTaskFilePath(taskDir, t.id);
    if (!fp) continue;
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const task = validateTaskYaml(parseYaml(raw));
      taskInfo.set(t.id, { state: t.state, gitFlow: task.gitFlow, filePath: fp });
    } catch {}
  }

  // States where the task is "done" or no longer being worked on
  const FINAL_STATES = ['done', 'blocked', 'archive'];
  const cleaned: string[] = [];
  const skipped: string[] = [];

  for (const [taskId, info] of taskInfo) {
    if (!info.gitFlow?.worktreePath) continue;

    if (FINAL_STATES.includes(info.state)) {
      // Clean up
      try {
        removeWorktree(info.gitFlow.worktreePath);
        if (info.gitFlow.branchName) {
          try { deleteBranch(info.gitFlow.branchName); } catch {}
        }
        // Clear gitFlow in task YAML
        const task = validateTaskYaml(parseYaml(fs.readFileSync(info.filePath, 'utf-8')));
        task.gitFlow = undefined;
        task.updatedAt = new Date().toISOString();
        fs.writeFileSync(info.filePath, stringifyYaml(task), 'utf-8');
        cleaned.push(taskId);
      } catch (err: any) {
        skipped.push(`${taskId} (error: ${err.message})`);
      }
    } else {
      skipped.push(`${taskId} (state: ${info.state})`);
    }
  }

  // Also check for orphan worktrees (exist in git but no task association)
  const gitWorktrees = listWorktrees();
  const knownPaths = new Set(
    Array.from(taskInfo.values())
      .filter(v => v.gitFlow?.worktreePath)
      .map(v => path.resolve(v.gitFlow.worktreePath))
  );
  const orphanWorktrees: string[] = [];
  for (const wt of gitWorktrees) {
    if (wt.branch === 'main' || wt.branch === 'master') continue; // skip base worktree
    const resolvedPath = path.resolve(wt.path);
    if (!knownPaths.has(resolvedPath)) {
      // Orphan — remove if it has a taskflow/ prefix
      if (wt.branch && wt.branch.startsWith(config.branchPrefix)) {
        try {
          removeWorktree(wt.path);
          deleteBranch(wt.branch);
          orphanWorktrees.push(`${wt.path} (${wt.branch})`);
        } catch {}
      }
    }
  }

  appendRunLog(taskDir, {
    timestamp: new Date().toISOString(),
    agentType: 'user',
    sessionId: 'cli',
    agentName: null,
    taskId: '(multiple)',
    taskVersion: 0,
    taskState: '(cleanup)',
    action: 'cleanup-worktrees',
    description: `Cleaned ${cleaned.length} worktree(s), skipped ${skipped.length}, orphan ${orphanWorktrees.length}`,
    summary: `Cleaned: ${cleaned.join(', ') || '(none)'}. Skipped: ${skipped.join(', ') || '(none)'}. Orphans: ${orphanWorktrees.length}.`,
    result: 'success',
    duration: 0,
    error: null,
    details: null,
  });

  if (cleaned.length > 0) {
    console.log(`Cleaned ${cleaned.length} worktree(s):`);
    for (const id of cleaned) console.log(`  ✓ ${id}`);
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  ○ ${s}`);
  }
  if (orphanWorktrees.length > 0) {
    console.log(`\nRemoved ${orphanWorktrees.length} orphan worktree(s):`);
    for (const o of orphanWorktrees) console.log(`  ✓ ${o}`);
  }
  if (cleaned.length === 0 && skipped.length === 0 && orphanWorktrees.length === 0) {
    console.log('No worktrees to clean up.');
  }
}