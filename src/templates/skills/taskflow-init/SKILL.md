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
- User may provide configuration info (environment, services, browser MCP tools)

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
```

**Expected output:**
```
Created:
  .tasks/pending/
  .tasks/processing/
  .tasks/testing/
  .tasks/review/
  .tasks/done/
  .tasks/locks/
  .tasks/runs/
  .tasks/config.yaml
  .tasks/runs/releaser-log.md

Skills installed:
  .opencode/skills/taskflow-executor/SKILL.md
  .opencode/skills/taskflow-tester/SKILL.md
  .opencode/skills/taskflow-lock-releaser/SKILL.md
  .opencode/skills/taskflow-user/SKILL.md
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

2. **Infrastructure services** — if the project has services:
   ```yaml
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

3. **Seed data** — if seed data is needed:
   ```yaml
   infrastructure:
     seed:
       - name: "admin-user"
         check:
           method: "api"
           url: "http://localhost:3001/api/users/admin"
         setup:
           auto: true
           command: "npm run seed"
   ```

### Step 3.4: Configure custom instructions for executor and tester

Ask the user:

1. **"Would you like to add custom instructions for the executor agent?"**
   - Example: "Use the brainstorming skill before implementing", "Reference docs/design before writing code", "Run lint after implementation"
   - The agent will write to `executor.customInstructions` in config
   - If the user wants custom skills, help create `.opencode/skills/<name>/SKILL.md`

2. **"Would you like to add custom instructions for the tester agent?"**
   - Example: "Check logs in core-api/logs/ before asserting", "Take screenshots when UI tests fail"
   - The agent will write to `tester.customInstructions` in config

3. **"Would you like to add custom skills?"**
   - The agent helps create skill files at `.opencode/skills/<name>/SKILL.md`
   - Or the user creates them, and the agent updates the path in config

4. **"Would you like to add custom tools?"**
   - Example: MCP tool, analysis script, etc.
   - The agent updates config

**Note:** Custom instructions/skills/tools do not conflict with the framework. The framework handles orchestration (lock, state, run log, versioning). Custom instructions only guide agent behavior during task execution.

### Step 4: Verify installation

```bash
node -e "const fs=require('fs'); console.log(fs.readdirSync('.tasks'))"
npx taskflow add "Smoke test"
npx taskflow list
```

### Step 5: Guide the user

1. **Create a task**: `npx taskflow add "Task name"` or use the `taskflow-user` skill
2. **Run executor**: Use the `taskflow-executor` skill
3. **Run tester**: Use the `taskflow-tester` skill
4. **Approve a task**: `npx taskflow approve <id>` or use the `taskflow-user` skill
5. **Cleanup locks**: Use the `taskflow-lock-releaser` skill or `npx taskflow unlock --all`

## 4. Special cases

| Situation | Action |
|-----------|--------|
| Project already has `.tasks/` | Ask if user wants to re-init. If yes, backup the old `.tasks/`. |
| No `.opencode/` directory | Create `.opencode/skills/` before copying skills |
| User cannot install globally | Use `npx taskflow` instead of `npm install -g` |