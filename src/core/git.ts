import { execSync } from 'child_process';

export class GitError extends Error {
  constructor(message: string, public command?: string, public stderr?: string) {
    super(message);
    this.name = 'GitError';
  }
}

function run(cmd: string, opts: { cwd?: string } = {}): string {
  try {
    return execSync(cmd, { cwd: opts.cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err: any) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const msg = stderr || err.message;
    throw new GitError(`Command failed: ${cmd}\n${msg}`, cmd, stderr);
  }
}

/** Check if the current directory (or opts.cwd) is inside a git repo. */
export function isGitRepo(cwd?: string): boolean {
  try {
    run('git rev-parse --is-inside-work-tree', { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Get current branch name. */
export function getCurrentBranch(cwd?: string): string {
  return run('git rev-parse --abbrev-ref HEAD', { cwd });
}

/** Get HEAD commit SHA. */
export function getHeadSha(cwd?: string): string {
  return run('git rev-parse HEAD', { cwd });
}

/** Check if working tree is clean (no uncommitted changes). */
export function isWorktreeClean(cwd?: string): boolean {
  const status = run('git status --porcelain', { cwd });
  return status.length === 0;
}

/** Create a worktree at worktreePath with a new branch from baseBranch. */
export function createWorktree(baseBranch: string, branchName: string, worktreePath: string, cwd?: string): void {
  // Ensure worktreePath is absolute or relative to cwd
  run(`git worktree add -b ${branchName} ${worktreePath} ${baseBranch}`, { cwd });
}

/** Remove a worktree (force). */
export function removeWorktree(worktreePath: string, cwd?: string): void {
  run(`git worktree remove --force ${worktreePath}`, { cwd });
}

/** List worktrees as { path, branch, sha }[]. */
export function listWorktrees(cwd?: string): { path: string; branch: string; sha: string }[] {
  const output = run('git worktree list --porcelain', { cwd });
  const worktrees: { path: string; branch: string; sha: string }[] = [];
  let current: Partial<{ path: string; branch: string; sha: string }> = {};
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current as any);
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      current.sha = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === '') {
      if (current.path) {
        worktrees.push(current as any);
        current = {};
      }
    }
  }
  if (current.path) worktrees.push(current as any);
  return worktrees;
}

/** Delete a branch (force). */
export function deleteBranch(branchName: string, cwd?: string): void {
  run(`git branch -D ${branchName}`, { cwd });
}

/** Checkout a branch. */
export function checkoutBranch(branch: string, cwd?: string): void {
  run(`git checkout ${branch}`, { cwd });
}

/** Stage all and commit with message. Returns commit SHA. */
export function commitAll(message: string, cwd?: string): string {
  run('git add -A', { cwd });
  // Check if there's anything to commit
  const status = run('git status --porcelain', { cwd });
  if (status.length === 0) {
    throw new GitError('Nothing to commit — working tree is clean.', 'git commit');
  }
  run(`git commit -m ${JSON.stringify(message)}`, { cwd });
  return getHeadSha(cwd);
}

/** Merge a branch into the current branch. Returns merge commit SHA (or empty if fast-forward). */
export function mergeBranch(
  branchName: string,
  strategy: 'merge' | 'rebase' | 'squash' = 'merge',
  cwd?: string
): { mergeCommit: string; strategy: string } {
  if (strategy === 'rebase') {
    // For rebase, we rebase branchName onto current (base) — actually we checkout branchName and rebase onto base
    // But for our flow, executor merges feature into base, so we stay on base and merge
    // Rebase strategy here means: checkout branchName, rebase onto base, then checkout base and merge --ff-only
    const baseBranch = getCurrentBranch(cwd);
    run(`git checkout ${branchName}`, { cwd });
    run(`git rebase ${baseBranch}`, { cwd });
    run(`git checkout ${baseBranch}`, { cwd });
    run(`git merge --ff-only ${branchName}`, { cwd });
    return { mergeCommit: getHeadSha(cwd), strategy: 'rebase' };
  }

  if (strategy === 'squash') {
    run(`git merge --squash ${branchName}`, { cwd });
    // Squash creates staged changes but no commit yet — need to commit
    run(`git commit -m ${JSON.stringify(`Squash merge of ${branchName}`)}`, { cwd });
    return { mergeCommit: getHeadSha(cwd), strategy: 'squash' };
  }

  // Default: merge (creates merge commit)
  run(`git merge --no-ff ${branchName} -m ${JSON.stringify(`Merge ${branchName}`)}`, { cwd });
  return { mergeCommit: getHeadSha(cwd), strategy: 'merge' };
}

/** Revert a merge commit (using -m 1 to undo the merge). Returns revert commit SHA. */
export function revertMerge(mergeCommitSha: string, cwd?: string): string {
  run(`git revert -m 1 --no-edit ${mergeCommitSha}`, { cwd });
  return getHeadSha(cwd);
}

/** Format a commit message according to convention. */
export function formatCommitMessage(
  convention: 'conventional' | 'plain',
  message: string,
  taskId?: string
): string {
  if (convention === 'plain') {
    return taskId ? `[${taskId}] ${message}` : message;
  }
  // conventional: detect if message already has a type prefix
  const conventionalPattern = /^(feat|fix|refactor|test|docs|style|chore|perf|ci|build)(\([^)]+\))?:\s*.+/;
  if (conventionalPattern.test(message)) {
    return message; // already conventional
  }
  // Default to feat: if no prefix detected
  const scope = taskId ? `(${taskId})` : '';
  return `feat${scope}: ${message}`;
}