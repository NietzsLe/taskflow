---
name: taskflow-init
description: Bootstrap TaskFlow framework into a project. Check prerequisites, run init, configure, verify installation. For setup agents.
---

# taskflow-init

Instructions for the agent installing the TaskFlow framework into a project. The agent reads this skill when the user requests "install taskflow" or "setup taskflow".

---

## 1. Objective

Install TaskFlow into a project: check prerequisites, run init, configure, verify.

## 2. Inputs

- Target project (current directory)
- User may provide configuration info (environment, infrastructure components, browser MCP tools)

## 3. Detailed Procedure

### Step 1: Check prerequisites

| Prerequisite | How to check | Guide if missing |
|-------------|--------------|------------------|
| Node.js >= 18 | `node --version` | Download from https://nodejs.org |
| npm | `npm --version` | Bundled with Node.js |
| Git | `git --version` | Download from https://git-scm.com |
| npx | `npx --version` | Bundled with npm |

### Step 2: Run init

```bash
cd <project-directory>
npx taskflow init
# To re-init and backup existing .tasks/:
npx taskflow init --force
```

**Expected output:**
```
Created:
  .tasks/defined/
  .tasks/pending/
  .tasks/processing/
  .tasks/testing/
  .tasks/review/
  .tasks/done/
  .tasks/blocked/
  .tasks/archive/
  .tasks/locks/
  .tasks/runs/
  .tasks/config.yaml
  .tasks/.gitignore
  .tasks/runs/releaser-log.md

Skills installed:
  .agents/skills/taskflow-executor/SKILL.md
  .agents/skills/taskflow-tester/SKILL.md
  .agents/skills/taskflow-lock-releaser/SKILL.md
  .agents/skills/taskflow-user/SKILL.md
  .agents/skills/taskflow-init/SKILL.md
  .agents/skills/taskflow-notifier/SKILL.md
```

### Step 3: Configure system

Open `.tasks/config.yaml` and configure:

1. **Browser MCP tools** — declare which already-connected MCP tools can be used for UI tests:
   ```yaml
   browserMCP:
     - name: "playwriter"
       available: true
       description: "Playwriter MCP — browser automation tool"
   ```
   Note: The agent must have the MCP tool connected already. This config only declares which connected tools are available for UI testing.

### Step 4: Configure infrastructure (CRITICAL)

Infrastructure configuration is EXTREMELY IMPORTANT. Executor and tester agents read this to understand the system architecture before working. Without this, agents cannot understand which components exist, how they relate, or how to interact with them.

#### 4a. Identify repositories

If the workspace has 1 repo at root → leave `repositories: []` (empty = single root repo, backward compatible).

If the workspace has multiple repos (monorepo or multi-repo layout):
1. List each repo directory: `ls -d */`
2. For each repo, determine:
   - `name` — short identifier
   - `role` — backend | frontend | shared | tooling | infra | docs
   - `path` — relative to workspace root
   - `description` — what this repo does
   - `mapsToComponents` — which infrastructure components this repo provides code for
   - `interactionGuide` — how to start, test, build, troubleshoot (text description, not structured commands)
3. Write repo-to-repo relationships (`repoRelationships`):
   - `from` → `to` pairs with `type` and `description`
   - Example: web-server → core-api (api-consumer)

#### 4b. Identify infrastructure components

Read the project's:
- `docker-compose*.yml` — self-host services (docker containers)
- `.env.example` — remote services + env vars
- `README`, `CLAUDE.md` — architecture overview

For each component, determine:
- `name` — short identifier
- `role` — database | cache | authz | scanner | api | web | storage | maps
- `type` — docker | process | remote
- `description` — what this component does, its responsibilities
- `check` — how to verify it's up (port/tcp, http, command)
- `setup` — how to start it (auto: true → command runs automatically; auto: false → instruction for user)
- `dependsOn` — what must be up first (for check ordering)
- `required` — true = agent must block if down; false = optional
- `interactionGuide` — how to connect, inspect, troubleshoot (text description)

Component types:
- **docker**: runs in Docker container, can be auto-started via docker compose
- **process**: runs as a local process (npm run dev), needs manual start
- **remote**: external service (Cloudflare R2, Map4D API), cannot auto-setup, only check health

