---
name: taskflow-tester
description: Pick testing tasks, run test flows, acquire locks, check infrastructure, move to review or back to processing. For tester agents.
---

# taskflow-tester

Instructions for the agent testing a task. The agent reads this skill to know how to pick a task, acquire locks, run test flows, and transition state.

---

## STRICT BOUNDARIES — READ BEFORE DOING ANYTHING

- Tester ONLY reads from `.tasks/testing/`
- Tester ONLY moves tasks: `testing → review` (all pass) or `testing → pending` (fail)
- Tester MUST NEVER move a task to `done` — that's User only
- Tester MUST NEVER call `npx taskflow approve` — that's User only. The `approve` command requires `--user` flag.
- Tester MUST NEVER use `--force` to move a task to `done` — the CLI will reject this without `--user` flag.
- Tester MUST NEVER touch `.tasks/defined/`, `.tasks/pending/`, `.tasks/processing/`, `.tasks/review/`, `.tasks/done/`
- If no tasks in `testing/` → **STOP immediately. Do NOT create new tasks.**
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

### Step 0c: List your target state
```bash
npx taskflow list testing
```

### Step 0d: For each task found, read the FULL YAML
```bash
cat .tasks/testing/<task-id>.yaml
```
Read these fields to understand what has been done:
- `statusDescription` — what the last agent was doing
- `lastAgentSummary` — what the last agent reported
- `attemptCount` — how many times this has been tried
- `bugs[]` — what bugs were found (if returned from executor)
- `testResults` — what test results exist (which flows passed/failed)

### Step 0e: Only NOW proceed to Step 1

---

## RE-VERIFY ON EVERY LOOP — MANDATORY

**CRITICAL:** Do NOT trust context from previous sessions. On EVERY loop iteration, you MUST re-verify the actual filesystem state.

| What to check | How to check | Why |
|--------------|--------------|-----|
| Tasks in testing | `npx taskflow list testing` | Tasks may have been added/moved since last session |
| Lock files | `ls .tasks/locks/` | Locks may have been released or reaped |
| Lock file validity | `cat .tasks/locks/task-<id>.lock` | Must be valid YAML with `sessionId`, `heartbeatAt` |
| Infra lock | `cat .tasks/locks/infra.lock` | Must be valid YAML with `sessionId`, `heartbeatAt` |
| Task YAML content | `cat .tasks/testing/<task-id>.yaml` | Status, bugs, attemptCount may have changed |
| All tasks | `npx taskflow list` | Check if tasks exist in OTHER states (e.g., pending, processing) |

**If you find a task in a state you didn't expect** (e.g., task was in testing but now in pending) → adapt to the NEW state. Do NOT continue old work.

**If no tasks found in testing** → verify with `npx taskflow list` (no filter) to see ALL tasks across ALL states before concluding "nothing to do". A task might be in `pending/` or `processing/` waiting for executor.

---

## USE CLI COMMANDS ONLY — NEVER WRITE FILES BY HAND

**CRITICAL:** Always use CLI commands for state transitions, locks, and status updates. NEVER write lock files, task YAML files, or run log files by hand.

| Action | Correct CLI | WRONG (do NOT do this) |
|--------|-------------|------------------------|
| Acquire task lock | `npx taskflow lock <id> --agent tester` | Writing `.tasks/locks/task-<id>.lock` by hand |
| Acquire infra lock | `npx taskflow lock --infra` | Writing `.tasks/locks/infra.lock` by hand |
| Release lock | `npx taskflow unlock <id>` or `npx taskflow unlock` (infra) | `rm .tasks/locks/*.lock` |
| Move task | `npx taskflow move <id> <state> --force` | `mv .tasks/testing/x.yaml .tasks/pending/` |
| Update status | `npx taskflow status-update <id> ...` | Editing task YAML by hand |
| List tasks | `npx taskflow list [state]` | `ls .tasks/testing/` (use CLI for reliability) |
| Heartbeat | `npx taskflow heartbeat <id>` or `npx taskflow heartbeat --infra` | Editing lock file by hand |
| Read task | `cat .tasks/<state>/<id>.yaml` | OK to read files directly (read-only) |

**Why this matters:** Lock files written by hand will be corrupted (missing `sessionId`, `heartbeatAt` fields). The framework treats corrupted locks as stale → they get reaped by lock-releaser → your task gets stuck. Always use `npx taskflow lock` which writes the correct YAML format atomically.

---

