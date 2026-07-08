---
name: taskflow-user
description: Help users interact with the task system. List, add, edit, approve, reject tasks. For user-facing agents.
---

# taskflow-user

Instructions for the agent assisting the user with the task system. The user speaks commands, and the agent reads this skill to know how to respond.

> **Source of truth:** This skill mirrors the actual CLI in `src/cli.ts` and the state machine in `src/core/state.ts`. When in doubt, the code wins — but please report the discrepancy so this doc can be fixed.

---

## 1. TaskFlow Framework Overview

This section provides complete framework context so the agent can advise the user correctly.

### 1.1 State Machine

```
defined ──(user move)──► pending ──(executor)──► processing ──(executor done)──► testing
                              │                       │ │                         │
                              │                  (block) │ (block)            (all pass?)
                              │                       ▼ │   ▼                       │
                              │                   blocked   blocked             ┌────┴────┐
                              │                       │       │                 ▼         ▼
                              │              (resolve)│  (resolve)            review    processing
                              │                       ▼       ▼                 │    (with bugs)
                              │                 processing  testing              │
                              └──────────(user move)──────────────────────►─── done
```

### 1.2 Transition Rules

The authoritative transition table lives in `src/core/state.ts` (`VALID_TRANSITIONS`). Actor is who is allowed to perform the move.

| From | To | Performed by | Condition |
|------|----|-------------|-----------|
| defined | pending | user | Move task to make it available for executor |
| pending | processing | executor **or** user | Pick up task (executor) / manual override (user) |
| pending | testing | user | Manual override |
| pending | review | user | Manual override |
| pending | done | user | Manual override |
| processing | testing | executor | Code done, self-triage |
| processing | pending | executor | Version change detected → release lock |
| processing | blocked | executor | Has questions, cannot proceed |
| testing | review | tester | All flows pass (passRatio >= required) |
| testing | processing | tester | Flow fails → update task with bug info |
| testing | pending | tester | At least 1 flow fails (passRatio < required) — via `test-fail` command |
| testing | blocked | tester | Has questions, cannot proceed |
| blocked | processing | user | Questions resolved, return to processing |
| blocked | testing | user | Questions resolved, return to testing |
| blocked | pending | user | Questions resolved, return to pending |
| review | done | user | Approve |
| review | pending | user | Reject |
| done | _(none)_ | — | Terminal state |

Notes:
- `done` is terminal — it cannot transition to anything.
- The CLI validates BOTH the `allowMoveFromStates` gate AND `validateTransition`. A `move` is only accepted if the current state is in `config.user.allowMoveFromStates` **and** the `from → to` pair is listed above for actor `user`.

### 1.3 Lock Mechanism

- **File-based mutex lock** (`fs.openSync(path, 'wx')` ≡ `O_CREAT | O_EXCL` — create-exclusive). Implemented in `src/core/lock.ts`.
- Two lock kinds:
  - **Task lock** — `.tasks/locks/task-<id>.lock` — prevents two sessions from working on the same task.
  - **Infra lock** — `.tasks/locks/infra.lock` — ensures only one tester runs against the dev infrastructure at a time.
- Only acquired when task is in `processing` or `testing`.
- Heartbeat interval: `config.heartbeat.intervalSeconds` (default 60s).
- Stale threshold: `config.heartbeat.staleThresholdSeconds` (default 120s) — a lock with no heartbeat for this long is considered stale.
- `lockReleaserIntervalSeconds` (default 60s) — how often the lock-releaser agent runs its cleanup loop.
- Lock-releaser agent reaps stale locks; the user can also force-release via `taskflow unlock`.
- Agent must release lock when: transitioning state, version change detected, session ends.

### 1.4 Versioning

TaskFlow versions every edit. When a user edits a task (any state):

