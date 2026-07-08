# TaskFlow

**Foundation layer for loop engineering** — reliable state machine, coordination protocol, and run-log substrate that multi-agent loops run on top of.

```
npx taskflow init        # Scaffold loop state directory
npx taskflow add "..."   # Define a loop task
npx taskflow list        # Inspect loop state
```

TaskFlow is not a prompting tool. It is the **control plane** for loop engineering: a file-based coordination layer that gives multi-agent loops a durable state machine, mutex-based safety, versioned task definitions, and an append-only run log. Design the loop on top; TaskFlow handles the orchestration.

> **Philosophy:** Don't prompt agents manually. Design the loop. Let TaskFlow handle state, locking, and history.

> **⚠️ Tool support:** TaskFlow is currently designed and tested for **Opencode**. Other coding agents (Claude Code, Codex, Cursor, etc.) can use the file-based primitives directly, but the skill templates, agent instructions, and loop patterns are optimized for Opencode's agent model. Contributions to add first-class support for other tools are welcome.

---

## Loop Engineering — Concepts & Mapping

Loop engineering replaces manual prompting with a **control system** that orchestrates agents over time. The five building blocks (+ memory) defined by the loop engineering community map directly to TaskFlow primitives:

| Loop Primitive | TaskFlow Primitive | What It Provides |
|---|---|---|
| **State / Memory** | `.tasks/` state directories + run logs | Durable spine outside any conversation — 7-state machine, append-only session/task logs |
| **Scheduling / Automation** | `pending/` → agent pickup cycle | Agents discover work via file system; cron/systemd can trigger `taskflow list pending` |
| **Sub-agents** | Agent skills (executor, tester, user) | Pre-defined roles with strict state transition boundaries; custom skills via config |
| **Worktrees** | `taskflow worktree` commands (opt-in git flow) | Isolated execution per task — create, commit, merge, revert, cleanup |
| **Safety / Locking** | Mutex locks + heartbeat protocol | `O_CREAT \| O_EXCL` atomic acquire, stale detection, lock-releaser cleanup |
| **Human Gate** | `blocked/` state + `pendingQuestions` | Agent collects all questions → blocks once → user resolves → loop continues |
| **Run Log / Audit** | `.tasks/runs/` (sessions + tasks) | Append-only markdown, trimming, filtering by agent/task/result |

### How a Loop Runs on TaskFlow

```
┌─────────────────────────────────────────────────────────────┐
│  Loop Controller (cron, systemd, /loop, CI/CD)              │
│  "Every N minutes, check pending/ and dispatch an agent"    │
└──────────┬──────────────────────────────────────────────────┘
           │ triggers
           ▼
┌─────────────────────┐     ┌──────────────────────────────┐
│  Agent picks task   │────►│  Acquires lock, heartbeats   │
│  from pending/      │     │  implements, moves to testing │
└─────────────────────┘     └──────────┬───────────────────┘
                                       │
                          ┌────────────▼────────────┐
                          │  Tester runs flows      │
                          │  pass → review/         │
                          │  fail → processing/     │
                          │  question → blocked/    │
                          └────────────┬────────────┘
                                       │
                          ┌────────────▼────────────┐
                          │  Human reviews → done/  │
                          │  or rejects → pending/  │
                          └─────────────────────────┘
```

Every transition is logged, every lock is heartbeated, every version is tracked. The loop controller only needs to check `pending/` and dispatch agents — TaskFlow handles the rest.

---

## Quick Start

```bash
# Install into your project
npx taskflow init

# Create a task
npx taskflow add "My first task"

# List tasks
npx taskflow list

# Approve a completed task
npx taskflow approve <task-id>
```

---

## Architecture

```
.tasks/                          # Created by `taskflow init`
├── config.yaml                  # System configuration
├── defined/                     # Tasks defined but not yet ready for executor
├── pending/                     # Tasks ready to be picked up by executor
├── processing/                  # Tasks being implemented
├── testing/                     # Tasks being tested
├── review/                      # Tasks awaiting human approval
├── done/                        # Completed tasks
├── blocked/                     # Tasks blocked pending user questions
├── locks/                       # Mutex lock files
│   ├── task-<id>.lock
│   └── infra.lock
└── runs/                        # Run log — organized by session and task
    ├── sessions/                 # One .md file per agent session
    │   ├── abc-123.md
    │   └── def-456.md
    ├── tasks/                    # One .md file per task (full history)
    │   ├── login-flow_001.md
    │   └── filter-tx_002.md
    ├── .seq                      # Global run counter
    ├── notifier-log.md           # Notifier log
    └── releaser-log.md           # Lock-releaser log
```

