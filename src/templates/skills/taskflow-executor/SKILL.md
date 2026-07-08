---
name: taskflow-executor
description: Pick pending or abandoned processing tasks, implement, acquire lock, heartbeat, move to testing. For executor agents.
---

# taskflow-executor

Instructions for the agent executing a task. The agent reads this skill to know how to pick a task, acquire a lock, implement, and transition state.

---

## STRICT BOUNDARIES — READ BEFORE DOING ANYTHING

- Executor reads from BOTH `.tasks/pending/` AND `.tasks/processing/`
- Executor ONLY moves tasks: `pending → processing → testing`
- Executor MUST NEVER touch `.tasks/defined/`, `.tasks/testing/`, `.tasks/review/`, `.tasks/done/`
- Executor MUST NEVER move a task to `review` or `done` — that's Tester/User only
- Executor MUST NEVER call `npx taskflow approve` — that's User only. The `approve` command requires `--user` flag.
- Executor MUST NEVER use `--force` to move a task to `done` — the CLI will reject this without `--user` flag.
- If no tasks in `pending/` or `processing/` → **STOP immediately. Do NOT create new tasks.**
- The `/loop` mechanism will restart to retry later.

---

## FRESH START PROTOCOL — EXECUTE FIRST ON EVERY LOOP

Before doing ANYTHING else, execute these steps IN ORDER. Do NOT skip any step.

### Step 0a: Recover stuck tasks first
```bash
npx taskflow recover --dry-run
```
If there are stuck tasks (in processing/testing with no lock), recover them:
```bash
npx taskflow recover
```

### Step 0b: List ALL tasks across ALL states
```bash
npx taskflow list
```
This gives you the FULL picture of what exists. Do NOT skip this step.

### Step 0c: List your target states
```bash
npx taskflow list pending
npx taskflow list processing
```

### Step 0d: For each task found, read the FULL YAML
```bash
cat .tasks/pending/<task-id>.yaml
# OR
cat .tasks/processing/<task-id>.yaml
```
Read these fields to understand what has been done:
- `statusDescription` — what the last agent was doing
- `lastAgentSummary` — what the last agent reported
- `attemptCount` — how many times this has been tried
- `bugs[]` — what bugs were found (if returned from tester)
- `testResults` — what test results exist (if returned from tester)

### Step 0e: Only NOW proceed to Step 1

---

## RE-VERIFY ON EVERY LOOP — MANDATORY

**CRITICAL:** Do NOT trust context from previous sessions. On EVERY loop iteration, you MUST re-verify the actual filesystem state.

| What to check | How to check | Why |
|--------------|--------------|-----|
| Tasks in pending | `npx taskflow list pending` | Tasks may have been added/moved since last session |
| Tasks in processing | `npx taskflow list processing` | Tasks may have been recovered or moved |
| Lock files | `ls .tasks/locks/` | Locks may have been released or reaped |
| Lock file validity | `cat .tasks/locks/task-<id>.lock` | Must be valid YAML with `sessionId`, `heartbeatAt` |
| Task YAML content | `cat .tasks/<state>/<task-id>.yaml` | Status, bugs, attemptCount may have changed |
| All tasks | `npx taskflow list` | Check if tasks exist in OTHER states (e.g., testing, review) |

**If you find a task in a state you didn't expect** (e.g., task was in processing but now in testing) → adapt to the NEW state. Do NOT continue old work.

**If no tasks found in your target states** → verify with `npx taskflow list` (no filter) to see ALL tasks across ALL states before concluding "nothing to do". A task might be in `testing/` or `review/` waiting for another agent.

---

## USE CLI COMMANDS ONLY — NEVER WRITE FILES BY HAND

**CRITICAL:** Always use CLI commands for state transitions, locks, and status updates. NEVER write lock files, task YAML files, or run log files by hand.