## ANTI-LOOP GUARD — DO NOT REPEAT THE SAME ACTION

Before picking up a task, check `attemptCount`, `bounceCount`, and `lastAgentAction` in the task YAML:

### If bounceCount >= 2:
The task has bounced 2+ times. The executor claims to have fixed bugs but they keep coming back. **Test every flow thoroughly.** Document every bug precisely in `bugs[]` — the same-bugs detector will auto-block if the same bugs appear again.

### If bounceCount >= maxBounces - 1 (default: 2):
This is the **last chance** before auto-block. Be extra careful. Every bug must have:
- Exact flow name
- Exact step where it failed
- Expected vs actual behavior
- Error messages / logs if available

### If attemptCount >= 3:
The task has been tested 3+ times with the same approach. **Do NOT repeat the same test approach.** Instead:
1. Read `lastAgentSummary` to understand what was tested before
2. Read `bugs[]` to understand what failed
3. Choose a DIFFERENT testing approach (e.g., different test data, different assertions, different environment)
4. If no different approach exists → block the task with a question explaining what was tried and what alternatives were considered

### If attemptCount >= 5:
Block the task automatically with reason: "Exceeded max testing attempts (5). Previous approaches: <list from run log summaries>"

### If statusDescription says "Blocked" or "Recovered":
Read the full context before proceeding. The task was previously blocked or recovered — understand why before trying again.

### Example of reading previous attempts:
```yaml
# In the task YAML:
statusDescription: "Test flow 'Instance budget CRUD' failed: no OpenClaw instances provisioned"
lastAgentSummary: "Instance budget CRUD ❌ — No OpenClaw instances. Need openclaw:dev image rebuild first."
attemptCount: 2
```
→ This tells you: "đã thử 2 lần, thiếu OpenClaw instances. Cần kiểm tra xem image đã build xong chưa trước khi test lại."

---

## STATUS UPDATES — UPDATE ON EVERY HEARTBEAT

Every time you heartbeat the locks (every `config.heartbeat.intervalSeconds` seconds), you MUST also update the task's execution status fields. This is critical so that:
- Subsequent loops know what has been tested and what failed
- Other agents can see progress and avoid repeating work
- The user can monitor what's happening

Use the `status-update` command:

```bash
npx taskflow status-update <task-id> \
  --status "Testing flow 2/3: 'Wrong password' — API returned 200 instead of 401" \
  --summary "Flow 'Happy path' PASS. Flow 'Wrong password' FAIL: no error message shown" \
  --action "test-flow-fail" \
  --agent-type tester \
  --agent-name "tester-session-1"
```

**When to update:**
1. **On pickup** (Step 4): `--status "Picked up task, reading test flows" --action "test-start" --inc-attempt`
2. **On each heartbeat** (Step 7c): `--status "<current test progress>" --action "test-progress"`
3. **After each flow** (Step 7d): `--status "Flow '<name>' <PASS|FAIL>" --action "test-flow-pass"` or `"test-flow-fail"`
4. **On completion** (Step 9): `--status "All flows done, passRatio: X" --action "test-done"` or `"test-fail"`
5. **On block** (PENDING QUESTIONS section): `--status "Blocked: <reason>" --action "test-blocked"`

**Why `--inc-attempt` matters:**
- Each time you pickup a task, increment `attemptCount`
- If `attemptCount > 3`, consider a different testing approach
- Read `lastAgentSummary` and `statusDescription` to understand what was tried before

---

## PENDING QUESTIONS — COLLECT ALL BEFORE BLOCKING

When you encounter a situation requiring user input during testing, do NOT block immediately for one question. Instead:

1. Continue testing other flows that don't need the answer
2. Note down EVERY question/uncertainty you encounter
3. Only when you cannot proceed further without user input:
    a. Compile ALL questions into a single `pendingQuestions` array
    b. For each question, set a `category` (e.g., "test-expectation", "environment", "bug-clarification")
    c. Write a `context` explaining WHY you're asking (what failed, what was expected vs actual)
    d. Group related questions by category
    e. Set `previousState: testing` in the task YAML
    f. **Update status**: `npx taskflow status-update <task-id> --status "Blocked: <reason>" --summary "<all questions>" --action "test-blocked" --agent-type tester`
    g. **Release locks first**: `npx taskflow unlock <task-id>` then `npx taskflow unlock` (infra) — critical! Locks must be released before moving.
    h. **Move to blocked**: `npx taskflow move <task-id> blocked --force` — use `--force` because task was in `testing` (not in `allowMoveFromStates`)
    i. Write run log with summary listing all questions
    j. Notify the user