### File naming convention

```
YYYY-MM-DD_<task-name>_<seq>.yaml
```

Example: `2026-07-07_login-flow_001.yaml`

---

## State Machine

The 7-state machine is the core of TaskFlow's loop substrate. Every state transition is validated, logged, and (when active) lock-protected.

```
defined ──(user move)──► pending ──(executor)──► processing ──(executor done)──► testing
                              │                       │ │                         │
                         (block) │ (block)            (all pass?)
                              ▼                       ▼   ▼                       │
                          blocked                   blocked                  ┌────┴────┐
                              │                       │                      ▼         ▼
                     (resolve)│                (resolve)│                 review    processing
                              ▼                       ▼                      │    (with bugs)
                        processing                 testing                    │
                              └──────────(user reject)─────────────────────►─── done
```

| From | To | By | Condition |
|------|----|----|-----------|
| defined | pending | User | Move task to make it available for executor |
| pending | processing | Executor / User | Pick up task, acquire lock (executor) or manual override (user) |
| pending | testing | User | Manual override |
| pending | review | User | Manual override |
| pending | done | User | Manual override |
| processing | testing | Executor | Implementation done |
| processing | pending | Executor | Version change detected |
| processing | blocked | Executor | Has questions, cannot proceed |
| testing | review | Tester | All flows pass |
| testing | processing | Tester | Flow fails |
| testing | blocked | Tester | Has questions, cannot proceed |
| blocked | processing | User | Questions resolved |
| blocked | testing | User | Questions resolved |
| blocked | pending | User | Questions resolved |
| review | done | User | Approve |
| review | pending | User | Reject |
| done | _(terminal)_ | — | No transitions out |

---

## Lock Mechanism

TaskFlow uses **file-based mutex locks** (no Redis, no database) — a lightweight safety layer for loop engineering.

- **Task lock** (`.tasks/locks/task-<id>.lock`): Prevents two sessions from working on the same task
- **Infra lock** (`.tasks/locks/infra.lock`): Ensures only one tester runs against the dev infrastructure at a time

### Heartbeat protocol

| Parameter | Default | Description |
|-----------|---------|-------------|
| Heartbeat interval | 60s | Agent updates `heartbeatAt` periodically |
| Stale threshold | 120s | Lock released if no heartbeat in 120s |
| Lock-releaser interval | 60s | Cleanup agent checks every 60s |

Lock acquisition uses `O_CREAT | O_EXCL` (create-exclusive) for atomicity.

---

## Notifications

The notifier agent runs periodic check cycles to detect task state changes and notify the user. Each cycle:

1. It reads `.tasks/config.yaml` to discover all notification channels
2. It builds a JSON snapshot of every task's state, version, bounce count, lock status, etc.
3. It compares against the previous snapshot (stored in `.tasks/runs/notifier-state.json`)
4. It formats a report with:
   - **Summary** for normal changes (transitions, new tasks, version bumps, resolved blocks)
   - **Detailed** for issues (newly blocked tasks with questions, bounce threshold hits, stale locks)
5. It sends the report through all enabled notification channels
6. It saves the new snapshot for the next cycle

### First run

On the first run (no previous snapshot), the notifier reports ALL existing tasks as "new" and sends an initial framework overview.

### Detected changes

| Change | Detail level |
|--------|-------------|
| Task state transition | Summary |
| New task created | Summary |
| Task removed (archived) | Summary |
| Version bump | Summary |
| Resolved block | Summary |
| Newly blocked | Detailed (questions, context, run log) |
| Bounce threshold hit | Detailed (bounce count, max, bug history) |
| Stale lock | Detailed (session ID, elapsed seconds) |

### Active channels only