1. The current `description`, `implementationNotes`, `testFlows`, and `bounceCount` are snapshotted into `versions.v<old>`
2. The edit's `changeDescription` is recorded in the snapshot
3. `version` is bumped, `testResults` are reset
4. If the task was in `processing` or `testing`, it is moved back to `pending`

Processing status updates (`statusDescription`, `lastAgentSummary`, `lastAgentAction`, `attemptCount`, `bounceCount`) do NOT trigger versioning — they are metadata updates only.

Agents periodically check the task version. If it changes while they are working, they release the lock and move on.

### 1.5 Run Log

Implemented in `src/core/runlog.ts`. Every agent/user action is appended in Markdown to **two** places:

- `.tasks/runs/sessions/<sessionId>.md` — all actions by a specific agent session.
- `.tasks/runs/tasks/<taskId>.md` — full history of a specific task across sessions.

Supporting files:
- `.tasks/runs/.seq` — global run counter (produces `runId` like `run_20260708_001`).
- `.tasks/runs/releaser-log.md` — lock-releaser log.

Each entry is a Markdown block with: timestamp, action, runId, agent, session, task (version + state), result, duration, and optional summary/error/details.

> The `action` field is a free-form string set by the caller — there is no fixed enum of 15 types. Actions emitted by the CLI today include: `add`, `edit`, `move`, `approve`, `reject`, `resolve-blocked`. Executor/tester/releaser agents emit their own action names (e.g. `pickup`, `test-flow-fail`) — see those skills for the full list.

Trimming (from `config.runLog`):
- `maxTaskLogLines` (default 500) — each task log is trimmed to the last N lines.
- `maxSessionLogLines` (default 500) — each session log is trimmed to the last N lines.
- `maxSessionFiles` (default 50) — oldest session files beyond this count are deleted.
- `maxReleaserLogLines` (default 100).
- `enabled` (default true) — when false, no run logs are written and `runs` returns "Run log is disabled".

View with:

```bash
npx taskflow runs                       # list recent sessions (10 most recent)
npx taskflow runs --task <id>           # full history for a task
npx taskflow runs --session <id>        # all actions in a session
npx taskflow runs --agent <type>        # filter sessions by agent type (executor|tester|user|lock-releaser)
```

> Note: there is **no** `--date` flag. Filtering is by task, session, or agent type only.

### 1.6 Configuration (`config.yaml`)

File: `.tasks/config.yaml` (template in `src/templates/config.yaml`, defaults in `src/core/config.ts`). The user can edit it directly to tune the system:

| Section | Purpose |
|---------|---------|
| `system` | Name, version, `projectRoot`, `taskDir` (default `.tasks`). |
| `heartbeat` | `intervalSeconds`, `jitterSeconds`, `staleThresholdSeconds`, `lockReleaserIntervalSeconds`. |
| `lock` | `acquireMode: create-exclusive`, `releaseMode: delete-file`. |
| `test` | `passRatioRequired` (default 1.0), `maxRetriesPerFlow`, `infraLockRequired`, `skipPassedFlows`, `warnNoBrowserMCP`. |
| `browserMCP` | List of connected browser-automation MCP tools the tester may use (e.g. `playwriter`). The agent must already have the MCP connected; this config only declares which are available. |
| `infrastructure` | Repositories (`repositories[]`), repo relationships (`repoRelationships[]`), environments (`environments.<env>.components[]` with `role`, `type`, `check`, `setup`, `dependsOn`, `interactionGuide`), component relationships (`componentRelationships[]`), and `seed[]`. The executor reads this to understand architecture before implementing; the tester reads this to know what to bring up / verify. |
| `runLog` | `enabled` + the four trimming limits above. |
| `executor` / `tester` | `customInstructions`, `customSkills`, `customTools`, plus pickup/limits for executor. |
| `user` | `allowMoveFromStates` (default `["defined","pending","blocked"]`) and `requireVersioningForActive`. |
| `notification` | Channels, `checkIntervalSeconds`, `snapshotPath`, `reportOnNoChange`, `detailedOnIssues`. Read by the `taskflow-notifier` skill. |

