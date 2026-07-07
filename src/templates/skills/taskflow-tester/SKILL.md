---
name: taskflow-tester
description: Pick testing tasks, run test flows, acquire locks, check infrastructure, move to review or back to processing. For tester agents.
---

# taskflow-tester

Instructions for the agent testing a task. The agent reads this skill to know how to pick a task, acquire locks, run test flows, and transition state.

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

### Step 3: Check locks

For each task file, check 2 locks:

1. **Task lock**: `.tasks/locks/task-<id>.lock`
   - If exists → skip this task

2. **Infra lock**: `.tasks/locks/infra.lock`
   - If exists → cannot run any tests → sleep 30s, retry

### Step 4: Acquire locks

When a task is selected and infra is available:

1. **Acquire infra lock first**:
   ```yaml
   # .tasks/locks/infra.lock
   sessionId: "<uuid>"
   acquiredAt: "<current-time>"
   heartbeatAt: "<current-time>"
   ```

2. **Acquire task lock**:
   ```yaml
   # .tasks/locks/task-<id>.lock
   sessionId: "<uuid>"
   agentType: "tester"
   taskVersion: <task-yaml-version>
   acquiredAt: "<current-time>"
   heartbeatAt: "<current-time>"
   ```

**Important order:** Infra lock first, task lock second. Release in reverse order.

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

#### 7b. Check infrastructure

Read the flow's `environment` (natural language text). Cross-reference with `config.infrastructure.environments`:

1. **Identify the environment**: The flow mentions services → look them up in `config.infrastructure.environments.<env>.services`
2. **Check each service**:
   - `service.check.method == "port"` → check port `service.check.port` on `service.check.host`
   - `service.check.method == "http"` → GET `service.check.url`, assert status = `service.check.expectedStatus`
   - `service.check.method == "command"` → run command, check exit code
3. **If service is not running**:
   - `service.setup.auto == true` → run `service.setup.command` with timeout `service.setup.timeoutSeconds`
   - `service.setup.auto == false` → guide user via `service.setup.instruction`
4. **Check seed data**:
   - Look up `config.infrastructure.seed` → verify each seed via `seed.check.method`
   - If missing → run `seed.setup.command`
5. **If a `required: true` service cannot start** → write `blockedReason`, release locks, notify user

#### 7c. Run steps

Read `steps` (natural language text). The agent decides:
- Which MCP tool to use (browser_navigate, browser_click, browser_type, etc.)
- What to assert (URL, text, visible element, API response, DB query)

**During execution, heartbeat every `config.heartbeat.intervalSeconds` seconds** (both task lock and infra lock).

**Check version change every `config.heartbeat.intervalSeconds` seconds:**
- If `version` in the file differs from `taskVersion` in the lock:
  1. Release task lock + infra lock
  2. Write run log: "Task <id> has a new version (v<old> → v<new>). Skipping."
  3. Return to Step 1

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

**Order:** Task lock first, infra lock second.

1. Delete `.tasks/locks/task-<id>.lock`
2. Delete `.tasks/locks/infra.lock`

## 4. State transitions performed by this skill

| From | To | When |
|------|----|------|
| testing | review | All flows pass (passRatio >= required) |
| testing | processing | At least 1 flow fails (passRatio < required) |
| testing | testing | Version change — release locks only, no file move |

## 5. Run log entries

After each action, write an entry to `.tasks/runs/YYYY-MM-DD.yaml`:
- `test-start` — when locks are acquired
- `test-flow-pass` — each flow that passes
- `test-flow-fail` — each flow that fails (with bug description)
- `test-done` — when moved to review
- `test-fail` — when moved back to processing
- `test-stale` — when version change detected