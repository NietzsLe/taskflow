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
                              └──────────(user reject)─────────────────────►─── done
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

Implemented in `src/edit.ts` (`editTask`).

- Editing a task in `processing` or `testing`:
  1. Snapshot current `description`, `implementationNotes`, `testFlows` into `versions.v<old>`.
  2. Apply the new field values.
  3. Bump `version` (`version += 1`), set `updatedAt`.
  4. Reset `testResults` (all flows → `pass: false`, `passRatio: 0.0`).
  5. Delete `bugs` and `blockedReason` (a new version invalidates old bug/blocked context).
  6. Move the file back to `pending/`.
- Editing a task in `defined` or `pending`: applied in place, `version++`, `testResults` reset if `testFlows` exist. No snapshot, no move.
- Editing a task in `done`: **rejected** — "Cannot edit a done task. Create a new task instead."
- Editing a task in `review`: **rejected** — "Task is in review. Reject it first, then edit."

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
| `infrastructure.environments.<env>.services[]` | Services required for a test environment (name, type `docker|process|remote`, health `check`, `setup`, `required`). The tester reads this to know what to bring up / verify. |
| `runLog` | `enabled` + the four trimming limits above. |
| `executor` / `tester` | `customInstructions`, `customSkills`, `customTools`, plus pickup/limits for executor. |
| `user` | `allowMoveFromStates` (default `["defined","pending","blocked"]`) and `requireVersioningForActive`. |
| `notification` | Channels (console/file/webhook/email/custom), `blockedCheckIntervalSeconds`, `messageTemplate`. Read by the `taskflow-notifier` skill. |

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

The `taskflow-notifier` skill sends alerts through the configured `notification.channels`. The user resolves questions via `resolve-blocked` (see 2.7), which moves the task back to its `previousState` once all questions are answered.

### 1.9 Available Skills

Installed by `taskflow init` into `.agents/skills/` (see `src/init.ts`):

| Skill | Role |
|-------|------|
| `taskflow-init` | Bootstrap the framework into a project |
| `taskflow-executor` | Pick tasks from pending, implement, move to testing |
| `taskflow-tester` | Pick tasks from testing, run test flows, move to review or back to processing |
| `taskflow-lock-releaser` | Run one cleanup cycle to reap stale locks |
| `taskflow-notifier` | Run one check cycle to alert the user about blocked tasks |
| `taskflow-user` | (This skill) Help the user interact |
| *Custom skills* | User-defined in `executor.customSkills` / `tester.customSkills` |

---

## 2. User Commands

All commands are run as `npx taskflow <command>`. Valid states accepted by the CLI: `defined, pending, processing, testing, review, done, blocked`. Valid agent types: `executor, tester, user, lock-releaser`.

### 2.1 `list [state]` — View task list

Read `.tasks/<state>/` and list all `.yaml` files. Valid states: `defined`, `pending`, `processing`, `testing`, `review`, `done`, `blocked`. Omit `[state]` to list across all states, grouped by state.

Each row shows: ID, name, version, and `passRatio` (when the task is in `testing`).

### 2.2 `add <name>` — Create a new task

> **CRITICAL — Do not auto-move to pending:** The task is created in `defined/` and stays there until the user **explicitly** says "move to pending", "ready for executor", or equivalent. Never move a task to `pending` on the agent's own initiative — the executor loop may pick it up before the user finishes defining the description, implementation notes, and test flows.

1. (Recommended) Brainstorm with the user to clarify the intended `description`, `implementationNotes`, and `testFlows`.
2. Create the YAML file in `.tasks/defined/` named `YYYY-MM-DD_<slug>_<seq>.yaml` via `npx taskflow add <name>`.
3. The task is created in `defined` state with `version: 1` and an **empty `description`** — it is NOT available for executor pickup and has no details yet.
4. Follow up with `edit <id> -d "..." -i "..." -t '[...]'` to fill in the description / implementation notes / test flows.
5. **STOP. Tell the user:** "Task `<id>` is defined in `defined/` and not yet available for the executor. When you're happy with the definition, say 'move <id> to pending' (or 'ready for executor') and I'll make it available."
6. Only when the user explicitly confirms → run `npx taskflow move <id> pending` to make it available for executor pickup.
7. A run-log entry with action `add` is written at creation, and action `move` is written when the task moves to pending.

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