Missing config falls back to defaults via `deepMergeConfig`, so partial configs are safe.

### 1.7 Custom Instructions

Users can add custom instructions in `config.executor.customInstructions` and `config.tester.customInstructions`. These do not conflict with the framework — the framework orchestrates (lock, state, run log), custom instructions guide agent behavior. Users can also add custom skills (`customSkills`) and custom tools (`customTools`).

### 1.8 Blocked State

When an executor or tester encounters questions it cannot resolve, the task moves to `blocked/`. The task YAML stores:

```yaml
previousState: processing  # or testing
pendingQuestions:
  - id: "q1"
    askedAt: "2026-07-07T10:00:00Z"
    askedBy: "executor"
    category: "implementation"
    question: "Should I use NextAuth.js or custom auth?"
    context: "Found existing JWT infrastructure in core-api/iam but task doesn't specify."
    answered: false
```

The `taskflow-notifier` skill monitors all task state changes via snapshot diff and sends alerts through the configured `notification.channels`. It reports transitions, new tasks, blocked tasks, bounce thresholds, stale locks, and version bumps. The user resolves questions via `resolve-blocked` and stale locks via `unlock`.

### 1.9 Execution Status Fields

Task YAML files may contain the following execution status fields, updated by agents on every heartbeat:

| Field | Type | Description |
|-------|------|-------------|
| `statusDescription` | string? | Current working status (e.g. "Building Docker image, step 3/5") |
| `lastAgentSummary` | string? | Natural language summary of last agent action |
| `lastAgentType` | 'executor' \| 'tester'? | Which agent type last touched this task |
| `lastAgentAction` | string? | Last action performed (pickup, implement-start, test-flow-pass, etc.) |
| `lastAgentActionAt` | string? | When the last action was performed (ISO timestamp) |
| `attemptCount` | number? | How many times this task has been attempted (for retry detection) |
| `bounceCount` | number? | How many times task bounced testing → pending (auto-block at maxBounces) |
| `previousBugs` | Bug[]? | Snapshot of bugs from previous test cycle (for same-bugs detector) |

These fields are preserved across edits and state transitions. Use `npx taskflow status <id>` to view them.

### 1.10 Available Skills

Installed by `taskflow init` into `.agents/skills/` (see `src/init.ts`):

| Skill | Role |
|-------|------|
| `taskflow-init` | Bootstrap the framework into a project |
| `taskflow-executor` | Pick tasks from pending, implement, move to testing |
| `taskflow-tester` | Pick tasks from testing, run test flows, move to review or back to processing |
| `taskflow-lock-releaser` | Run one cleanup cycle to reap stale locks |
| `taskflow-notifier` | Run one check cycle to detect task state changes and notify the user |
| `taskflow-user` | (This skill) Help the user interact |
| *Custom skills* | User-defined in `executor.customSkills` / `tester.customSkills` |

---

## 2. User Commands

All commands are run as `npx taskflow <command>`. Valid states accepted by the CLI: `defined, pending, processing, testing, review, done, blocked`. Valid agent types: `executor, tester, user, lock-releaser`.

### 2.1 `list [state]` — View task list

Read `.tasks/<state>/` and list all `.yaml` files. Valid states: `defined`, `pending`, `processing`, `testing`, `review`, `done`, `blocked`. Omit `[state]` to list across all states, grouped by state.

Each row shows: ID, name, version, and `passRatio` (when the task is in `testing`).

### 2.2 `add <name>` — Create a new task

1. (Recommended) Brainstorm with the user to clarify the intended `description`, `implementationNotes`, and `testFlows`.
2. Create the YAML file in `.tasks/defined/` named `YYYY-MM-DD_<slug>_<seq>.yaml`.
3. The task is created in `defined` state with `version: 1` and an **empty `description`** — it is NOT available for executor pickup and has no details yet.
4. Follow up with `edit <id> -d "..." -i "..." -t '[...]'` to fill in the description / implementation notes / test flows.
5. Then `move <id> pending` to make it available for executor pickup.
6. A run-log entry with action `add` is written.