| Action | Correct CLI | WRONG (do NOT do this) |
|--------|-------------|------------------------|
| Acquire lock | `npx taskflow lock <id> --agent executor` | Writing `.tasks/locks/task-<id>.lock` by hand |
| Release lock | `npx taskflow unlock <id>` | `rm .tasks/locks/task-<id>.lock` |
| Move task | `npx taskflow move <id> <state> --force` | `mv .tasks/processing/x.yaml .tasks/testing/` |
| Update status | `npx taskflow status-update <id> ...` | Editing task YAML by hand |
| List tasks | `npx taskflow list [state]` | `ls .tasks/testing/` (use CLI for reliability) |
| Heartbeat | `npx taskflow heartbeat <id>` | Editing lock file by hand |
| Read task | `cat .tasks/<state>/<id>.yaml` | OK to read files directly (read-only) |

**Why this matters:** Lock files written by hand will be corrupted (missing `sessionId`, `heartbeatAt` fields). The framework treats corrupted locks as stale → they get reaped by lock-releaser → your task gets stuck. Always use `npx taskflow lock` which writes the correct YAML format atomically.

---

## ANTI-LOOP GUARD — DO NOT REPEAT THE SAME ACTION

Before picking up a task, check `attemptCount`, `bounceCount`, and `lastAgentAction` in the task YAML:

### If bounceCount >= 2:
The task has bounced between testing and pending 2+ times. The tester found bugs each time. **Read `bugs[]` and `previousBugs[]` carefully.** Fix ALL bugs triệt để before moving to testing again. Do NOT move to testing unless you are confident ALL bugs are fixed.

### If bounceCount >= maxBounces - 1 (default: 2):
This is the **last chance** before auto-block. Read every bug, read `lastAgentSummary`, read run log. If you cannot fix ALL bugs, block the task yourself instead of moving to testing and getting auto-blocked.

### If attemptCount >= 3:
The task has been tried 3+ times with the same approach. **Do NOT repeat the same action.** Instead:
1. Read `lastAgentSummary` to understand what was tried before
2. Read `bugs[]` to understand what failed
3. Choose a DIFFERENT approach
4. If no different approach exists → block the task with a question explaining what was tried and what alternatives were considered

### If attemptCount >= 5:
Block the task automatically with reason: "Exceeded max attempts (5). Previous approaches: <list from run log summaries>"

### If statusDescription says "Blocked" or "Recovered":
Read the full context before proceeding. The task was previously blocked or recovered — understand why before trying again.

### Example of reading previous attempts:
```yaml
# In the task YAML:
statusDescription: "Gặp lỗi OOM khi build Docker image, đã thử tăng NODE_OPTIONS lên 4096"
lastAgentSummary: "Build thất bại ở step pnpm install do thiếu RAM. Đã thử retry 2 lần."
attemptCount: 2
```
→ This tells you: "đã thử 2 lần, bị OOM. Lần này cần approach khác (giảm workers, dùng swap, build từng phần)."

---

## STATUS UPDATES — UPDATE ON EVERY HEARTBEAT

Every time you heartbeat the lock (every `config.heartbeat.intervalSeconds` seconds), you MUST also update the task's execution status fields. This is critical so that:
- Subsequent loops know what has been done and can take different approaches
- Other agents can see progress and avoid repeating work
- The user can monitor what's happening

Use the `status-update` command:

```bash
npx taskflow status-update <task-id> \
  --status "Đang implement feature X, step 3/5: building Docker image" \
  --summary "Implemented auth module, đang test integration. Gặp lỗi OOM ở pnpm install, retry với NODE_OPTIONS=--max-old-space-size=4096" \
  --action "implement-progress" \
  --agent-type executor \
  --agent-name "executor-session-1"
```

**When to update:**
1. **On pickup** (Step 4): `--status "Picked up task, reading description and implementation notes" --action "pickup" --inc-attempt`
2. **On each heartbeat** (Step 6): `--status "<current progress description>" --action "implement-progress"`
3. **On completion** (Step 7): `--status "Implementation complete, moving to testing" --action "implement-done"`
4. **On block** (Step 8): `--status "Blocked: <reason>" --action "implement-blocked"`
5. **On bug fix** (Step 8.5): `--status "Fixing bug: <bug description>" --action "implement-bugfix"`

**Why `--inc-attempt` matters:**
- Each time you pickup a task, increment `attemptCount`
- If `attemptCount > 3`, consider a different approach — the previous attempts failed
- Read `lastAgentSummary` and `statusDescription` to understand what was tried before

