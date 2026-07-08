# Notifier Enhancement + Versioning Fix + Bug Fixes

**Date:** 2026-07-08
**Status:** Approved

## Overview

Two main features + six bug fixes for the TaskFlow framework.

### Features

1. **Versioning — always snapshot on edit**: Every task edit creates a version snapshot regardless of state. New version records `changeDescription`. Processing status updates do NOT trigger versioning.
2. **Notifier — state snapshot diff**: Notifier stores a JSON snapshot of all task states. On each run, it diffs against the previous snapshot and reports only what changed (transitions, new tasks, blocked tasks, bounce threshold, stale locks, version bumps). Sends through all enabled channels.

### Bug fixes

- A1: Add `fromState`/`toState` to `RunLogEntry`
- A2: Log transition `processing→pending` in `edit.ts`
- A4: Add `timeoutSeconds`/`retryCount` to config template
- A5: Add test for `appendNotifierLog`
- A6: Fix `installSkills` not updating existing skills
- A7: Make `maxNotifierLogLines` configurable

---

## Part 1: Versioning — Always Snapshot on Edit

### Current behavior

Snapshots are created only when editing a task in `processing` or `testing` state. Editing in `defined`/`pending` bumps version in place with no snapshot. No `changeDescription` field exists.

### New rules

- Every task edit creates a version snapshot, regardless of state (`defined`, `pending`, `blocked`, `processing`, `testing`)
- Old version data is preserved in `versions.v<old>`
- New version records `changeDescription` — a human-readable reason for the change
- Processing status updates (`statusDescription`, `lastAgentSummary`, `lastAgentAction`, `attemptCount`, `bounceCount`) do NOT trigger versioning
- `requireVersioningForActive` config field is removed (dead code)

### Changes

#### `src/core/types.ts`
- Add `changeDescription?: string` to `VersionSnapshot`

#### `src/core/validate.ts`
- Parse `changeDescription` in `asVersionSnapshot` — required to prevent data loss

#### `src/edit.ts`
- Remove state guard (`if processing || testing`) around snapshot block
- Add `changeDescription` to snapshot object
- Add `changeDescription` param to function signature
- Add `changeDescription` to run log summary

#### `src/commands/rollback.ts`
- Add `bounceCount` and `changeDescription` to pre-rollback snapshot
- Fix hardcoded `taskState: 'pending'` → use actual state

#### `src/cli.ts`
- Add `-c, --change-description <text>` option to `edit` command

#### `src/commands/diff.ts`
- Display `changeDescription` in diff output

#### `src/core/config.ts` + `src/templates/config.yaml`
- Remove `requireVersioningForActive` field

---

## Part 2: Notifier — State Snapshot Diff

### Current behavior

Notifier only reads `.tasks/blocked/`. It has no awareness of transitions, new tasks, bounce thresholds, stale locks, or version bumps. It stops immediately if no blocked tasks exist.

### New design

Notifier stores a JSON snapshot of all task states at `.tasks/runs/notifier-state.json`. On each run:

1. Build current snapshot (scan all 7 state dirs + lock files)
2. Load previous snapshot
3. Compute diff
4. Format report (summary for normal changes, detailed for issues)
5. Send through all enabled channels
6. Write new snapshot
7. Log to both `notifier-log.md` and main run log

### Detected changes

| Type | Detail level |
|------|-------------|
| Task state transition | Summary (1 line) |
| New task created | Summary |
| Task removed (archived) | Summary |
| Version bump | Summary |
| Resolved block | Summary |
| Newly blocked | **Detailed** (questions, context, run log) |
| Bounce threshold hit | **Detailed** (bounce count, max, bug history) |
| Stale lock | **Detailed** (session ID, elapsed seconds) |

### New types (`src/core/types.ts`)

```typescript
interface TaskSnapshotEntry {
  id: string; name: string; state: TaskState;
  version: number; bounceCount: number; attemptCount: number;
  blockedReason?: string; pendingQuestionCount: number;
  lockedBy?: string; lockStale: boolean; updatedAt: string;
}
interface NotifierSnapshot {
  takenAt: string;
  tasks: Record<string, TaskSnapshotEntry>;
}
interface NotifierDiff {
  transitions: { taskId: string; name: string; from: TaskState; to: TaskState }[];
  newTasks: { taskId: string; name: string; state: TaskState }[];
  removedTasks: { taskId: string; lastState: TaskState }[];
  newlyBlocked: { taskId: string; name: string; questions: PendingQuestion[]; previousState: TaskState; blockedReason?: string }[];
  bounceThresholdHit: { taskId: string; name: string; bounceCount: number; maxBounces: number }[];
  staleLocks: { taskId: string; sessionId: string; elapsedSeconds: number }[];
  versionBumps: { taskId: string; name: string; from: number; to: number }[];
  resolvedBlocks: { taskId: string; toState: TaskState }[];
}
```

