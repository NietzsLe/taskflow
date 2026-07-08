---
name: taskflow-executor
description: Pick pending tasks, implement, acquire lock, heartbeat, move to testing. For executor agents.
---

# taskflow-executor

Instructions for the agent executing a task. The agent reads this skill to know how to pick a task, acquire a lock, implement, and transition state.

---

## STRICT BOUNDARIES — READ BEFORE DOING ANYTHING

- Executor ONLY reads from `.tasks/pending/`
- Executor ONLY moves tasks: `pending → processing → testing`
- Executor MUST NEVER touch `.tasks/defined/`, `.tasks/testing/`, `.tasks/review/`, `.tasks/done/`
- Executor MUST NEVER move a task to `review` or `done` — that's Tester/User only
- If no tasks in `pending/` → **STOP immediately. Do NOT create new tasks.**
- The `/loop` mechanism will restart to retry later.

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
   f. Move task to `blocked/` ONCE
   g. Write run log with summary listing all questions
   h. Release lock and STOP

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
      path: ".agents/skills/requirement-analysis/SKILL.md"
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

Once a task is selected, acquire the lock using the CLI helper (this is the only safe, atomic way — do NOT write the lock file by hand):

```bash
npx taskflow lock <task-id> --agent executor
```

On success, this prints the lock YAML (including the generated `sessionId`). **Remember the `sessionId` and `taskVersion`** for later use — you will need them for heartbeat and release.

If the command exits 1 ("already locked") → another session has the task → pick another task.

> The lock file is written to `.tasks/locks/task-<id>.lock` using `O_CREAT | O_EXCL` (atomic create-exclusive) under the hood.

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

1. **Heartbeat lock**: Run `npx taskflow heartbeat <task-id>` to update `heartbeatAt`.
2. **Check version**: Re-read the task YAML, compare `version` with `taskVersion` in the lock
   - If different → run `npx taskflow unlock <task-id>`, write run log action `implement-stale`, pick another task

### Step 7: Completion

When implementation is done:

1. **Move to processing**: Move file `pending/` → `processing/`. Write run log action `implement-start`.
2. **Move to testing**: Move file `processing/` → `testing/`. Reset `testResults` in the task YAML. Write run log action `implement-done`.
3. **Release lock**: Run `npx taskflow unlock <task-id>` to delete `.tasks/locks/task-<id>.lock`.

> Note: Steps 7.1 and 7.2 are two separate state transitions (`pending → processing`, then `processing → testing`), not a single combined move.

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
| processing | testing | Implementation complete (Step 7.2) |
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