**Example of reading previous status:**
```yaml
# In the task YAML, you'll find:
statusDescription: "Gặp lỗi OOM khi build Docker image, đã thử tăng NODE_OPTIONS lên 4096"
lastAgentSummary: "Build thất bại ở step pnpm install do thiếu RAM. Đã thử retry 2 lần."
lastAgentType: "executor"
lastAgentAction: "implement-blocked"
attemptCount: 2
```

This tells you: "đã thử 2 lần, bị OOM. Lần này cần approach khác (ví dụ: giảm workers, dùng swap, build từng phần)."

---

## PENDING QUESTIONS — COLLECT ALL BEFORE BLOCKING

When you encounter a situation requiring user input, do NOT block immediately for one question. Instead:

1. Continue working on parts that don't need the answer
2. Note down EVERY question/uncertainty you encounter
3. Only when you cannot proceed further without user input:
    a. Compile ALL questions into a single `pendingQuestions` array
    b. For each question, set a `category` (e.g., "implementation", "environment", "config")
    c. Write a `context` explaining WHY you're asking (what you found, what's missing)
    d. Group related questions by category
    e. Set `previousState: processing` in the task YAML
    f. **Update status**: `npx taskflow status-update <task-id> --status "Blocked: <reason>" --summary "<all questions>" --action "implement-blocked" --agent-type executor`
    g. **Release lock first**: `npx taskflow unlock <task-id>` — this is critical! Lock must be released before moving.
    h. **Move to blocked**: `npx taskflow move <task-id> blocked --force` — use `--force` because task was in `processing`
    i. Write run log with summary listing all questions
    j. Notify the user

Only block if you have at least one question. If you can resolve it yourself through codebase investigation, do so.

---

## SUMMARY — WRITE AFTER EVERY ACTION

Every run log entry MUST include a `summary` field — a natural language description of what the agent actually did. This is for humans to understand what happened in each run.

**Examples of good summaries:**
- "Picked up task 'login-flow' from pending. Read description and implementation notes. Started implementing NextAuth.js login form with email and password fields."
- "Implemented login API endpoint POST /api/auth/login. Added JWT token generation and httpOnly cookie handling. Created dashboard route protection middleware."
- "Implementation complete. Moved task to testing. Code changes: 3 files modified (auth.ts, login.tsx, middleware.ts). All lint checks pass."

**Examples of bad summaries:**
- "Task done" (too vague)
- "Implemented feature" (no detail)
- null or empty (mandatory)

---

## 1. Objective

Pick a task from `.tasks/pending/` or abandoned tasks from `.tasks/processing/`, implement according to the instructions, and move it to testing.

## 2. Inputs

- `.tasks/` directory in the project (created by `taskflow init`)
- `.tasks/config.yaml` — system configuration

## 3. Detailed Procedure

### Step 1: Read config

Read `.tasks/config.yaml` to get parameters:
- `heartbeat.intervalSeconds` — heartbeat interval (default 60s)
- `heartbeat.staleThresholdSeconds` — stale threshold (default 120s)
- `executor.maxPickupAttempts` — max task-finding attempts (default 5)
- `executor.pickupRetryDelaySeconds` — delay between retries (default 30s)
- `gitFlow.enabled` — if true, use worktree-based isolation (default false)
- `gitFlow.baseBranch` — the branch tester tests on (default "main")
- `gitFlow.commitConvention` — "conventional" or "plain" (default "conventional")
- `gitFlow.mergeStrategy` — "merge" | "rebase" | "squash" (default "merge")

### Step 1.5: Read custom instructions

Read the following fields from `config.executor`:

- **`customInstructions`** (string, optional): User-defined supplementary instructions. Follow these throughout the implementation. Users may request:
  - Use a specific skill (e.g., brainstorming) before implementing
  - Reference docs/design before writing code
  - Run lint, format, or other checks after implementation
  - Any other guidance — the framework does not restrict this

- **`customSkills`** (array, optional): List of supplementary skills. Load them into context and use as needed:
  ```yaml
  customSkills:
    - name: "requirement-analysis"
      path: ".agents/skills/requirement-analysis/SKILL.md"
      description: "Skill for analyzing requirements before implementation"
  ```

- **`customTools`** (array, optional): List of supplementary tools. Use them if needed.

