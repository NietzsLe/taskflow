---
name: taskflow-tester
description: Pick testing tasks, run test flows, acquire locks, check infrastructure, move to review or back to processing. For tester agents.
---

# taskflow-tester

Instructions for the agent testing a task. The agent reads this skill to know how to pick a task, acquire locks, run test flows, and transition state.

---

## STRICT BOUNDARIES — READ BEFORE DOING ANYTHING

- Tester ONLY reads from `.tasks/testing/`
- Tester ONLY moves tasks: `testing → review` (all pass) or `testing → processing` (fail)
- Tester MUST NEVER move a task to `done` — that's User only
- Tester MUST NEVER touch `.tasks/defined/`, `.tasks/pending/`, `.tasks/processing/`, `.tasks/review/`, `.tasks/done/`
- If no tasks in `testing/` → **STOP immediately. Do NOT create new tasks.**
- The `/loop` mechanism will restart to retry later.

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
   f. Move task to `blocked/` ONCE
   g. Write run log with summary listing all questions
   h. Release locks and STOP

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

Pick a task from `.tasks/testing/`, run its test flows, update results, and either move to review or return to processing with bug info.

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
   - If exists → skip this task

2. **Infra lock**: `.tasks/locks/infra.lock`
   - If exists → cannot run any tests → sleep 30s, retry

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

#### 7b. Check infrastructure (check first, setup only if needed)

**Before running any test flow, check if the infrastructure is already up** to avoid unnecessary restarts:

```bash
npx taskflow check-infra <env>
```

If all required services are healthy → **skip setup, proceed to test flows directly** (saves time).

If some services are not available → set them up:

Read the flow's `environment` (natural language text). Cross-reference with `config.infrastructure.environments`:

1. **Identify the environment**: The flow mentions services → look them up in `config.infrastructure.environments.<env>.services`
2. **Setup missing services**:
   - `service.setup.auto == true` → run `service.setup.command` with timeout `service.setup.timeoutSeconds`
   - `service.setup.auto == false` → guide user via `service.setup.instruction`
3. **Check seed data**:
   - Look up `config.infrastructure.seed` → verify each seed via `seed.check.method`
   - If missing → run `seed.setup.command`
4. **If a `required: true` service cannot start** → write `blockedReason`, release locks, notify user
5. **Re-run `npx taskflow check-infra <env>`** to confirm all services are healthy before proceeding.

> The tester has full authority to set up the infrastructure (docker compose up, npm run dev, seed data, etc.). Read `config.infrastructure.environments.<env>.services[].setup` for the exact commands.

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

#### 7d. Record results

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

### Step 8: Calculate passRatio

After running all unpassed flows:

```
passRatio = number of flows with pass=true / total number of flows
```

### Step 9: Transition state

**If passRatio >= config.test.passRatioRequired** (all flows passed):
```
.tasks/testing/2026-07-07_login-flow_001.yaml
→ .tasks/review/2026-07-07_login-flow_001.yaml
```

**If passRatio < config.test.passRatioRequired** (at least 1 flow failed):
```
.tasks/testing/2026-07-07_login-flow_001.yaml
→ .tasks/processing/2026-07-07_login-flow_001.yaml
```
The task goes back to processing with bug info so the executor knows what to fix.

### Step 10: Release locks

**Order:** Task lock first, infra lock second (reverse of the acquire order in Step 4).

```bash
npx taskflow unlock <task-id>    # release task lock
npx taskflow unlock               # release infra lock
```

## 4. State transitions performed by this skill

| From | To | When |
|------|----|------|
| testing | review | All flows pass (passRatio >= required) |
| testing | processing | At least 1 flow fails (passRatio < required) |
| testing | testing | Version change — release locks only, no file move |

## 5. Run log entries

After each action, write an entry to `.tasks/runs/sessions/<sessionId>.md` and `.tasks/runs/tasks/<taskId>.md`:
- `test-start` — when locks are acquired. Summary: describe what task you're testing and what flows you'll run.
- `test-flow-pass` — each flow that passes. Summary: describe the steps executed and what was verified.
- `test-flow-fail` — each flow that fails. Summary: describe what failed, at which step, and the expected vs actual behavior. Also add a `pendingQuestion` if you need user clarification.
- `test-done` — when moved to review. Summary: describe overall test results, pass ratio, and what was verified.
- `test-fail` — when moved back to processing. Summary: describe which flows failed and what bugs were recorded.
- `test-stale` — when version change detected. Summary: describe that version changed and you're releasing locks.