### 2.3 `edit <id>` — Edit a task

CLI flags (all optional; only provided fields are changed):

```
npx taskflow edit <id> -d, --description <text>
                       -i, --implementation-notes <text>
                       -t, --test-flows <json-array>
```

`--test-flows` expects a JSON array, e.g.:
```bash
npx taskflow edit <id> -t '[{"name":"Happy path","steps":"1. Open /login\n2. ..."}]'
```

- **Edit behavior:**
  - All states: snapshot old version into `versions.v<old>`, version++, record `changeDescription`, reset testResults
  - `processing` / `testing`: additionally moved back to `pending`
  - `done`: cannot edit
  - `review`: cannot edit (reject first)

If no field actually changed (value equals the current value), the task is not modified.

### 2.4 `approve <id>` — Approve a task

1. Verify task is in `review/` (else error).
2. Move `review/` → `done/`.
3. Write run-log action `approve`.

**IMPORTANT:** The `approve` command requires the `--user` flag to prevent agents from auto-approving tasks:
```bash
npx taskflow approve <id> --user
```
Agents MUST NOT call this command. Only the user can approve tasks.

### 2.5 `reject <id>` — Reject a task

```
npx taskflow reject <id> [--reason <text>]
```

1. Verify task is in `review/` (else error).
2. If `--reason <text>` is provided, write it into the task's `blockedReason` field so the next executor knows why it was sent back.
3. Move `review/` → `pending/`.
4. Write run-log action `reject`.

### 2.6 `move <id> <state>` — Manually move a task

**Rules:**
- The current state must be in `config.user.allowMoveFromStates` (default: `defined`, `pending`, `blocked`). Otherwise the CLI rejects with "Move is only allowed from: ...".
- The `from → to` pair must be a valid user transition in `VALID_TRANSITIONS` (see 1.2). For example `defined → pending` is allowed, but `defined → done` is not.
- Common use: `move <id> pending` to make a `defined` task available for executor pickup; `move <id> processing|testing|pending` to unblock a resolved `blocked` task (though `resolve-blocked` is usually the better path).

**Guards:**
- Moving to `done` with `--force` requires `--user` flag: `npx taskflow move <id> done --force --user`. Agents MUST NOT move tasks to done.
- Moving to `review` requires passRatio >= `config.test.passRatioRequired`. The CLI enforces this automatically — it will reject if passRatio is too low. Do NOT use `--force` to bypass this.

### 2.7 `resolve-blocked [id]` — Resolve blocked tasks

List blocked tasks (or one by ID) with their pending questions:

1. Read `.tasks/blocked/`.
2. Print task name, previous state, and all unanswered questions grouped by id/category.
3. To resolve: edit the task YAML and set `answered: true` (plus an `answer`) for each question. (There is no `answer` sub-command today — direct YAML edit is required.)
4. Run `npx taskflow resolve-blocked <id>` again. If all questions are now answered, the task is automatically moved back to its `previousState` and a run-log entry (action `resolve-blocked`, with summary) is written.
5. If the task has no `pendingQuestions` at all, running this command also moves it back to `previousState`.

### 2.8 `status <id>` — Show task detail

Prints: id, name, current state, version, createdAt, updatedAt, description (truncated to 100 chars), `passRatio` (if present), lock holder (sessionId + agentType) and heartbeat (if locked), `blockedReason` (truncated to 200 chars), and any `bugs` (flow + description).

Use this when the user wants more than the one-line `list` view — e.g. to check who holds the lock, why a task is blocked, or what bugs were filed.

### 2.9 `unlock [id] [--all]` — Force-release locks