**Note:** These custom instructions/skills/tools do not replace the framework — they supplement agent behavior while executing the task. The framework remains responsible for orchestration (lock, state, run log, versioning).

### Step 1.6: Read infrastructure (CRITICAL)

Read `.tasks/config.yaml` → `infrastructure` to understand the system architecture:

1. **Read repositories[]** — understand each repo's role, path, and what components it maps to:
   - If `repositories: []` (empty) → single repo at root, all code is here
   - For each repo: note its `role` (backend/frontend/shared), `path`, `description`, `mapsToComponents[]`
   - Read `interactionGuide` for repos your task touches

2. **Read repoRelationships[]** — understand repo-to-repo dependencies:
   - Which repo depends on which? (e.g., web-server → core-api)

3. **Read environments.<env>.components[]** — understand each component's role and interaction guide:
   - For each component: note its `role` (database/cache/authz/scanner/api/web/storage/maps), `type` (docker/process/remote), `description`
   - Read `interactionGuide` for how to connect, inspect, troubleshoot
   - Note `dependsOn` to understand startup order

4. **Read componentRelationships[]** — understand how components connect:
   - Which component talks to which? (e.g., core-api → postgresql, core-api → cloudflare-r2)

5. **Run `npx taskflow check-infra <env>`** — verify infrastructure health

6. **Identify which components your task touches** — from task description/implementationNotes:
   - If task mentions API paths like `/iam/xxx` → touches core-api
   - If task mentions database models → touches postgresql
   - If task mentions file upload → touches clamav + cloudflare-r2
   - If task mentions maps → touches map4d-api
   - Read `interactionGuide` for those specific components

7. **If a required component is down and your task depends on it → block the task**:
   - Move task to `blocked/` with reason: "Required component X is down. Setup instructions: ..."

You MUST understand the architecture before touching code. This step is not optional.

### Step 2: List available tasks (MUST run CLI command)

**You MUST run this command — do NOT guess or assume the directory contents.**

```bash
npx taskflow list pending --quiet
```

This prints task IDs (one per line) of all tasks in `pending/`. If empty, it prints "No tasks found."

Then check processing tasks:

```bash
npx taskflow list processing --quiet
```

**Priority order:**
1. First, process tasks from `processing/` — these were started by a previous executor session but abandoned (e.g., agent crash, stale lock, or returned from tester with bugs). Higher priority because they already have partial work.
2. Then, process tasks from `pending/` — fresh tasks ready for pickup.

**If BOTH commands return empty/no tasks → STOP immediately.** Do NOT create new tasks. Do NOT guess. The `/loop` mechanism will restart you later.

**How to identify abandoned processing tasks:**
- A task in `processing/` whose lock file `.tasks/locks/task-<id>.lock` is **stale** (heartbeat older than `config.heartbeat.staleThresholdSeconds`) → previous executor crashed or disconnected
- A task in `processing/` with **no lock file** → lock was released but task wasn't moved (e.g., version change, or interrupted transition)
- A task in `processing/` with `bugs[]` array populated → returned from tester, needs bug fixes

To check lock status for a task:
```bash
npx taskflow status <task-id>
```

### Step 3: Check lock for each task

For each task file, check `.tasks/locks/task-<id>.lock`:

**For tasks in `pending/`:**
- If the lock file exists → another session is processing this task → **skip**
- If the lock file does not exist → task is available → select this task

**For tasks in `processing/`:**
- If the lock file exists AND heartbeat is fresh (within `config.heartbeat.staleThresholdSeconds`) → another session is actively working → **skip**
- If the lock file exists BUT heartbeat is stale (older than `config.heartbeat.staleThresholdSeconds`) → previous executor crashed → **take over**: release stale lock first, then acquire new lock
- If the lock file does not exist → task was abandoned (e.g., version change, interrupted transition) → **take over**: acquire new lock
- If `bugs[]` array is populated → returned from tester, needs bug fixes → **take over**: acquire new lock

**How to check if a lock is stale:**
```bash
# Read the lock file
cat .tasks/locks/task-<id>.lock
# Check heartbeatAt field — if older than 120s (default staleThreshold), it's stale
```

**How to release a stale lock:**
```bash
npx taskflow unlock <task-id>
```

