# TaskFlow

**Automation task management framework** with mutex locks, versioning, test flows, and agent skills.

TaskFlow is a standalone CLI tool that manages the lifecycle of automation tasks across multiple AI agent sessions. It provides a file-based coordination layer so that executor agents, tester agents, and cleanup agents can work concurrently without conflicts.

> **Key philosophy:** Agents read natural language descriptions and act on them — no scripts to run, no DSL to learn. The framework orchestrates; the agent decides how.

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
    └── releaser-log.md           # Lock-releaser log
```

### File naming convention

```
YYYY-MM-DD_<task-name>_<seq>.yaml
```

Example: `2026-07-07_login-flow_001.yaml`

---

## State Machine

```
defined ──(user move)──► pending ──(executor pickup)──► processing ──(executor done)──► testing
                              ▲                                 │                           │
                              │                          (version change)          (all pass?)
                              │                                 ▼                           │
                              │                             pending                    ┌────┴────┐
                              │                                 ▲                      ▼         ▼
                              │                          (user reject)              review    processing
                              │                                 ▲                      │    (with bugs)
                              │                                 │                      ▼
                              └─────────────────────────────────┴─────────────────── done
```

| From | To | By | Condition |
|------|----|----|-----------|
| defined | pending | User | Move task to make it available for executor |
| pending | processing | Executor | Pick up task, acquire lock |
| processing | testing | Executor | Implementation done |
| processing | pending | Executor | Version change detected |
| testing | review | Tester | All flows pass |
| testing | processing | Tester | Flow fails |
| review | done | User | Approve |
| review | pending | User | Reject |

---

## Lock Mechanism

TaskFlow uses **file-based mutex locks** (no Redis, no database).

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

TaskFlow installs 5 skills into `.agents/skills/` during `init`.

| Skill | Location | Purpose |
|-------|----------|---------|
| `taskflow-init` | `.agents/skills/` | Bootstrap the framework into a project |
| `taskflow-executor` | `.agents/skills/` | Pick pending tasks, implement, move to testing |
| `taskflow-tester` | `.agents/skills/` | Pick testing tasks, run flows, move to review or back |
| `taskflow-lock-releaser` | `.agents/skills/` | Run one check cycle to clean up stale locks |
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
| `npx taskflow add <name>` | Create a new task in `defined/` |
| `npx taskflow list [state]` | List tasks by state (defined, pending, processing, testing, review, done) |
| `npx taskflow status <id>` | Show detailed task info |
| `npx taskflow edit <id>` | Edit a task (creates new version if in processing/testing) |
| `npx taskflow move <id> <state>` | Move a task (from defined or pending to another state) |
| `npx taskflow approve <id>` | Move task from `review/` to `done/` |
| `npx taskflow reject <id>` | Move task from `review/` back to `pending/` |
| `npx taskflow unlock [id]` | Force release a lock (without args: infra lock) |
| `npx taskflow unlock --all` | Release all locks |
| `npx taskflow runs` | View run logs (`--task <id>`, `--session <id>`, `--agent <type>`) |
| `npx taskflow answer-questions [id]` | Check tasks for unanswered pending questions |
| `npx taskflow setup-custom <agent>` | Show instructions for configuring custom instructions (executor or tester) |

---

## Versioning

When a user edits a task that is in `processing` or `testing`:

1. The current `description`, `implementationNotes`, and `testFlows` are snapshotted into `versions.v<old>`
2. The agent brainstorms with the user to clarify the new requirements
3. The task is updated, `version` is bumped, `testResults` are reset
4. The file is moved back to `pending/`

Agents periodically check the task version. If it changes while they are working, they release the lock and move on.

---

## Run Log

Every agent action is recorded in two places:

- `.tasks/runs/sessions/<sessionId>.md` — all actions by a specific agent session
- `.tasks/runs/tasks/<taskId>.md` — full history of a specific task across sessions

Entry format (markdown):

```markdown
### 2026-07-07T10:00:00Z — pickup
- **Run ID:** run_001
- **Agent:** executor
- **Session:** abc-123
- **Task:** login-flow_001 (v2, pending)
- **Result:** success
- **Duration:** 300s
- **Details:** Implemented login form with NextAuth.js...
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
│       └── skills/              # 5 skill markdown files
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