| Invocation | Effect |
|------------|--------|
| `npx taskflow unlock` | Release the infra lock (`.tasks/locks/infra.lock`). |
| `npx taskflow unlock <id>` | Release the task lock for `<id>` (`.tasks/locks/task-<id>.lock`). |
| `npx taskflow unlock --all` | Release every `.lock` file in `.tasks/locks/`. |

Use when a lock is stale and the lock-releaser hasn't reaped it yet, or after an agent crash. Prefer letting the lock-releaser handle stale locks automatically; use `unlock` only for manual recovery.

### 2.10 `runs` — View run logs

See section 1.5 for the underlying files and flags:

```bash
npx taskflow runs
npx taskflow runs --task <id>
npx taskflow runs --session <id>
npx taskflow runs --agent executor|tester|user|lock-releaser
```

If `config.runLog.enabled` is false, prints "Run log is disabled in config."

### 2.11 `setup-custom <executor|tester>` — Configure custom instructions

Prints step-by-step instructions for editing `.tasks/config.yaml` to add `customInstructions`, `customSkills`, and `customTools` for the chosen agent. Argument must be `executor` or `tester`.

### 2.12 `init` — Bootstrap TaskFlow

```
npx taskflow init              # scaffold .tasks/ + install skills to .agents/skills/
npx taskflow init --no-skills  # scaffold .tasks/ only
npx taskflow init --force      # backup existing .tasks/ and re-init from scratch
```

Creates the state directories, `locks/`, `runs/`, copies `config.yaml`, and (unless `--no-skills`) copies the skill files into `.agents/skills/`. Will not overwrite an existing `config.yaml` or skill file. Use `--force` to backup and re-init.

### 2.13 Git Flow commands (optional — only when `config.gitFlow.enabled` is true)

When git flow is enabled, these commands are available:

| Command | Purpose |
|---------|---------|
| `npx taskflow worktree create <id>` | Create a git worktree for a task |
| `npx taskflow worktree remove <id>` | Remove a task's worktree and branch |
| `npx taskflow worktree list` | List all worktrees with associated tasks |
| `npx taskflow merge <id>` | Merge the task's worktree branch into baseBranch |
| `npx taskflow revert-merge <id>` | Revert the last merge commit for a task |
| `npx taskflow commit <id> -m "<msg>"` | Commit changes in the task worktree (conventional message) |
| `npx taskflow cleanup-worktrees` | Remove worktrees for done/blocked tasks + orphan worktrees |

When git flow is disabled, these commands print "Git flow is disabled" and exit.

### 2.14 `cleanup-worktrees` — Help clean up finished worktrees

Run this periodically to let the agent help clean up worktrees that are no longer needed:

```bash
npx taskflow cleanup-worktrees
```

This removes worktrees for tasks in `done`, `blocked`, or `archive` states, and also removes orphan worktrees (exist in git but no associated task). Tasks still in `processing` or `testing` are skipped.

### 2.15 `status-update <id>` — Update execution status (agent use)

```bash
npx taskflow status-update <id> \
  --status "Đang build Docker image" \
  --summary "Started build, gặp lỗi OOM" \
  --action "implement-progress" \
  --agent-type executor \
  --inc-attempt
```

Updates `statusDescription`, `lastAgentSummary`, `lastAgentType`, `lastAgentAction`, `lastAgentActionAt`, and optionally increments `attemptCount`. Does NOT change task state. Writes a run log entry.

### 2.16 `test-fail <id>` — Report test failure with bounce detection

```bash
npx taskflow test-fail <id> --reason "Flow 'login' failed: API returned 500" --agent-name "tester-1"
```

Called by the tester when tests fail. Automatically:
1. Increments `bounceCount`
2. Detects if same bugs are repeating (same-bugs detector)
3. If `bounceCount >= maxBounces` (default 3) OR same bugs detected → auto-blocks the task
4. Otherwise → moves to `pending/` for executor re-pickup