**Lock file format (YAML):**
```yaml
sessionId: "<uuid>"
agentType: "executor"
taskVersion: 1
acquiredAt: "2026-07-07T10:00:00Z"
heartbeatAt: "2026-07-07T10:00:00Z"
```

### Step 4: Acquire lock

Once a task is selected, acquire the lock using the CLI helper (this is the only safe, atomic way — do NOT write the lock file by hand):

```bash
npx taskflow lock <task-id> --agent executor
```

On success, this prints the lock YAML (including the generated `sessionId`). **Remember the `sessionId` and `taskVersion`** for later use — you will need them for heartbeat and release.

If the command exits 1 ("already locked") → another session has the task → pick another task.

> The lock file is written to `.tasks/locks/task-<id>.lock` using `O_CREAT | O_EXCL` (atomic create-exclusive) under the hood.

### Step 5: Read task YAML

Read the task file from `.tasks/pending/<filename>.yaml` or `.tasks/processing/<filename>.yaml`.

Fields to read:
- `description` (string): What the task does
- `implementationNotes` (string, optional): Detailed implementation instructions
- `version` (number): Current version — remember this for version change detection
- `bugs[]` (array, only for processing tasks): Bugs reported by tester — read these to understand what failed
- `blockedReason` (string, only for processing tasks): Why the task was blocked previously
- `pendingQuestions[]` (array, only for processing tasks): Previously asked questions — check if any are answered

**For tasks picked up from `processing/`:**
- If `bugs[]` is not empty → follow Step 8.5 (Fix bugs from tester)
- If `pendingQuestions[]` has answered questions → incorporate the answers into your implementation
- If the task was previously in `processing` and the lock was stale → check `implementationNotes` and any partial work to understand where to continue

### Step 5.5: Create worktree (git flow only — if config.gitFlow.enabled)

If `config.gitFlow.enabled` is `true`, create a worktree for isolated implementation:

```bash
npx taskflow worktree create <task-id>
```

This creates a git worktree at `.worktrees/<task-id>` with a new branch `taskflow/<task-id>` from `config.gitFlow.baseBranch`. The worktree path is recorded in the task YAML under `gitFlow.worktreePath`.

After creating the worktree, **`cd` into the worktree path** to do all implementation work there:
```bash
cd .worktrees/<task-id>
```

If `config.gitFlow.enabled` is `false`, skip this step — implement directly in the current working tree.

### Step 6: Implement

Based on `description` and `implementationNotes`, implement the feature.

**If git flow is enabled, work inside the worktree** (`.worktrees/<task-id>`). Commit frequently after each unit of work:

```bash
npx taskflow commit <task-id> -m "feat: add login form"
npx taskflow commit <task-id> -m "fix: handle null user"
npx taskflow commit <task-id> -m "test: add login integration test"
```

**Commit convention** (when `config.gitFlow.commitConvention == "conventional"`):
- `feat(<task-id>): <description>` — new feature
- `fix(<task-id>): <description>` — bug fix
- `refactor(<task-id>): <description>` — refactor
- `test(<task-id>): <description>` — tests
- `docs(<task-id>): <description>` — docs

Commit after each file or logical unit completed — do NOT wait until the end. This keeps history granular and safe.

**During implementation, periodically every `config.heartbeat.intervalSeconds` seconds:**

1. **Heartbeat lock**: Run `npx taskflow heartbeat <task-id>` to update `heartbeatAt`.
2. **Check version**: Re-read the task YAML, compare `version` with `taskVersion` in the lock
   - If different → run `npx taskflow unlock <task-id>`, write run log action `implement-stale`, pick another task

### Step 7: Completion

When implementation is done:

1. **Move to processing**: `npx taskflow move <task-id> processing --force` (if picked up from pending). Write run log action `implement-start`.
2. **Merge worktree into base** (git flow only): If `config.gitFlow.enabled`, merge the feature branch into `config.gitFlow.baseBranch` so the tester can test it:
   ```bash
   npx taskflow merge <task-id>
   ```
   This records the merge commit SHA in the task YAML (`gitFlow.mergeCommit`). If the merge fails (conflict), resolve it manually, then re-run `npx taskflow merge <task-id>`.