Only channels with `enabled: true` are active. Disabled channels are skipped. Set `enabled: false` on channels you don't need — don't delete them, so you can re-enable later.

Default active channels: `console` (terminal output) + `file` (`.tasks/notifications.log`).

### Multiple instances per type

One channel type (e.g. `webhook`) can have multiple instances — use the `name` field to distinguish them:

```yaml
notification:
  channels:
    - name: "slack-alerts"
      type: "webhook"
      enabled: true
      url: "https://hooks.slack.com/services/..."
      format: "slack"
      guide: "..."
    - name: "discord-alerts"
      type: "webhook"
      enabled: true
      url: "https://discord.com/api/webhooks/..."
      format: "discord"
      guide: "..."
```

The `name` field is optional but strongly recommended when you have more than one instance of the same type.

### Channel types

| Type | Default | How it sends |
|------|---------|--------------|
| `console` | enabled | Prints to terminal |
| `file` | enabled | Appends to file (`path` field) |
| `webhook` | disabled | HTTP POST to `url` with format (slack/discord/teams/generic) |
| `email` | disabled | SMTP send (`smtpHost`, `smtpPort`, `smtpUser`, `smtpPassword`, `from`, `to`) |
| `custom` | disabled | Agent reads `guide` and follows the custom instructions |

Every channel has a `guide` field — natural language instructions the agent reads to know how to send. This is the core design: the agent reads the guide and acts, no hardcoded sending logic.

### Testing notification channels

You should test notification channels before relying on them. TaskFlow provides two ways:

1. **During `taskflow init`** (Step 3.5 of the init skill) — after scaffolding, the agent sends a test message through each active channel and asks you to confirm receipt.

2. **Via the user skill** — say "test notif" or "test notifications" to the agent. The agent sends a test message through each active channel, asks you to confirm, and reports pass/fail per channel.

The test message format:
```
TaskFlow test — channel <type>/<name> at <timestamp>
This is a test. No action needed.
```

Failed channels should be fixed (per their `guide`) or disabled (`enabled: false`). Untested channels may silently fail when a real task gets blocked.

### Environment variables

Secrets (SMTP passwords, webhook URLs) can be referenced via `${ENV_VAR}` or `${ENV_VAR:default}` in config to avoid hardcoding:

```yaml
- name: "email-default"
  type: "email"
  enabled: true
  smtpPassword: ${TF_SMTP_PASS}
  # ...
```

### CLI

Run the notifier on-demand:

```bash
npx taskflow notify              # Run one check cycle
npx taskflow notify --dry-run    # Show report without sending
npx taskflow notify --reset      # Clear snapshot (next run reports all as new)
```

### Run log

Notifier cycles are recorded in two places:
- `.tasks/runs/notifier-log.md` — dedicated notifier log
- `.tasks/runs/sessions/` — main run log (filter with `npx taskflow runs --agent notifier`)

---

## Task YAML Schema

Each task is a single YAML file containing all metadata, implementation notes, test flows, and version history.

```yaml
id: login-flow_001
name: "Login Flow"
createdAt: 2026-07-07T10:00:00Z
updatedAt: 2026-07-07T10:00:00Z
version: 2

description: |
  User logs in with email and password.
  On success, redirect to dashboard.
  On wrong password, show error message.

implementationNotes: |
  ## Implementation guide
  - Use NextAuth.js for authentication
  - Login form at /login with email + password fields
  - API endpoint: POST /api/auth/login
  - Token stored in httpOnly cookie
  - Dashboard route: /dashboard (protected)
  - Error state: show message below the form

testFlows:
  - name: "Happy path"
    environment: |
      Services needed:
      - Web server (Next.js) on port 2999
      - Core API (NestJS) on port 3001
      - PostgreSQL on port 5434
      - Redis on port 6378

      Setup steps:
      1. Run `docker compose -f docker-compose.dev.yml up -d`
      2. Run `cd core-api && npm run reset:dev`
      3. Run `cd web-server && npm run dev`

      Admin user: admin@test.com / pass123
    steps: |
      1. Open browser to /login
      2. Type "admin@test.com" into #email
      3. Type "pass123" into #password
      4. Click #login-btn
      5. Wait for redirect, assert URL is /dashboard
      6. Check .user-name shows "Admin User"

  - name: "Wrong password"
    steps: |
      1. Open browser to /login
      2. Type "admin@test.com" into #email
      3. Type "wrongpass" into #password
      4. Click #login-btn
      5. Check .error-message is visible

testResults:
  lastRun: null
  flows:
    happy-path: { pass: false, lastRun: null }
    wrong-password: { pass: false, lastRun: null }
  passRatio: 0.0

versions:
  v1:
    updatedAt: 2026-07-06T15:00:00Z
    description: "Original login flow"
    implementationNotes: |
      ...
    testFlows:
      - name: "Happy path"
        steps: |
          ...
```