### New module: `src/core/notifier.ts`

- `getNotifierStatePath(taskDir)`
- `buildSnapshot(taskDir, config)` — scan all state dirs + locks
- `readSnapshot(taskDir)` — load previous snapshot
- `writeSnapshot(taskDir, snapshot)` — persist
- `computeDiff(prev, current, config)` — compare
- `formatReport(diff, snapshot)` — markdown report

### Config changes

- `blockedCheckIntervalSeconds` → `checkIntervalSeconds` (backward compat alias)
- Add `snapshotPath: ".tasks/runs/notifier-state.json"`
- Add `reportOnNoChange: false`
- Add `detailedOnIssues: true`
- Remove `messageTemplate` (skill-driven formatting)
- Add `maxNotifierLogLines: 100` to `runLog` section

### CLI: `taskflow notify`

- `--dry-run`: show report without sending
- `--reset`: clear snapshot (next run reports all as new)

### Notifier skill rewrite

Full rewrite of `src/templates/skills/taskflow-notifier/SKILL.md`:

1. Read config
2. Build snapshot (all states)
3. Load previous snapshot
4. First run → report all tasks as "new"
5. Compute diff
6. If empty + `reportOnNoChange: false` → stop
7. Format report (summary + issues)
8. Send through all enabled channels
9. Write snapshot
10. Log to notifier-log.md + main run log

---

## Part 3: Bug Fixes

### A1: `fromState`/`toState` in `RunLogEntry`

Add `fromState?: string` and `toState?: string` to `RunLogEntry`. Update `formatEntryMarkdown` to render transition line. Update all callers of `appendRunLog` that perform state transitions to pass both states.

**Files:** `types.ts`, `runlog.ts`, `cli.ts` (logUserAction + 5 callers), `test-fail.ts`, `recover.ts`, `rollback.ts`

### A2: Log transition in `edit.ts`

After `moveTask` succeeds (processing/testing → pending), add a separate `appendRunLog` call with action `edit-move` and `fromState`/`toState`.

**File:** `edit.ts` (after line 123)

### A4: Config template fields

Add `timeoutSeconds: 10` and `retryCount: 0` to webhook and email channel entries in `src/templates/config.yaml`.

### A5: Test for `appendNotifierLog`

Add test suite in `src/core/__tests__/runlog.test.ts` for `appendNotifierLog` (append, trim, missing file).

### A6: `installSkills` update flag

Add `--update-skills` option to `init` command. When set, overwrite existing skill files. Change `installSkills` to accept `options?: { updateSkills?: boolean }`.

**Files:** `init.ts`, `cli.ts`

### A7: `maxNotifierLogLines` configurable

Add `maxNotifierLogLines: number` to `runLog` config. Default 100. Use in `appendNotifierLog` instead of hardcoded 100.

**Files:** `config.ts`, `config.yaml`, `runlog.ts`

---

## Part 4: Skill & Doc Updates

### `taskflow-user/SKILL.md`
- Rewrite versioning section (always snapshot, changeDescription)
- Update notification config description
- Update notifier skill description
- Update edit behavior docs
- Update rules table

### `taskflow-init/SKILL.md`
- Update Step 3.5 for new config fields

### `README.md`
- Rewrite Notifications section (snapshot diff design)
- Rewrite Versioning section (always snapshot)
- Update edit command description
- Update notifier skill description

---

## Part 5: Tests

### New test file: `src/core/__tests__/notifier.test.ts`
- `buildSnapshot` — scan all states, capture lock status
- `readSnapshot`/`writeSnapshot` — round-trip, missing file, corrupt file
- `computeDiff` — transition, new task, removed, bounce, stale lock, version bump, blocked, resolved
- `formatReport` — summary, issues, empty diff

### Updated test files
- `src/__tests__/edit.test.ts` — defined/pending snapshot, changeDescription, status-update regression
- `src/core/__tests__/validate.test.ts` — changeDescription round-trip
- `src/core/__tests__/config.test.ts` — new notification fields, backward compat
- `src/core/__tests__/runlog.test.ts` — appendNotifierLog, fromState/toState rendering

---

## Implementation Order

1. Types (`types.ts`)
2. Validate (`validate.ts`)
3. Config (`config.ts` + template)
4. Versioning (`edit.ts`, `rollback.ts`, `cli.ts`, `diff.ts`)
5. RunLog (`runlog.ts`) — fromState/toState, maxNotifierLogLines
6. Bug fixes A1-A2 — update all appendRunLog callers
7. Notifier core (`notifier.ts`)
8. Notifier CLI (`cli.ts`)
9. Notifier skill (`SKILL.md`)
10. Bug fixes A4-A7 — config template, init, runlog test
11. Skill updates — user, init SKILL.md
12. README
13. Tests
14. Build + test
