---
name: taskflow-user
description: Help users interact with the task system. List, add, edit, approve, reject tasks. For user-facing agents.
---

# taskflow-user

Instructions for the agent assisting the user with the task system. The user speaks commands, and the agent reads this skill to know how to respond.

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

| From | To | Performed by | Condition |
|------|----|-------------|-----------|
| defined | pending | User | Move task to make it available for executor |
| pending | processing | Executor | Pick up task, acquire lock |
| processing | testing | Executor | Code done, self-triage |
| processing | pending | Executor | Version change → release lock |
| testing | review | Tester | All flows pass (passRatio >= 1.0) |
| testing | processing | Tester | Flow fails → update task with bug info |
| review | done | User | Approve |
| review | pending | User | Reject |
| pending | pending | User | Edit task → version++ |
| defined | defined | User | Edit task → version++ |
| processing | blocked | Executor | Has questions, cannot proceed |
| testing | blocked | Tester | Has questions, cannot proceed |
| blocked | processing | User | Questions resolved, return to processing |
| blocked | testing | User | Questions resolved, return to testing |
| blocked | pending | User | Questions resolved, return to pending |

### 1.3 Lock Mechanism

- **File-based mutex lock** (create-exclusive: `O_CREAT | O_EXCL`)
- Only acquired when task is in `processing` or `testing`
- Heartbeat interval: `config.heartbeat.intervalSeconds` (default 60s)
- Stale threshold: `config.heartbeat.staleThresholdSeconds` (default 120s)
- Lock-releaser agent runs a cleanup loop for stale locks
- Agent must release lock when: transitioning state, version change detected, session ends

### 1.4 Versioning

- When editing a task in `processing` or `testing`:
  1. Snapshot current `description`, `implementationNotes`, `testFlows` into `versions.v<old>`
  2. Brainstorm with user
  3. Update task, bump version, reset testResults
  4. Move file to `pending/`
- When editing a task in `pending`: directly, no snapshot needed

### 1.5 Run Log

- Every action is recorded in `.tasks/runs/YYYY-MM-DD.yaml`
- 15 action types: pickup, implement-done, implement-blocked, implement-stale, test-start, test-flow-pass, test-flow-fail, test-done, test-fail, test-stale, approve, reject, edit, add, move
- View with: `npx taskflow runs [--date] [--task] [--agent]`

### 1.6 Custom Instructions

- Users can add custom instructions in `config.executor.customInstructions` and `config.tester.customInstructions`
- These do not conflict with the framework — the framework orchestrates, custom instructions guide agent behavior
- Users can also add custom skills (`customSkills`) and custom tools (`customTools`)

### 1.7 Blocked State

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

A notifier agent sends alerts through configured channels. The user resolves questions via `resolve-blocked` command, which moves the task back to its `previousState`.

### 1.8 Run Log Summaries

Every run log entry includes a `summary` field — a natural language description of what the agent actually did. This helps humans understand what happened without reading code or YAML. View summaries with:

```bash
npx taskflow runs --task <id>      # Task history with summaries
npx taskflow runs --session <id>   # Session history with summaries
```

### 1.9 Available Skills

| Skill | Role |
|-------|------|
| `taskflow-executor` | Pick tasks from pending, implement, move to testing |
| `taskflow-tester` | Pick tasks from testing, run test flows, move to review or back to processing |
| `taskflow-lock-releaser` | Loop to clean up stale locks |
| `taskflow-user` | (This skill) Help the user interact |
| `taskflow-init` | Bootstrap the framework into a project |
| *Custom skills* | User-defined in `executor.customSkills` / `tester.customSkills` |

---

## 2. User Commands

### 2.1 `list [state]` — View task list

Read `.tasks/<state>/` and list all `.yaml` files. Valid states: `defined`, `pending`, `processing`, `testing`, `review`, `done`.

Display: ID, Name, Version, UpdatedAt, passRatio (if testing).

### 2.2 `add <name>` — Create a new task

1. Brainstorm with the user to clarify: description, implementationNotes, testFlows
2. Create YAML file in `.tasks/defined/` with format `YYYY-MM-DD_<slug>_<seq>.yaml`
3. Task is created in `defined` state — NOT available for executor pickup
4. User must `move <id> pending` to make it available for executor
5. Write run log action `add`

### 2.3 `edit <id>` — Edit a task

**If task is in defined or pending:**
1. Brainstorm with the user about changes
2. Update task YAML, bump `version++`
3. Reset `testResults` if `testFlows` exist
4. Write run log action `edit`

**If task is in processing or testing (versioning flow):**
1. Snapshot current `description`, `implementationNotes`, `testFlows` into `versions.v<old>`
2. Brainstorm with the user
3. Update task YAML, bump `version++`, reset `testResults`
4. Move file to `pending/`
5. Write run log action `edit`

### 2.4 `approve <id>` — Approve a task

1. Verify task is in `review/`
2. Move `review/` → `done/`
3. Write run log action `approve`

### 2.5 `reject <id>` — Reject a task

1. Verify task is in `review/`
2. Brainstorm the reason for rejection
3. Write `blockedReason` into the task YAML
4. Move `review/` → `pending/`
5. Write run log action `reject`

### 2.6 `move <id> <state>` — Manually move a task

**Rules:**
- Only allowed from states in `config.user.allowMoveFromStates` (default: `defined`, `pending`)
- Other states must go through proper transitions
- Common use: `move <id> pending` to make a `defined` task available for executor pickup

### 2.7 `resolve-blocked [id]` — Resolve blocked tasks

List all blocked tasks (or a specific task by ID) with their pending questions:

1. Read `.tasks/blocked/` for blocked tasks
2. Display task name, previous state, and all unanswered questions grouped by category
3. To resolve: edit the task YAML, set `answered: true` and provide `answer` for each question
4. Run `npx taskflow resolve-blocked <id>` again — if all questions answered, task moves back to `previousState`
5. Write run log action `resolve-blocked` with summary

### 2.8 `setup-custom <executor|tester>` — Configure custom instructions

1. Ask: "What instructions would you like to add for [executor|tester]?"
2. Record the content, update `config.yaml`
3. If the user wants custom skills:
   - Ask for skill name and description
   - Create `.agents/skills/<name>/SKILL.md` with a basic template
   - Update the path in config
4. If the user wants custom tools:
   - Ask for tool name and type (MCP, script, etc.)
   - Update config

---

## 3. Important Rules

| Rule | Description |
|------|-------------|
| **Only edit pending directly** | Tasks in processing/testing must go through versioning |
| **Versioning is mandatory** | When editing an active task, snapshot the old version |
| **Reset testResults** | When version changes, testResults must be reset |
| **Do not skip review** | Tasks must go through review before reaching done |
| **Do not force unlock** | Use `taskflow unlock` CLI if necessary |
| **Custom instructions do not replace the framework** | The framework orchestrates (lock, state, run log), custom instructions guide the agent on how to do the task |

## 4. Special Cases

| Situation | Action |
|-----------|--------|
| User wants to edit a done task | Create a new task with version 1, do not modify the old one |
| User wants to delete a task | Move to `.tasks/done/` with a "deleted by user" note |
| User does not remember the ID | Use `list` to view, copy the ID from there |
| User wants custom instructions but is unsure what to add | Suggest common use cases: use brainstorming, reference docs, run lint, take screenshots on test failure, check logs... |