Behaviour by current state:
- **defined / pending** — apply changes in place, `version++`, reset `testResults` if `testFlows` exist.
- **processing / testing** — snapshot old fields into `versions.v<old>`, apply changes, `version++`, reset `testResults`, delete `bugs` and `blockedReason`, then move the file back to `pending/`.
- **done** — rejected: "Cannot edit a done task. Create a new task instead."
- **review** — rejected: "Task is in review. Reject it first, then edit."

If no field actually changed (value equals the current value), the task is not modified.

### 2.4 `approve <id>` — Approve a task

1. Verify task is in `review/` (else error).
2. Move `review/` → `done/`.
3. Write run-log action `approve`.

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

### 2.15 `test notif` — Test notification channels

When the user says **"test notifications"**, **"test notif"**, **"test notification channels"**, or asks to verify that notifications work:

#### Procedure

1. Read `.tasks/config.yaml` → `notification` section.
2. If `notification.enabled` is `false` → tell the user:
   > "Notifications are disabled in config. Set `notification.enabled: true` in .tasks/config.yaml to enable."
   Stop.
3. Filter `notification.channels` to only those with `enabled: true`.
4. If no active channels → tell the user:
   > "No active notification channels. Edit .tasks/config.yaml and set `enabled: true` on the channels you want to use."
   Stop.
5. List the active channels to the user:
   ```
   Active notification channels:
     1. [console] console-default
     2. [webhook] slack-alerts
     3. [email]  email-default
   ```
6. Tell the user: "I will send a test notification through each active channel. Please confirm whether you receive each one."

7. For each active channel (in order):
   a. **Read the channel's `guide` field** — this tells you HOW to send. Follow it exactly.
   b. **Announce:** "Sending test through **[<type>] <name>**..."
   c. **Send the test message:**
      ```
      TaskFlow test — channel <type>/<name> at <ISO timestamp>
      This is a test. No action needed.
      ```
      Channel-specific sending:
      - **console** → print to terminal.
      - **file** → append to the channel's `path`.
      - **webhook** → HTTP POST to `url` using `format` (slack/discord/teams/generic). Use `curl`.
      - **email** → send via SMTP (`smtpHost`, `smtpPort`, `smtpUser`, `smtpPassword`, `from`, `to`). Use `curl` with `smtp://` or equivalent.
      - **custom** → follow the `guide` instructions exactly.
   d. **Ask:** "Did you receive the test from **[<type>] <name>**? (yes/no)"
   e. **Handle response:**
      - **yes** → mark PASSED.
      - **no** → troubleshoot:
        1. Re-read the `guide` and check for missed steps.
        2. Verify config fields (URL, SMTP creds, file path, env vars).
        3. If `${ENV_VAR}` is unresolved → tell user which variable is missing.
        4. Fix and **retry once**.
        5. If still fails → suggest: "Channel **[<type>] <name>** failed. Set `enabled: false` to disable it, or fix the config. Disable now? (yes/no)"
        If yes → edit `.tasks/config.yaml`, set `enabled: false`. If no → leave enabled.

8. **Report summary:**
   ```
   Notification test results:
     ✓ [console] console-default — passed
     ✓ [file]   file-default — passed
     ✗ [webhook] slack-alerts — failed (user chose to keep enabled)
   
   Summary: 2 passed, 1 failed.
   ```

9. If any channel failed and was not disabled → warn:
   > "Warning: <channel> is enabled but did not pass. It may silently fail when a task is blocked. Run `test notif` again after fixing the config."

#### Adding a new channel (optional)

If the user asks to add a new notification channel:

1. Ask which type: webhook, email, or custom.
2. Ask for a `name` to identify this instance (required when there are multiple instances of the same type).
3. Help the user fill in the config fields per the channel type's guide in the default config template.
4. Set `enabled: true`.
5. Write the new channel into `.tasks/config.yaml` under `notification.channels`.
6. Test the new channel using the same procedure as step 7 above.

---

## 3. Important Rules

| Rule | Description |
|------|-------------|
| **Never auto-move to pending** | Tasks stay in `defined/` until the user explicitly says "move to pending" / "ready for executor". The agent must never move a task to `pending` on its own — the executor loop may pick it up before the user finishes defining it. |
| **Only edit defined/pending in place** | Tasks in processing/testing must go through the versioning flow (snapshot + move to pending). |
| **Versioning is mandatory for active tasks** | When editing a processing/testing task, the old version is snapshotted. |
| **Reset testResults on version change** | A version bump always resets `testResults` (and clears `bugs`/`blockedReason`). |
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