---

## Agent Skills

TaskFlow installs 6 skills into `.agents/skills/` during `init`. These are the **sub-agent definitions** for loop engineering — each skill defines a role with strict state boundaries.

| Skill | Location | Purpose |
|-------|----------|---------|
| `taskflow-init` | `.agents/skills/` | Bootstrap the framework into a project |
| `taskflow-executor` | `.agents/skills/` | Pick pending tasks, implement, move to testing |
| `taskflow-tester` | `.agents/skills/` | Pick testing tasks, run flows, move to review or back |
| `taskflow-lock-releaser` | `.agents/skills/` | Run one check cycle to clean up stale locks |
| `taskflow-notifier` | `.agents/skills/` | Run one check cycle to detect task state changes and notify the user |
| `taskflow-user` | `.agents/skills/` | Help the user interact with the system |

### How to use

```bash
# Agent: "use taskflow-executor" → agent reads the skill and acts on pending tasks
# Agent: "use taskflow-tester" → agent reads the skill and acts on testing tasks
# Agent: "use taskflow-lock-releaser" → agent runs cleanup loop
# Agent: "list tasks" or "approve <id>" → agent uses taskflow-user skill
```

---

## Configuration

File: `.tasks/config.yaml`

```yaml
heartbeat:
  intervalSeconds: 60
  staleThresholdSeconds: 120

test:
  passRatioRequired: 1.0
  skipPassedFlows: true

browserMCP:
  - name: "playwriter"
    available: true
    description: "Playwriter MCP — browser automation tool"
    # Note: The agent must have this MCP tool connected already.
    # This config only declares which connected tools are available for UI testing.

infrastructure:
  environments:
    dev:
      services:
        - name: "core-api"
          type: "process"
          check:
            method: "http"
            url: "http://localhost:3001/health"
          setup:
            auto: false
            instruction: "Open a new terminal and run npm run start:dev"
          required: true
```

### Custom instructions

You can add custom instructions for executor and tester agents:

```yaml
executor:
  customInstructions: |
    ## Supplementary instructions for the Executor Agent
    - Use the brainstorming skill before implementing
    - Reference docs/design before writing code
    - Run npm run lint -- --fix after implementation
  customSkills:
    - name: "requirement-analysis"
      path: ".agents/skills/requirement-analysis/SKILL.md"
      description: "Skill for analyzing requirements before implementation"
  customTools: []

tester:
  customInstructions: |
    ## Supplementary instructions for the Tester Agent
    - Check logs before asserting
    - Take screenshots on UI test failure
  customSkills:
    - name: "log-analysis"
      path: ".agents/skills/log-analysis/SKILL.md"
  customTools: []
```