Only block if you have at least one question. If you can resolve it yourself through investigation, do so.

---

## SUMMARY — WRITE AFTER EVERY ACTION

Every run log entry MUST include a `summary` field — a natural language description of what the agent actually did.

**Examples of good summaries:**
- "Started testing task 'login-flow'. Read 2 test flows. Checking infrastructure: postgres on port 5434 is running, redis on port 6378 is running, core-api on port 3001 is responding."
- "Test flow 'Happy path' PASSED. Navigated to /login, filled credentials, clicked login, redirected to /dashboard successfully. User name displayed correctly."
- "Test flow 'Wrong password' FAILED. Clicked login with wrong password but no error message appeared. The API returned 200 instead of 401. Bug recorded in task YAML."
- "All 2 test flows passed (passRatio: 1.0). Moved task to review for user approval."

**When a test fails and you need user input, add a pending question:**
```yaml
pendingQuestions:
  - id: "q1"
    askedAt: "<now>"
    askedBy: "tester"
    question: "Test flow 'Wrong password' fails because the API returns 200 for wrong credentials. Is this expected behavior or a bug?"
    answered: false
```

---

## 1. Objective

Pick a task from `.tasks/testing/`, run its test flows, update results, and either move to review (only if passRatio >= required) or return to pending with bug info via `test-fail`.

## 2. Inputs

- `.tasks/` directory in the project
- `.tasks/config.yaml` — system configuration (browserMCP, infrastructure)

## 3. Detailed Procedure

### Step 1: Read config

Read `.tasks/config.yaml` to get:
- `heartbeat.intervalSeconds`, `heartbeat.staleThresholdSeconds`
- `test.passRatioRequired` — required pass ratio (default 1.0)
- `test.skipPassedFlows` — skip already-passed flows (default true)
- `test.infraLockRequired` — whether infra lock is required (default true)
- `browserMCP` — list of browser tools
- `infrastructure` — list of services and seed data

### Step 1.5: Read custom instructions

Read the following fields from `config.tester`:

- **`customInstructions`** (string, optional): User-defined supplementary instructions. Follow these throughout testing. Users may request:
  - Check specific logs before asserting
  - Take screenshots when UI tests fail
  - Use a specific debug tool
  - Any other guidance — the framework does not restrict this

- **`customSkills`** (array, optional): List of supplementary skills. Load them into context and use as needed.

- **`customTools`** (array, optional): List of supplementary tools.

**Note:** These custom instructions/skills/tools do not replace the framework — they supplement agent behavior while testing. The framework remains responsible for orchestration (lock, state, run log, versioning).

### Step 2: List testing tasks

Read all `.yaml` files in `.tasks/testing/`.

### Step 2.5: Switch to base branch (git flow only — if config.gitFlow.enabled)

If `config.gitFlow.enabled` is `true`, ensure you're testing on the base branch (which has the executor's merged code):

```bash
git checkout <config.gitFlow.baseBranch>
```

The executor has already merged their worktree branch into the base branch before moving the task to testing. You test the code on the base branch, NOT on a worktree.

If `config.gitFlow.enabled` is `false`, test on the current working tree.

### Step 3: Check locks

For each task file, check 2 locks:

1. **Task lock**: `.tasks/locks/task-<id>.lock`
   - If exists AND heartbeat is fresh → skip this task
   - If exists BUT heartbeat is stale → previous tester crashed → release stale lock, acquire new lock
   - If does not exist → task is available → select this task

2. **Infra lock**: `.tasks/locks/infra.lock`
   - If exists → cannot run any tests → sleep 30s, retry

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

### Step 4: Acquire locks

When a task is selected and infra is available, use the CLI helpers (do NOT write lock files by hand):

1. **Acquire infra lock first**:
   ```bash
   npx taskflow lock --infra
   ```
   If this exits 1, another tester holds the infra lock — wait and retry.

2. **Acquire task lock second**:
   ```bash
   npx taskflow lock <task-id> --agent tester
   ```

**Important order:** Infra lock first, task lock second. Release in reverse order (task lock first, infra lock second) — see Step 10.

### Step 5: Read task YAML

Read the task file from `.tasks/testing/<filename>.yaml`.

Fields to read:
- `testFlows` (array): List of test flows
- `testResults` (object): Current test status
- `version` (number): Remember for version change detection

