---
name: taskflow-executor
description: Pick pending tasks, implement, acquire lock, heartbeat, move to testing. For executor agents.
---

# taskflow-executor

Instructions for the agent executing a task. The agent reads this skill to know how to pick a task, acquire a lock, implement, and transition state.

---

## 1. Objective

Pick a task from `.tasks/pending/`, implement according to the instructions, and move it to testing.

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
      path: ".opencode/skills/requirement-analysis/SKILL.md"
      description: "Skill for analyzing requirements before implementation"
  ```

- **`customTools`** (array, optional): List of supplementary tools. Use them if needed.

**Note:** These custom instructions/skills/tools do not replace the framework — they supplement agent behavior while executing the task. The framework remains responsible for orchestration (lock, state, run log, versioning).

### Step 2: List pending tasks

Read all `.yaml` files in `.tasks/pending/`.

File format: `.tasks/pending/YYYY-MM-DD_<task-name>_<seq>.yaml`

### Step 3: Check lock for each task

For each task file, check `.tasks/locks/task-<id>.lock`:
- If the lock file exists → another session is processing this task → **skip**
- If the lock file does not exist → task is available → select this task

**Lock file format (YAML):**
```yaml
sessionId: "<uuid>"
agentType: "executor"
taskVersion: 1
acquiredAt: "2026-07-07T10:00:00Z"
heartbeatAt: "2026-07-07T10:00:00Z"
```

### Step 4: Acquire lock

Once a task is selected:

1. Create `.tasks/locks/task-<id>.lock` with:
   ```yaml
   sessionId: "<uuid>"
   agentType: "executor"
   taskVersion: <task-yaml-version>
   acquiredAt: "<current-time>"
   heartbeatAt: "<current-time>"
   ```

2. Remember `sessionId` and `taskVersion` for later use

**Note:** If creating the lock file fails (file already exists due to race condition) → pick another task.

### Step 5: Read task YAML

Read the task file from `.tasks/pending/<filename>.yaml`.

Fields to read:
- `description` (string): What the task does
- `implementationNotes` (string, optional): Detailed implementation instructions
- `version` (number): Current version — remember this for version change detection

**Do not read** `testFlows` or `testResults` — those are for the tester.

### Step 6: Implement

Based on `description` and `implementationNotes`, implement the feature.

**During implementation, periodically every `config.heartbeat.intervalSeconds` seconds:**

1. **Heartbeat lock**: Update `heartbeatAt` in `.tasks/locks/task-<id>.lock`
2. **Check version**: Re-read the task YAML, compare `version` with `taskVersion` in the lock
   - If different → release lock, write run log action `implement-stale`, pick another task

### Step 7: Completion

When implementation is done:

1. **Move file**: `pending/` → `processing/` → `testing/`
2. **Write run log** action `implement-start` when task moves to `processing`
3. **Reset testResults** in the task YAML
4. **Write run log** action `implement-done` when task moves to `testing`
5. **Release lock**: Delete `.tasks/locks/task-<id>.lock`

### Step 8: Handle blocked

If an issue cannot be resolved:

1. Write `blockedReason` into the task YAML
2. Write run log action `implement-blocked`
3. Release lock
4. Notify the user

## 4. State transitions performed by this skill

| From | To | When |
|------|----|------|
| pending | processing | Starting implementation (Step 7.1) |
| processing | testing | Implementation complete (Step 7.3) |
| processing | pending | Version change (Step 6.2) — release lock only, no file move |

## 5. Run log entries

After each action, write an entry to `.tasks/runs/YYYY-MM-DD.yaml`:
- `pickup` — when lock is acquired
- `implement-start` — when task moves to `processing`
- `implement-done` — when moved to testing
- `implement-blocked` — when blocked
- `implement-stale` — when version change detected