Custom instructions/skills/tools do **not** conflict with the framework. The framework handles orchestration (lock, state, run log, versioning). Custom instructions only guide the agent's behavior during execution.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `npx taskflow init` | Scaffold `.tasks/` directory and install skills to `.agents/skills/` |
| `npx taskflow init --force` | Backup existing `.tasks/` and re-init from scratch |
| `npx taskflow add <name>` | Create a new task in `defined/` |
| `npx taskflow list [state]` | List tasks by state (defined, pending, processing, testing, review, done, blocked) |
| `npx taskflow status <id>` | Show detailed task info |
| `npx taskflow edit <id>` | Edit a task (always creates new version snapshot) |
| `npx taskflow move <id> <state>` | Move a task (from defined/pending/blocked; `--force` to override lock) |
| `npx taskflow approve <id>` | Move task from `review/` to `done/` |
| `npx taskflow reject <id> [-r,--reason <text>]` | Move task from `review/` back to `pending/`; optionally write `blockedReason` |
| `npx taskflow unlock [id]` | Force release a lock (without args: infra lock) |
| `npx taskflow unlock --all` | Release all locks |
| `npx taskflow lock <id> [--infra] [--agent executor\|tester]` | Acquire a task or infra lock (for agent use) |
| `npx taskflow heartbeat <id> [--infra]` | Update heartbeat on a lock (for agent use) |
| `npx taskflow answer <id> <questionId> <text>` | Answer a pending question on a blocked task |
| `npx taskflow delete <id>` | Archive a task (move to `.tasks/archive/` with a deletion note) |
| `npx taskflow doctor` | Run health checks on `.tasks/`, config, locks, and skills |
| `npx taskflow config [list\|get\|set]` | View/set config values (e.g. `config get heartbeat.staleThresholdSeconds`) |
| `npx taskflow skills [list\|verify]` | List or verify installed agent skills |
| `npx taskflow export <id> [-f json\|yaml]` | Export a task to stdout |
| `npx taskflow import <file>` | Import a task from a JSON or YAML file into `defined/` |
| `npx taskflow clean [--before <date>] [--dry-run]` | Archive done tasks (move to `.tasks/archive/`) |
| `npx taskflow check-infra [env]` | Check infrastructure services for an environment |
| `npx taskflow runs` | View run logs (`--task <id>`, `--session <id>`, `--agent <type>`) |
| `npx taskflow resolve-blocked [id]` | List/resolve blocked tasks with pending questions |
| `npx taskflow setup-custom <agent>` | Show instructions for configuring custom instructions (executor or tester) |
| `npx taskflow worktree create <id>` | Create a git worktree for a task (git flow, opt-in) |
| `npx taskflow worktree remove <id>` | Remove a task's worktree and branch |
| `npx taskflow worktree list` | List all worktrees with associated tasks |
| `npx taskflow merge <id>` | Merge task worktree branch into baseBranch (git flow) |
| `npx taskflow revert-merge <id>` | Revert the last merge commit for a task |
| `npx taskflow commit <id> -m <msg>` | Commit changes in task worktree with conventional message |
| `npx taskflow cleanup-worktrees` | Remove worktrees for done/blocked tasks + orphans |

---

## Versioning

Every task edit creates a version snapshot, regardless of the task's current state. This ensures no data is ever lost.

### How it works

1. When a user edits a task, the current `description`, `implementationNotes`, `testFlows`, and `bounceCount` are snapshotted into `versions.v<old>`
2. The edit's `changeDescription` (a human-readable reason) is recorded in the snapshot
3. The `version` field is incremented
4. `testResults` are reset
5. If the task was in `processing` or `testing`, it is moved back to `pending`

Processing status updates (`statusDescription`, `lastAgentSummary`, `lastAgentAction`, `attemptCount`, `bounceCount`) do NOT trigger versioning — they are metadata-only updates.

### Change description

When editing a task, use the `--change-description` flag to record why:

```bash
npx taskflow edit login-flow_001 -d "..." -c "Updated test flows for edge cases"
```

The change description is stored in the version snapshot and visible in `taskflow diff`.

### Viewing version history

```bash
npx taskflow diff <id>              # Compare latest snapshot vs current
npx taskflow diff <id> v1 v2        # Compare two specific versions
npx taskflow rollback <id> v1       # Rollback to a previous version
```

### Version change detection

Agents periodically check the task version. If it changes while they are working (a user edited the task), they release the lock and move on. This prevents conflicts between user edits and agent work.

---

## Run Log

Every agent action is recorded in two places:

- `.tasks/runs/sessions/<sessionId>.md` — all actions by a specific agent session
- `.tasks/runs/tasks/<taskId>.md` — full history of a specific task across sessions

Entry format (markdown):

```markdown
### 2026-07-07T10:00:00Z — pickup
- **Run ID:** run_20260707_001
- **Agent:** executor
- **Session:** abc-123
- **Task:** login-flow_001 (v2, pending)
- **Result:** success
- **Duration:** 300s

**Summary:** Picked up task 'login-flow' from pending. Read description and implementation notes. Started implementing NextAuth.js login form.
```

