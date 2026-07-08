---
name: taskflow-notifier
description: Check blocked tasks, send notifications through configured channels. For notifier agents.
---

# taskflow-notifier

Instructions for the agent notifying users about blocked tasks. The agent runs ONE check cycle per invocation, then stops.

---

## STRICT BOUNDARIES — READ BEFORE DOING ANYTHING

- Notifier ONLY reads from `.tasks/blocked/`
- Notifier ONLY sends notifications — it MUST NEVER modify, move, or delete task files
- Notifier MUST NEVER touch `.tasks/defined/`, `.tasks/pending/`, `.tasks/processing/`, `.tasks/testing/`, `.tasks/review/`, `.tasks/done/`
- If no tasks in `blocked/` → **STOP immediately.**
- The `/loop` mechanism will restart to check again later.

---

## 1. Objective

Check for blocked tasks, format notifications with full context, and send them through all enabled channels.

## 2. Inputs

- `.tasks/blocked/` directory
- `.tasks/config.yaml` — notification configuration (channels, messageTemplate)
- `.tasks/runs/tasks/<taskId>.md` — recent run log for context

## 3. Detailed Procedure

### Step 1: Read config

Read `.tasks/config.yaml`:
- `notification.enabled` — if false, stop
- `notification.channels` — list of channels to send through
- `notification.messageTemplate` — template with `{{variables}}` to fill
- `notification.blockedCheckIntervalSeconds` — not used by this skill (handled by /loop)

### Step 2: Read blocked tasks

Read all `.yaml` files in `.tasks/blocked/`.

If no files found → **STOP. No blocked tasks.**

### Step 3: For each blocked task

1. Read the task YAML:
   - `id`, `name`, `description`, `implementationNotes`
   - `previousState` (where the task was before being blocked)
   - `pendingQuestions` (array of questions with `category`, `question`, `context`)

2. Read recent run log from `.tasks/runs/tasks/<taskId>.md` (last 10 entries)

3. Format the notification message using `messageTemplate`:
   - Replace `{{taskId}}` with task ID
   - Replace `{{taskName}}` with task name
   - Replace `{{taskDescription}}` with task description
   - Replace `{{previousState}}` with previous state
   - Replace `{{agentType}}` with who blocked it (from pendingQuestions[0].askedBy)
   - Replace `{{timestamp}}` with current time
   - Replace `{{questionCount}}` with number of unanswered questions
   - Replace `{{questionsGrouped}}` with questions grouped by category:
     ```
     **Implementation decisions:**
     1. [q1] Should I use NextAuth.js or custom auth?
        Context: Found existing JWT in core-api/iam but task doesn't specify.

     **Environment/Config:**
     2. [q2] MAP4D_API_KEY missing — should I add a placeholder?
     ```
   - Replace `{{recentRunSummary}}` with last few run log entries (summaries only)

### Step 4: Send through enabled channels

For each channel where `enabled: true`:

1. Read the channel's `guide` field — this tells you HOW to send the notification
2. Follow the guide instructions exactly
3. If the channel is `console` → print the message to terminal
4. If the channel is `file` → append the message to the file specified in `path`
5. If the channel is `webhook` → send HTTP POST to `url` with format specified in `format`
6. If the channel is `email` → send email using SMTP settings
7. If the channel is `custom` → read the `guide` and follow the custom instructions

> **Multiple instances:** A channel type can have multiple instances (e.g. two webhook channels — one for Slack, one for Discord). Each has an optional `name` field. When logging or reporting, include the `name` (or `type` if `name` is absent) so the user can tell which instance was used. Send through ALL enabled channels — do not pick just one.

> **Failed channels:** If a channel fails to send (network error, bad credentials, etc.), log the failure and continue with the next enabled channel. Do not abort the entire notification cycle because one channel failed. A channel that was not tested during init (see taskflow-init Step 3.5) or via `test notif` (see taskflow-user Section 2.15) may silently fail — always log the result.

### Step 5: Log

Write to `.tasks/runs/notifier-log.md`. You can use the `appendNotifierLog` helper from `src/core/runlog.ts` if calling via code, or write directly with `fs.appendFileSync`:

```markdown
## <timestamp>
- Checked blocked tasks: <count> found
- Sent notifications through: <list of channels>
- Tasks: <list of task IDs>
```

If no blocked tasks:
```markdown
## <timestamp>
- No blocked tasks found.
```

> The notifier log is trimmed to the last 100 lines automatically.

## 4. Usage with /loop

```bash
/loop 60s use skill taskflow-notifier to notify blocked tasks
```

The external `/loop` mechanism handles restarting every 60 seconds. This skill only runs ONE check cycle per invocation.