### Step 6: Check browser MCP

Read `config.browserMCP`:
- This config only declares which already-connected MCP tools can be used for UI tests
- If at least 1 browser has `available: true` → UI tests can run
- If none available → **warn user**: "UI tests will not run on a real browser. Skipping UI steps."
- Still run non-UI assertions (DB, Redis, API) if applicable

### Step 7: Run test flows

For each flow in `testFlows`:

#### 7a. Check if already passed

Read `testResults.flows.<flow-name>.pass`:
- If `true` and `config.test.skipPassedFlows == true` → **skip**, do not run again
- If `false` or missing → run this flow

#### 7b. Check infrastructure (upgraded — dependency order + seed + interaction guides)

**Before running any test flow, check if the infrastructure is already up** to avoid unnecessary restarts:

```bash
npx taskflow check-infra <env>
```

This now checks in **dependency order** (components with `dependsOn` are checked after their dependencies). If a dependency is down, dependent components are reported as "skipped (dependency down)" instead of "fail".

If all required services are healthy → **skip setup, proceed to test flows directly** (saves time).

If some services are not available → set them up:

Read the flow's `environment` (natural language text). Cross-reference with `config.infrastructure.environments`:

1. **Identify the environment**: The flow mentions components → look them up in `config.infrastructure.environments.<env>.components`
2. **Read componentRelationships** to understand test design:
   - If test flow touches `web-server` → also verify `core-api` is healthy
   - If test flow touches `core-api` auth → also verify `cerbos` is healthy
   - If test flow touches file upload → also verify `clamav` + `cloudflare-r2`
3. **Setup missing components**:
   - Read `component.interactionGuide` for setup instructions
   - `component.setup.auto == true` → run `component.setup.command` with timeout
   - `component.setup.auto == false` → guide user via `component.setup.instruction`
   - **Remote components** (type: "remote" like Cloudflare R2, Map4D): check health only, cannot auto-setup. If down → warn user, do not block unless `required: true`
4. **Check seed data** (integrated into `check-infra`):
   - `npx taskflow check-infra <env>` now checks seed entries automatically
   - If seed missing and `seed.setup.auto == true` → auto-runs seed command
   - If seed missing and `seed.setup.auto == false` → guide user
5. **If a `required: true` component cannot start** → write `blockedReason`, release locks, notify user
6. **Re-run `npx taskflow check-infra <env>`** to confirm all services are healthy before proceeding.

> The tester has full authority to set up the infrastructure (docker compose up, npm run dev, seed data, etc.). Read `config.infrastructure.environments.<env>.components[].setup` and `components[].interactionGuide` for the exact commands and troubleshooting.

#### 7c. Run steps

Read `steps` (natural language text). The agent decides:
- Which MCP tool to use (browser_navigate, browser_click, browser_type, etc.)
- What to assert (URL, text, visible element, API response, DB query)

**During execution, heartbeat every `config.heartbeat.intervalSeconds` seconds** (both task lock and infra lock):

```bash
npx taskflow heartbeat <task-id>
npx taskflow heartbeat --infra
```

**Check version change every `config.heartbeat.intervalSeconds` seconds:**
- If `version` in the file differs from `taskVersion` in the lock:
  1. Run `npx taskflow unlock <task-id>` and `npx taskflow unlock` (infra)
  2. Write run log: "Task <id> has a new version (v<old> → v<new>). Skipping."
  3. Return to Step 1

> Note on flow-slug generation: when recording test results, the framework slugifies the flow name via `name.toLowerCase().replace(/[^a-z0-9]+/g, '-')`. This does NOT strip leading/trailing dashes — a flow named "  Hello World  " becomes slug `--hello-world--`. Keep your flow names clean (no leading/trailing spaces) to avoid surprising slug keys.

#### 7d. Record results — UPDATE STATUS AFTER EVERY FLOW

**CRITICAL:** After running each flow, you MUST update both the task YAML `testResults` AND the `statusDescription` via CLI. This is essential so subsequent loops know which flows passed/failed without re-running them.

**After each flow completes (pass or fail), update status:**
```bash
npx taskflow status-update <task-id> \
  --status "Tested flow <N>/<total>: '<flow-name>' <PASS|FAIL>. passRatio so far: X/Y" \
  --summary "Flow '<flow-name>' <result>. <brief description of what was tested>" \
  --action "test-flow-pass|test-flow-fail" \
  --agent-type tester \
  --agent-name "<session-id>"
```

