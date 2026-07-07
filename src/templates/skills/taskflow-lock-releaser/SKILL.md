---
name: taskflow-lock-releaser
description: Clean up stale locks. Check heartbeat, release stale task/infra locks, log results. For lock-releaser agents.
---

# taskflow-lock-releaser

Instructions for the agent cleaning up stale locks. The agent runs ONE check cycle per invocation, then stops. The external `/loop` mechanism handles restarting.

---

## 1. Objective

Detect and release lock files where the acquiring session has stopped heartbeating (session crashed). Run one check cycle, then stop.

## 2. Inputs

- `.tasks/locks/` directory
- `.tasks/config.yaml` — to read `heartbeat.staleThresholdSeconds`

## 3. Detailed Procedure

### Run ONE check cycle

Read all `.lock` files in `.tasks/locks/` (skip non-.lock files).

For each lock file:

1. **Parse**: Read the file, parse YAML → extract `heartbeatAt`
2. **Check**: Calculate `elapsed = now - heartbeatAt` (seconds)
   - `elapsed <= config.heartbeat.staleThresholdSeconds` (default 120s) → lock is alive → **skip**
   - `elapsed > staleThresholdSeconds` → lock is stale → force release
3. **Double-check**: Re-read the file, recalculate elapsed
4. **Force release**: If still stale → delete the lock file. If no longer stale (agent heartbeated between checks) → **skip**.
5. **Log**: Write to `.tasks/runs/releaser-log.md`

### Usage with /loop

```bash
/loop 60s use skill taskflow-lock-releaser to release stale locks
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
  - **Summary:** The executor session <sessionId> appears to have crashed. Last heartbeat was 180s ago. Released the task lock so other sessions can pick up the task.
```

If no stale locks were found, write:
```markdown
## <timestamp>
- No stale locks found. All <count> locks are healthy.
```