#### 4c. Identify component relationships

Read `docker-compose.yml` `depends_on` and architecture docs. Write `componentRelationships` as from→to pairs:
- `from` — source component name
- `to` — target component name
- `type` — http-proxy | database | cache | authz | virus-scan | storage | maps | static-assets
- `description` — what flows between them

Example relationships:
```yaml
componentRelationships:
  - { from: "web-server", to: "core-api", type: "http-proxy", description: "Next.js proxies API to core-api" }
  - { from: "core-api", to: "postgresql", type: "database", description: "Prisma ORM reads/writes" }
  - { from: "core-api", to: "cloudflare-r2", type: "storage", description: "Media file storage" }
```

#### 4d. Configure seed data

If the project has seed/reset commands:
- `name` — short identifier
- `description` — what this seed does
- `check` — how to verify seed is applied (api endpoint or command)
- `setup` — how to apply seed (auto: true → auto-run; auto: false → guide user)
- `required` — true = agent must block if seed missing
- `interactionGuide` — how to run seed, what it does, troubleshooting

#### 4e. Verify

Run `npx taskflow check-infra <env>` to verify the configuration works.

This step is NOT optional. Agents cannot work without understanding the architecture. Ask the user to confirm before proceeding.

### Step 3.4: Configure custom instructions for executor and tester

Ask the user:

1. **"Would you like to add custom instructions for the executor agent?"**
   - Example: "Use the brainstorming skill before implementing", "Reference docs/design before writing code", "Run lint after implementation"
   - The agent will write to `executor.customInstructions` in config
   - If the user wants custom skills, help create `.agents/skills/<name>/SKILL.md`

2. **"Would you like to add custom instructions for the tester agent?"**
   - Example: "Check logs in core-api/logs/ before asserting", "Take screenshots when UI tests fail"
   - The agent will write to `tester.customInstructions` in config

3. **"Would you like to add custom skills?"**
    - The agent helps create skill files at `.agents/skills/<name>/SKILL.md`
   - Or the user creates them, and the agent updates the path in config

4. **"Would you like to add custom tools?"**
   - Example: MCP tool, analysis script, etc.
   - The agent updates config

**Note:** Custom instructions/skills/tools do not conflict with the framework. The framework handles orchestration (lock, state, run log, versioning). Custom instructions only guide agent behavior during task execution.

### Step 3.5: Configure & test notification channels

Read `.tasks/config.yaml` and find the `notification` section. The notifier now monitors ALL task state changes via snapshot diff — not just blocked tasks. Key config fields:

- `checkIntervalSeconds` — how often the notifier runs (handled by /loop)
- `snapshotPath` — where the state snapshot is stored
- `reportOnNoChange` — whether to notify when nothing changed
- `detailedOnIssues` — whether issues get detailed formatting
- `channels` — the list of notification channels

### Step 4: Verify installation

```bash
node -e "const fs=require('fs'); console.log(fs.readdirSync('.tasks'))"
npx taskflow add "Smoke test"
npx taskflow list
```

### Step 5: Guide the user

1. **Create a task**: `npx taskflow add "Task name"` or use the `taskflow-user` skill
   - The task starts in `defined/` — NOT available for executor pickup yet.
   - Use `npx taskflow edit <id> -d "..." -i "..." -t '[...]'` to fill in the details.
   - **Only when the user is satisfied with the definition**: `npx taskflow move <id> pending` to make it available for the executor.
   - The agent must **never** auto-move a task to `pending` — always wait for the user to explicitly confirm.
2. **Run executor**: Use the `taskflow-executor` skill (only picks up from `pending/`)
3. **Run tester**: Use the `taskflow-tester` skill
4. **Approve a task**: `npx taskflow approve <id>` or use the `taskflow-user` skill
5. **Cleanup locks**: Use the `taskflow-lock-releaser` skill or `npx taskflow unlock --all`

## 4. Special cases

| Situation | Action |
|-----------|--------|
| Project already has `.tasks/` | Ask if user wants to re-init. If yes, backup the old `.tasks/`. |
| No `.agents/` directory | Create `.agents/skills/` before copying skills |
| User cannot install globally | Use `npx taskflow` instead of `npm install -g` |