**If flow passes:**
```yaml
testResults:
  lastRun: "2026-07-07T11:00:00Z"
  flows:
    happy-path: { pass: true, lastRun: "2026-07-07T11:00:00Z" }
    wrong-password: { pass: false, lastRun: null }
  passRatio: 0.5
```

**If flow fails:**
```yaml
testResults:
  lastRun: "2026-07-07T11:00:00Z"
  flows:
    happy-path: { pass: false, lastRun: "2026-07-07T11:00:00Z" }
    wrong-password: { pass: false, lastRun: null }
  passRatio: 0.0

bugs:
  - flow: "Happy path"
    description: |
      Clicking #login-btn did not redirect to /dashboard.
      URL remained at /login, no error message shown.
      Possibly the API endpoint is wrong or form submission is broken.
    foundAt: "2026-07-07T11:00:00Z"
```

**IMPORTANT — Skip already-passed flows:**
- Read `testResults.flows.<flow-slug>.pass` before each flow
- If `true` AND `config.test.skipPassedFlows == true` → **SKIP** this flow. Do NOT re-run it.
- This prevents wasting time re-testing flows that already passed in previous loops.
- Only run flows where `pass == false` or `lastRun == null`.

### Step 8: Calculate passRatio

After running all unpassed flows:

```
passRatio = number of flows with pass=true / total number of flows
```

### Step 9: Transition state

**CRITICAL: NEVER move a task to review if passRatio < config.test.passRatioRequired.**
The CLI `move` command enforces this — it will reject the move with an error. Do NOT use `--force` to bypass this guard.

**If passRatio >= config.test.passRatioRequired** (all required flows passed):
```bash
# Release locks first!
npx taskflow unlock <task-id>
npx taskflow unlock   # infra lock

# Then move to review (CLI will verify passRatio)
npx taskflow move <task-id> review --force
```
Reset `bounceCount` to 0 in the task YAML (test passed, bounce cycle broken).
Update statusDescription: "All tests passed (passRatio: X.X), moved to review".

**If passRatio < config.test.passRatioRequired** (at least 1 flow failed):
```bash
# Release locks first!
npx taskflow unlock <task-id>
npx taskflow unlock   # infra lock

# Then report failure with bounce detection
npx taskflow test-fail <task-id> --reason "<bug summary>" --agent-name "<session-id>"
```

The `test-fail` command automatically:
1. Increments `bounceCount`
2. Detects if the same bugs are repeating (same-bugs detector)
3. If `bounceCount >= maxBounces` (default 3) OR same bugs detected → auto-blocks the task
4. Otherwise → moves to `pending/` for executor re-pickup

**Before calling test-fail, check `bounceCount` in the task YAML:**
- If `bounceCount >= maxBounces - 1` (default: 2) → this is the **last chance** before auto-block. Test as thoroughly as possible. Every bug must be documented precisely.
- If `bounceCount >= maxBounces` → the task will be auto-blocked. Make sure `bugs[]` is comprehensive so the executor knows exactly what to fix.

### Step 10: Release locks

**Order:** Task lock first, infra lock second (reverse of the acquire order in Step 4).

```bash
npx taskflow unlock <task-id>    # release task lock
npx taskflow unlock               # release infra lock
```

## 4. State transitions performed by this skill

| From | To | When |
|------|----|------|
| testing | review | All flows pass (passRatio >= required) — use `npx taskflow move` |
| testing | pending | At least 1 flow fails (passRatio < required) — use `npx taskflow test-fail` |
| testing | blocked | Auto-blocked by `test-fail` when bounceCount >= maxBounces or same bugs detected |
| testing | testing | Version change — release locks only, no file move |

## 5. Run log entries

After each action, write an entry to `.tasks/runs/sessions/<sessionId>.md` and `.tasks/runs/tasks/<taskId>.md`:
- `test-start` — when locks are acquired. Summary: describe what task you're testing and what flows you'll run.
- `test-flow-pass` — each flow that passes. Summary: describe the steps executed and what was verified.
- `test-flow-fail` — each flow that fails. Summary: describe what failed, at which step, and the expected vs actual behavior. Also add a `pendingQuestion` if you need user clarification.
- `test-done` — when moved to review. Summary: describe overall test results, pass ratio, and what was verified.
- `test-fail` — when moved back to pending. Summary: describe which flows failed and what bugs were recorded.
- `test-stale` — when version change detected. Summary: describe that version changed and you're releasing locks.