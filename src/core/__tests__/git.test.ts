import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  GitError,
  isGitRepo,
  getCurrentBranch,
  getHeadSha,
  isWorktreeClean,
  createWorktree,
  removeWorktree,
  listWorktrees,
  deleteBranch,
  checkoutBranch,
  commitAll,
  mergeBranch,
  revertMerge,
  formatCommitMessage,
} from '../git';

let tmpDir: string;
let repoDir: string;

function shell(cmd: string, cwd?: string) {
  return execSync(cmd, { cwd: cwd || repoDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-git-'));
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir);
  // init git repo with main branch
  shell('git init -b main');
  shell('git config user.email test@test.com');
  shell('git config user.name Test');
  // initial commit
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test\n', 'utf-8');
  shell('git add -A && git commit -m "initial"');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isGitRepo', () => {
  it('returns true in a git repo', () => {
    expect(isGitRepo(repoDir)).toBe(true);
  });
  it('returns false outside a git repo', () => {
    expect(isGitRepo(tmpDir)).toBe(false);
  });
});

describe('getCurrentBranch / getHeadSha', () => {
  it('returns main as current branch', () => {
    expect(getCurrentBranch(repoDir)).toBe('main');
  });
  it('returns a SHA for HEAD', () => {
    const sha = getHeadSha(repoDir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('isWorktreeClean', () => {
  it('returns true when clean', () => {
    expect(isWorktreeClean(repoDir)).toBe(true);
  });
  it('returns false when dirty', () => {
    fs.writeFileSync(path.join(repoDir, 'new.txt'), 'x', 'utf-8');
    expect(isWorktreeClean(repoDir)).toBe(false);
  });
});

describe('commitAll', () => {
  it('stages and commits all changes', () => {
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'content', 'utf-8');
    const sha = commitAll('add file', repoDir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(isWorktreeClean(repoDir)).toBe(true);
    const log = shell('git log --oneline -1');
    expect(log).toContain('add file');
  });
  it('throws if nothing to commit', () => {
    expect(() => commitAll('nothing', repoDir)).toThrow(GitError);
  });
});

describe('createWorktree / removeWorktree / listWorktrees', () => {
  it('creates a worktree with a new branch', () => {
    const wtPath = path.join(tmpDir, 'wt1');
    createWorktree('main', 'taskflow/test-1', wtPath, repoDir);
    expect(fs.existsSync(path.join(wtPath, 'README.md'))).toBe(true);
    const wts = listWorktrees(repoDir);
    expect(wts.length).toBe(2);
    expect(wts.some(w => w.branch === 'taskflow/test-1')).toBe(true);
  });

  it('removes a worktree', () => {
    const wtPath = path.join(tmpDir, 'wt2');
    createWorktree('main', 'taskflow/test-2', wtPath, repoDir);
    removeWorktree(wtPath, repoDir);
    expect(fs.existsSync(wtPath)).toBe(false);
    const wts = listWorktrees(repoDir);
    expect(wts.length).toBe(1);
  });

  it('can delete a branch after worktree removed', () => {
    const wtPath = path.join(tmpDir, 'wt3');
    createWorktree('main', 'taskflow/test-3', wtPath, repoDir);
    removeWorktree(wtPath, repoDir);
    deleteBranch('taskflow/test-3', repoDir);
    const branches = shell('git branch --list');
    expect(branches).not.toContain('taskflow/test-3');
  });
});

describe('checkoutBranch', () => {
  it('checks out a branch', () => {
    shell('git branch alt');
    checkoutBranch('alt', repoDir);
    expect(getCurrentBranch(repoDir)).toBe('alt');
  });
});

describe('mergeBranch', () => {
  it('merges with merge commit (no-ff)', () => {
    // Create a feature branch with a commit
    shell('git checkout -b taskflow/feat-1');
    fs.writeFileSync(path.join(repoDir, 'feat.txt'), 'feature', 'utf-8');
    shell('git add -A && git commit -m "feat: add feature"');
    // Back to main and merge
    checkoutBranch('main', repoDir);
    const result = mergeBranch('taskflow/feat-1', 'merge', repoDir);
    expect(result.strategy).toBe('merge');
    expect(fs.existsSync(path.join(repoDir, 'feat.txt'))).toBe(true);
    // Should have a merge commit
    const log = shell('git log --oneline --merges -1');
    expect(log).toContain('Merge');
  });

  it('merges with squash', () => {
    shell('git checkout -b taskflow/feat-2');
    fs.writeFileSync(path.join(repoDir, 'feat2.txt'), 'feature2', 'utf-8');
    shell('git add -A && git commit -m "feat: add feature 2"');
    checkoutBranch('main', repoDir);
    const result = mergeBranch('taskflow/feat-2', 'squash', repoDir);
    expect(result.strategy).toBe('squash');
    expect(fs.existsSync(path.join(repoDir, 'feat2.txt'))).toBe(true);
  });

  it('merges with rebase (fast-forward)', () => {
    shell('git checkout -b taskflow/feat-3');
    fs.writeFileSync(path.join(repoDir, 'feat3.txt'), 'feature3', 'utf-8');
    shell('git add -A && git commit -m "feat: add feature 3"');
    checkoutBranch('main', repoDir);
    const result = mergeBranch('taskflow/feat-3', 'rebase', repoDir);
    expect(result.strategy).toBe('rebase');
    expect(fs.existsSync(path.join(repoDir, 'feat3.txt'))).toBe(true);
  });
});

describe('revertMerge', () => {
  it('reverts a merge commit', () => {
    // Create feature branch and merge it
    shell('git checkout -b taskflow/feat-revert');
    fs.writeFileSync(path.join(repoDir, 'revert.txt'), 'will be reverted', 'utf-8');
    shell('git add -A && git commit -m "feat: add revertable"');
    checkoutBranch('main', repoDir);
    const mergeResult = mergeBranch('taskflow/feat-revert', 'merge', repoDir);
    expect(fs.existsSync(path.join(repoDir, 'revert.txt'))).toBe(true);

    // Revert
    const revertSha = revertMerge(mergeResult.mergeCommit, repoDir);
    expect(revertSha).toMatch(/^[0-9a-f]{40}$/);
    // File should be gone after revert
    expect(fs.existsSync(path.join(repoDir, 'revert.txt'))).toBe(false);
  });
});

describe('formatCommitMessage', () => {
  it('conventional: adds feat prefix when missing', () => {
    const msg = formatCommitMessage('conventional', 'add login form', 'task-1');
    expect(msg).toBe('feat(task-1): add login form');
  });

  it('conventional: keeps existing prefix', () => {
    const msg = formatCommitMessage('conventional', 'fix: handle null', 'task-2');
    expect(msg).toBe('fix: handle null');
  });

  it('conventional: keeps prefix with scope', () => {
    const msg = formatCommitMessage('conventional', 'refactor(auth): cleanup', 'task-3');
    expect(msg).toBe('refactor(auth): cleanup');
  });

  it('plain: prefixes with task id', () => {
    const msg = formatCommitMessage('plain', 'add login form', 'task-4');
    expect(msg).toBe('[task-4] add login form');
  });

  it('plain: without task id', () => {
    const msg = formatCommitMessage('plain', 'add login form');
    expect(msg).toBe('add login form');
  });
});