**Bounce detection prevents infinite ping-pong** between testing and pending. After 3 bounces (or same bugs detected twice), the task is auto-blocked with a detailed reason.

### 2.17 `recover [--dry-run]` — Recover stuck tasks

```bash
npx taskflow recover          # actually recover
npx taskflow recover --dry-run # list what would be recovered
```

Finds tasks in `processing/` or `testing/` with no lock file or stale lock, moves them to `pending/`. Updates `statusDescription` to "Recovered from <state>: <reason>".

### 2.18 `doctor [--fix]` — Health check and auto-repair

```bash
npx taskflow doctor       # check only
npx taskflow doctor --fix # check + fix issues
```

When `--fix` is used:
- Recovers stuck tasks (same as `recover`)
- Releases orphan locks (locks for tasks not in processing/testing)

---

## 3. Important Rules

| Rule | Description |
|------|-------------|
| **Every edit creates a version snapshot** | Old version preserved in `versions.v<old>` |
| **Versioning is mandatory for all edits** | `changeDescription` records the reason |
| **Status updates do NOT bump version** | `statusDescription`, `lastAgentSummary`, etc. are metadata only |
| **Reset testResults on version change** | |
| **Do not skip review** | Tasks must go through `review` before reaching `done` (only the user can move `review → done`). |
| **Prefer the lock-releaser over manual unlock** | Use `taskflow unlock` only for manual recovery; the framework reaps stale locks automatically. |
| **Custom instructions do not replace the framework** | The framework orchestrates (lock, state, run log); custom instructions only guide how the agent does the task. |
| **Git flow is opt-in** | When `config.gitFlow.enabled` is false (default), no git operations happen. Enable in config to use worktrees. |

## 4. Special Cases

| Situation | Action |
|-----------|--------|
| User wants to edit a `done` task | Create a new task (`add`) instead — editing `done` is rejected by the CLI. |
| User wants to edit a `review` task | `reject` it first (back to `pending`), then `edit`. Editing `review` is rejected by the CLI. |
| User wants to "delete" a task | Use `taskflow delete <id>` — moves to `.tasks/archive/` with a deletion note. |
| User does not remember the ID | Use `list [state]` to find it, or `status <id>` once known. |
| User wants custom instructions but is unsure what to add | Suggest common use cases: use brainstorming, reference docs, run lint, take screenshots on test failure, check logs. Use `setup-custom` for the exact steps. |
| User reports a stuck task | Run `status <id>` to see the lock holder + heartbeat; if stale, `unlock <id>` (or `unlock` for infra). |
| User wants to clean up old worktrees | Run `taskflow cleanup-worktrees` — removes worktrees for done/blocked/orphan tasks. |
| User wants to re-init TaskFlow | Use `taskflow init --force` — backs up existing `.tasks/` and re-creates from scratch. |
| User wants to modify infrastructure | Edit `.tasks/config.yaml` → `infrastructure` section. Add/remove repos, components, relationships. Update `interactionGuide` for each. Run `npx taskflow check-infra <env>` to verify. Use `npx taskflow init --update-skills` to refresh skill templates. See init skill Step 4 for detailed guidance. |
| User has a single-repo project | Leave `repositories: []` (empty = single repo at root, backward compatible). No need to declare repos. |
| User has a multi-repo project | Declare each repo in `repositories[]` with `name`, `role`, `path`, `description`, `mapsToComponents[]`, `interactionGuide`. Declare repo relationships in `repoRelationships[]`. |
| User adds a new component | Add to `environments.<env>.components[]` with `role`, `type`, `check`, `setup`, `dependsOn`, `interactionGuide`. Add relationships in `componentRelationships[]`. |
| User adds a remote dependency (R2, Map4D) | Use `type: "remote"`. Check via HTTP. Cannot auto-setup. `interactionGuide` should describe env vars needed. |