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

This step verifies that every active notification channel can actually deliver a message. **Do not skip this step** — a misconfigured channel will silently fail when a real task gets blocked.

#### 3.5.1 — Read active channels

1. Read `.tasks/config.yaml` → `notification` section.
2. If `notification.enabled` is `false` → skip this step entirely. Tell the user: "Notifications are disabled. You can enable them later in .tasks/config.yaml."
3. Filter `notification.channels` to only those with `enabled: true`.
4. If no channels are active → tell the user: "No active notification channels. At least console and file are recommended. Edit .tasks/config.yaml to enable channels." Then skip to Step 4.

#### 3.5.2 — Show active channels to the user

List the active channels in a readable format:

```
Active notification channels:
  1. [console] console-default — Output to terminal
  2. [file]   file-default — Append to .tasks/notifications.log
  3. [webhook] slack-alerts — POST to Slack
```

Ask the user: "I will now send a test notification through each active channel. Ready? (yes/no)"

If the user says no → skip testing, tell them they can run `test notif` later via the user skill. Proceed to Step 4.

#### 3.5.3 — Test each active channel

For each active channel (in order):

1. **Read the channel's `guide` field** — this tells you HOW to send a notification through this channel. Follow the guide exactly.

2. **Announce to the user:**
   > "Sending test notification through **[<type>] <name>**..."

3. **Send a test message.** The test message must include:
   - The channel type and name (for identification)
   - A timestamp (so the user can match it to the test)
   - The word "test" (so it's clearly not a real blocked-task alert)

   Test message template:
   ```
   TaskFlow test notification — channel: <type>/<name>, time: <ISO timestamp>
   This is a test. No action needed.
   ```

   Channel-specific sending:
   - **console** → print the test message to the terminal.
   - **file** → append the test message to the channel's `path` (default `.tasks/notifications.log`).
   - **webhook** → send an HTTP POST to the channel's `url` using the channel's `format` (slack/discord/teams/generic). Use `curl` or an equivalent. The payload must contain the test message in the body.
   - **email** → send an email using the channel's SMTP settings (`smtpHost`, `smtpPort`, `smtpUser`, `smtpPassword`, `from`, `to`). The subject should be "TaskFlow test notification" and the body should be the test message. Use `curl` with `smtp://` or an equivalent.
   - **custom** → follow the channel's `guide` instructions exactly. The guide describes how to send; execute it.

4. **Ask the user:**
   > "Did you receive the test notification from **[<type>] <name>**? (yes/no)"

5. **Handle the response:**
   - **yes** → mark this channel as PASSED. Move to the next channel.
   - **no** → the channel FAILED. Troubleshoot:
     a. Re-read the channel's `guide` field and check if a step was missed.
     b. Verify the channel's config fields are correct (URL not empty, SMTP credentials present, file path writable, etc.).
     c. If an environment variable (`${VAR}`) is unresolved → tell the user which variable is missing and ask them to set it.
     d. Fix the issue and **retry once**.
     e. If the retry also fails → suggest disabling this channel:
        > "Channel **[<type>] <name>** failed twice. Recommend setting `enabled: false` for this channel in .tasks/config.yaml. You can re-enable it later after fixing the config. Disable now? (yes/no)"
        If yes → edit `.tasks/config.yaml` and set `enabled: false` for this channel. If no → leave it enabled (user accepts the risk).

#### 3.5.4 — Report summary

After testing all active channels:

```
Notification channel test results:
  ✓ [console] console-default — passed
  ✓ [file]   file-default — passed
  ✗ [webhook] slack-alerts — failed (disabled per user request)
  ✓ [email]  email-default — passed

Summary: 3 passed, 1 failed.
```

If any channel failed and was not disabled → warn the user:
> "Warning: <channel> is enabled but did not pass the test. Notifications through this channel may silently fail when a task is blocked."

#### 3.5.5 — Guide adding a new channel (optional)

Ask the user: "Would you like to add a new notification channel? (e.g. a second webhook for Discord, a Telegram custom channel)"

If yes:
1. Ask which type (webhook, email, custom).
2. Ask for a `name` to identify this instance (required when there are multiple instances of the same type).
3. Help the user fill in the config fields per the channel type's guide.
4. Set `enabled: true`.
5. Test the new channel using the same procedure as 3.5.3.

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
| No `.agents/` directory | Create `.agents/skills/` before copying skills |
| User cannot install globally | Use `npx taskflow` instead of `npm install -g` |