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

### Step 1: Run the notify command

**You MUST run this command — do NOT guess or assume task states.**

```bash
npx taskflow notify
```

This command:
1. Reads `.tasks/config.yaml` for notification settings
2. Builds a snapshot of ALL tasks across ALL states
3. Compares against the previous snapshot (`.tasks/runs/notifier-state.json`)
4. Detects changes: transitions, new tasks, removed tasks, blocked, bounce thresholds, stale locks, version bumps
5. Formats a report (summary for normal changes, detailed for issues)
6. Sends through all enabled channels (console, file, webhook, email, custom)
7. Writes the new snapshot for the next cycle

**If `notification.enabled` is false → STOP.**

**If `--dry-run` is needed** (show report without sending):
```bash
npx taskflow notify --dry-run
```

**To reset the snapshot** (next run reports all tasks as new):
```bash
npx taskflow notify --reset
```

### Step 2: Log

After running `notify`, write to `.tasks/runs/notifier-log.md`:
```markdown
## <timestamp>
- Ran notify cycle
- Changes detected: <count>
- Sent through: <channels>
```

## 4. Usage with /loop

```bash
/loop 60s use skill taskflow-notifier to notify task state changes
```

The external `/loop` mechanism handles restarting every 60 seconds. This skill only runs ONE check cycle per invocation.
