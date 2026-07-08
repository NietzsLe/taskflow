---
name: taskflow-lock-releaser
description: Clean up stale locks. Check heartbeat, release stale task/infra locks, recover stuck tasks to pending. For lock-releaser agents.
---

# taskflow-lock-releaser

Instructions for the agent cleaning up stale locks. The agent runs ONE check cycle per invocation, then stops. The external `/loop` mechanism handles restarting.

---

## 1. Objective

Detect and release lock files where the acquiring session has stopped heartbeating (session crashed). After releasing a stale task lock, also move the task back to `pending/` so it can be re-picked up. Run one check cycle, then stop.

## 2. Inputs

- `.tasks/locks/` directory
- `.tasks/config.yaml` — to read `heartbeat.staleThresholdSeconds`

## 3. Detailed Procedure

### Run ONE check cycle

**You MUST run these commands — do NOT guess or assume lock file contents.**

Check for stale locks:
```bash
npx taskflow unlock --all
```

Then recover any stuck tasks:
```bash
npx taskflow recover
```

If `unlock --all` released any locks and `recover` moved tasks to pending, log the results. If nothing was stale, log "no stale locks found."

### Usage with /loop

```bash
/loop 60s use skill taskflow-lock-releaser to release stale locks and recover stuck tasks
```

The external `/loop` mechanism handles restarting every 60 seconds. This skill only runs ONE check cycle per invocation.

### Locks to check

| Lock file | Description |
|-----------|-------------|
| `task-<id>.lock` | Task lock — acquired by executor or tester |
| `infra.lock` | Infrastructure lock — acquired by tester |

## 4. Logging

Write to `.tasks/runs/releaser-log.md` with a summary of what was done:

```markdown
## <timestamp>
- Released stale lock: `<filename>`
  - Session: `<sessionId>`
  - Agent type: `<agentType>`
  - Last heartbeat: `<heartbeatAt>` (<elapsed>s ago)
  - Task version: `<taskVersion>`
  - **Summary:** The executor session <sessionId> appears to have crashed. Last heartbeat was 180s ago. Released the task lock and recovered task to pending.
```

If no stale locks were found, write:
```markdown
## <timestamp>
- No stale locks found. All <count> locks are healthy.
```