3. **Move to testing**: `npx taskflow move <task-id> testing --force`. Reset `testResults` in the task YAML. Write run log action `implement-done`.
4. **Release lock**: Run `npx taskflow unlock <task-id>` to delete `.tasks/locks/task-<id>.lock`.

> Note: Steps 7.1 and 7.3 are two separate state transitions (`pending → processing`, then `processing → testing`), not a single combined move.

### Step 8: Handle blocked

If an issue cannot be resolved:

1. **Update status**: `npx taskflow status-update <task-id> --status "Blocked: <reason>" --summary "<all questions>" --action "implement-blocked" --agent-type executor`
2. Write `blockedReason` and `pendingQuestions` into the task YAML
3. Set `previousState: processing` in the task YAML
4. **Release lock first**: `npx taskflow unlock <task-id>` — this is critical! The lock must be released before moving.
5. **Move to blocked**: `npx taskflow move <task-id> blocked --force` — use `--force` because the task was in `processing` (not in `allowMoveFromStates`)
6. Write run log action `implement-blocked` with summary listing all questions
7. Notify the user

### Step 8.5: Fix bugs from tester (when task returns from testing → processing)

When the tester reports bugs and moves the task back to `processing`:

1. **Read `bugs[]` in the task YAML** to understand what failed.
2. **Read `lastAgentSummary` and `attemptCount`** — if `attemptCount > 3`, consider a different approach since previous attempts failed.
3. **Update status**: `npx taskflow status-update <task-id> --status "Fixing bug: <bug description>" --action "implement-bugfix" --agent-type executor --inc-attempt`
4. **Revert the merge** (git flow only): Remove your merged code from the base branch so the tester doesn't test broken code:
   ```bash
   npx taskflow revert-merge <task-id>
   ```
5. **Fix in the worktree** (cd back into `.worktrees/<task-id>`), committing frequently.
6. **Re-merge** after fixes:
   ```bash
   npx taskflow merge <task-id>
   ```
7. **Move back to testing**: Move `processing/` → `testing/`. Write run log action `implement-done`.

### Step 9: Worktree cleanup (when task is approved)

When the user approves the task (task → done), the framework automatically cleans up the worktree if `config.gitFlow.autoCleanup` is true. The user can also manually clean up via:
```bash
npx taskflow cleanup-worktrees
```

## 4. State transitions performed by this skill

| From | To | When |
|------|----|------|
| pending | processing | Starting implementation (Step 7.1) |
| processing | testing | Implementation complete (Step 7.3) |
| processing | pending | Version change (Step 6.2) — release lock only, no file move |
| processing | blocked | Has questions, cannot proceed (Step 8) |

## 5. Run log entries

After each action, write an entry to `.tasks/runs/sessions/<sessionId>.md` and `.tasks/runs/tasks/<taskId>.md`:
- `pickup` — when lock is acquired. Summary: describe what task you picked up and what you plan to do.
- `implement-start` — when task moves to `processing`. Summary: describe what you're implementing.
- `implement-done` — when moved to `testing`. Summary: describe what was implemented, files changed, and verification done.
- `implement-blocked` — when blocked. Summary: describe the problem and what's needed. Also add a `pendingQuestion` to the task YAML so the next session or user can address it.
- `implement-stale` — when version change detected. Summary: describe that version changed and you're releasing the lock.

> Note: The `action` field in a run log entry is a free-form string — the names above are the convention this skill uses. There is no fixed enum enforced by the code. When filtering run logs with `taskflow runs --agent executor`, any entry with `**Agent:** executor` will match, regardless of the action name.

**When blocked, add a pending question to the task YAML:**
```yaml
pendingQuestions:
  - id: "q1"
    askedAt: "<now>"
    askedBy: "executor"
    question: "MAP4D_API_KEY is not set in .env. Should I add a placeholder or does the user have a key?"
    answered: false
```

**When answering a pending question (from a previous run):**
```yaml
pendingQuestions:
  - id: "q1"
    askedAt: "2026-07-07T10:00:00Z"
    askedBy: "executor"
    question: "MAP4D_API_KEY is not set in .env..."
    answered: true
    answer: "Added placeholder key MAP4D_API_KEY=placeholder to .env. User should replace with real key."
    answeredAt: "2026-07-07T10:30:00Z"
```