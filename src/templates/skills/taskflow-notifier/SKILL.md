---
name: taskflow-notifier
description: Monitor all tasks via snapshot diff, detect state changes, and notify through configured channels. For notifier agents.
---

# taskflow-notifier

Instructions for the agent notifying about task state changes. The agent runs ONE check cycle per invocation, then stops.

---

## STRICT BOUNDARIES — READ BEFORE DOING ANYTHING

- Notifier ONLY reads task files and lock files — it MUST NEVER modify, move, or delete any files
- Notifier MUST NEVER touch `.tasks/defined/`, `.tasks/pending/`, `.tasks/processing/`, `.tasks/testing/`, `.tasks/review/`, `.tasks/done/`, `.tasks/blocked/`, `.tasks/locks/`
- Notifier MUST NOT acquire or release locks
- The `/loop` mechanism will restart to check again later.

---

## 1. Objective

Build a state snapshot of all tasks, diff against the previous snapshot, and report only what changed. Send the report through all enabled notification channels.

## 2. Inputs

- `.tasks/` — all state directories (defined, pending, processing, testing, review, done, blocked)
- `.tasks/locks/` — lock files for stale detection
- `.tasks/config.yaml` — notification configuration
- `.tasks/runs/notifier-state.json` — previous snapshot (may not exist on first run)
- `.tasks/runs/tasks/<taskId>.md` — recent run log for blocked task context

## 3. Detailed Procedure

### Step 1: Read config

Read `.tasks/config.yaml`:
- `notification.enabled` — if false, stop
- `notification.channels` — list of channels to send through
- `notification.checkIntervalSeconds` — not used by this skill (handled by /loop)
- `notification.snapshotPath` — path to the state snapshot file
- `notification.reportOnNoChange` — if false, skip notification when nothing changed
- `notification.detailedOnIssues` — if true, issues get detailed formatting

### Step 2: Build current snapshot

Scan ALL state directories (defined, pending, processing, testing, review, done, blocked). For each task YAML file, read:
- `id`, `name`, `version`, `bounceCount`, `attemptCount`
- `blockedReason`, `pendingQuestions` (count unanswered)
- `updatedAt`

Also check `.tasks/locks/task-<id>.lock` for each task in processing/testing:
- Read the lock file to get `sessionId`
- Check if the lock is stale (heartbeat older than `heartbeat.staleThresholdSeconds`)

### Step 3: Load previous snapshot

Read `.tasks/runs/notifier-state.json`. If it doesn't exist → this is the first run.

### Step 4: First run behavior

If no previous snapshot:
1. Format an initial report listing ALL tasks as "new" with a framework overview
2. Send through all enabled channels
3. Write the snapshot
4. Log to notifier-log.md and main run log
5. Stop

### Step 5: Compute diff

Compare current snapshot against previous snapshot. Detect:

| Change | How to detect |
|--------|---------------|
| State transition | `state` field differs |
| New task | ID in current but not previous |
| Removed task | ID in previous but not current |
| Newly blocked | `state` changed TO `blocked` |
| Resolved block | `state` changed FROM `blocked` |
| Version bump | `version` field increased |
| Bounce threshold | `bounceCount` crossed `test.maxBounces` |
| Stale lock | `lockStale` changed from false to true |

### Step 6: Format report

If nothing changed and `reportOnNoChange` is false → skip notification, just update snapshot.

Format the report as markdown:

```
=== TaskFlow Status Report ===
<timestamp>

**Summary:**
  • Task A (v2): pending → processing
  • Task B (v1): testing → review
  • Task C: created in pending
  • Task D: v1 → v2

**Issues:**
  ⚠️ Task E (task-e_001): BLOCKED
     Was in: testing
     Reason: API key missing
     Questions: 2 unanswered
       [Config] MAP4D_API_KEY missing
       [Design] Should I use env var or config file?
     → npx taskflow resolve-blocked task-e_001

  ⚠️ Task F (task-f_001): bounced 3/3 times
     → npx taskflow resolve-blocked task-f_001

  ⚠️ task-g_001: stale lock (session: abc-123, 150s since heartbeat)
     → npx taskflow unlock task-g_001

**Framework:** 8 tasks (2 pending, 1 processing, 2 testing, 1 review, 1 blocked, 1 done)
```

For newly blocked tasks, enrich the report by reading the task YAML for full `pendingQuestions` and recent run log entries.

### Step 7: Send through enabled channels

For each channel where `enabled: true`:
1. Read the channel's `guide` field — this tells you HOW to send
2. Follow the guide instructions exactly
3. Console → print to terminal
4. File → append to file specified in `path`
5. Webhook → HTTP POST to `url` with format
6. Email → send via SMTP
7. Custom → follow guide instructions

Send through ALL enabled channels. If a channel fails, log the failure and continue.

### Step 8: Log

Write to `.tasks/runs/notifier-log.md`:
```markdown
## <timestamp>
- Checked tasks: <count>
- Changes detected: <count>
- Transitions: <n>, New: <n>, Blocked: <n>, Bounces: <n>, Stale locks: <n>, Version bumps: <n>, Resolved: <n>
- Sent through: <channel list>
- Failed channels: <list or "none">
```

Also write a main run log entry via `appendRunLog` with `agentType: 'notifier'` and `action: 'notify-cycle'`.

### Step 9: Write snapshot

Save the current snapshot to `.tasks/runs/notifier-state.json` for the next cycle.

## 4. Usage with /loop

```bash
/loop 60s use skill taskflow-notifier to notify task state changes
```

The external `/loop` mechanism handles restarting every 60 seconds. This skill only runs ONE check cycle per invocation.