### Trimming

| File type | Config | Default |
|-----------|--------|---------|
| Task logs | `maxTaskLogLines` | 500 lines |
| Session logs | `maxSessionLogLines` | 500 lines |
| Session files | `maxSessionFiles` | 50 files (oldest deleted) |
| Releaser log | `maxReleaserLogLines` | 100 lines |

View with:
```bash
npx taskflow runs                       # List recent sessions
npx taskflow runs --task <id>           # View task history
npx taskflow runs --session <id>        # View session history
npx taskflow runs --agent executor      # Filter by agent type
```

---

## Git Flow (Optional — disabled by default)

TaskFlow supports an optional **worktree-based git flow** that isolates executor work in separate git worktrees. This is **off by default** — set `gitFlow.enabled: true` in config to opt in.

### How it works

```
Executor flow (gitFlow.enabled=true):
  1. Pick task from pending/
  2. Create worktree: git worktree add .worktrees/<id> -b taskflow/<id> baseBranch
  3. cd into worktree, implement, COMMIT FREQUENTLY (conventional commits)
  4. Implementation done → MERGE worktree branch into baseBranch
  5. Move task → testing (tester tests on baseBranch)

  If tester reports bugs (task → processing):
  6. REVERT merge on baseBranch
  7. Fix in worktree, commit, RE-MERGE
  8. Move → testing again

  When user approves (task → done):
  9. CLEANUP worktree (if autoCleanup: true)

Tester flow (always tests on base branch):
  1. Pick task from testing/
  2. git checkout baseBranch (has executor's merged code)
  3. CHECK infra (check-infra) — only setup if needed
  4. Run test flows
  5. Pass → review | Fail → record bugs, task → processing (executor fixes)
```

### Configuration

```yaml
gitFlow:
  enabled: false                    # Set to true to opt-in
  baseBranch: "main"                # The branch tester tests on
  worktreeDir: ".worktrees"         # Directory for worktrees
  branchPrefix: "taskflow/"         # Prefix for feature branches
  autoCleanup: true                 # Remove worktree after task done
  commitConvention: "conventional" # "conventional" (feat:/fix:/refactor:) or "plain"
  mergeStrategy: "merge"            # "merge" | "rebase" | "squash"
```

### Commit convention

When `commitConvention: "conventional"`, the `taskflow commit` command formats messages as:
- `feat(<task-id>): <description>` — new feature
- `fix(<task-id>): <description>` — bug fix
- `refactor(<task-id>): <description>` — refactor

When `commitConvention: "plain"`, messages are prefixed with `[<task-id>] <description>`.

### Who does what

| Role | Worktree? | Tests on | Merges? |
|------|-----------|----------|---------|
| Executor | Yes (creates worktree) | — | Yes (merges into base before testing) |
| Tester | No | baseBranch | No |
| User | No | — | No (approve only moves to done) |

### Cleanup

Run `npx taskflow cleanup-worktrees` (via the `taskflow-user` skill) to remove worktrees for tasks that are done, blocked, or orphaned.

---

## Development

```bash
cd taskflow
npm install
npm run build    # Compile TypeScript + copy templates
npm run dev      # Run directly with tsx
```

### Project structure

```
taskflow/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts                    # CLI entry point
│   ├── init.ts                   # Init command
│   ├── edit.ts                   # Edit command with versioning
│   ├── core/
│   │   ├── types.ts              # All TypeScript interfaces
│   │   ├── config.ts             # Config loader + types
│   │   ├── lock.ts               # Mutex lock operations
│   │   ├── state.ts              # State machine operations
│   │   ├── runlog.ts             # Run log operations
│   │   └── version.ts            # Version snapshot + change detection
│   └── templates/
│       ├── config.yaml           # Template configuration
│       ├── task.yaml             # Template task file
│       └── skills/              # 6 skill markdown files
│           ├── taskflow-init/
│           ├── taskflow-executor/
│           ├── taskflow-tester/
│           ├── taskflow-lock-releaser/
│           └── taskflow-user/
├── dist/                         # Compiled output
└── README.md
```

---

## License

MIT
