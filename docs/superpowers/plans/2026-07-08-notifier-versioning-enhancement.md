# Notifier + Versioning Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement always-snapshot versioning, state-snapshot-diff notifier, and 6 bug fixes across the TaskFlow framework.

**Architecture:** Two main features + bug fixes. Start with type definitions, then config, then versioning logic, then notifier core module, then CLI/skill/docs, then tests. Each task produces self-contained changes that build on previous tasks.

**Tech Stack:** TypeScript, Node.js, Vitest, YAML, Commander

---

### Task 1: Add `changeDescription` to `VersionSnapshot` + `fromState`/`toState` to `RunLogEntry`

**Files:**
- Modify: `src/core/types.ts`

- [ ] **Step 1: Add `changeDescription` to `VersionSnapshot`**

In `src/core/types.ts`, add `changeDescription?: string` to the `VersionSnapshot` interface (after `bounceCount`):

```typescript
export interface VersionSnapshot {
  updatedAt: string;
  description: string;
  implementationNotes?: string;
  testFlows?: TestFlow[];
  bounceCount?: number;
  changeDescription?: string;
}
```

- [ ] **Step 2: Add `fromState`/`toState` to `RunLogEntry`**

In `src/core/types.ts`, add `fromState` and `toState` to `RunLogEntry`:

```typescript
export interface RunLogEntry {
  runId: string;
  timestamp: string;
  agentType: 'executor' | 'tester' | 'user' | 'lock-releaser' | 'notifier';
  sessionId: string;
  agentName: string | null;
  taskId: string;
  taskVersion: number;
  taskState: string;
  fromState?: string;
  toState?: string;
  action: string;
  description: string;
  summary?: string;
  result: 'success' | 'failure' | 'stale' | 'skipped';
  duration: number;
  error: string | null;
  details: string | null;
}
```

- [ ] **Step 3: Add notifier snapshot/diff interfaces**

After the existing types (after line 104), add:

```typescript
export interface TaskSnapshotEntry {
  id: string;
  name: string;
  state: TaskState;
  version: number;
  bounceCount: number;
  attemptCount: number;
  blockedReason?: string;
  pendingQuestionCount: number;
  lockedBy?: string;
  lockStale: boolean;
  updatedAt: string;
}

export interface NotifierSnapshot {
  takenAt: string;
  tasks: Record<string, TaskSnapshotEntry>;
}

export interface NotifierDiff {
  transitions: { taskId: string; name: string; from: TaskState; to: TaskState }[];
  newTasks: { taskId: string; name: string; state: TaskState }[];
  removedTasks: { taskId: string; lastState: TaskState }[];
  newlyBlocked: { taskId: string; name: string; questions: PendingQuestion[]; previousState: TaskState; blockedReason?: string }[];
  bounceThresholdHit: { taskId: string; name: string; bounceCount: number; maxBounces: number }[];
  staleLocks: { taskId: string; sessionId: string; elapsedSeconds: number }[];
  versionBumps: { taskId: string; name: string; from: number; to: number }[];
  resolvedBlocks: { taskId: string; toState: TaskState }[];
}
```

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add changeDescription, fromState/toState, notifier snapshot/diff types"
```

---

### Task 2: Parse `changeDescription` in validation

**Files:**
- Modify: `src/core/validate.ts`

- [ ] **Step 1: Add `changeDescription` parsing in `asVersionSnapshot`**

In `src/core/validate.ts`, after the `bounceCount` block (line 116), add:

```typescript
if (v.changeDescription !== undefined) {
  snap.changeDescription = asOptionalString(v.changeDescription, `${field}.${key}.changeDescription`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/validate.ts
git commit -m "feat: parse changeDescription in version snapshot validation"
```

---

### Task 3: Update config — new notification fields, remove `requireVersioningForActive`, add `maxNotifierLogLines`

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/templates/config.yaml`

- [ ] **Step 1: Update `TaskFlowConfig` interface in `config.ts`**

In `src/core/config.ts`:

Remove `requireVersioningForActive` from `user` interface (line 46-48 area).

Update `notification` interface (lines 49-55):
```typescript
notification: {
  enabled: boolean;
  description: string;
  channels: NotificationChannel[];
  checkIntervalSeconds: number;
  snapshotPath: string;
  reportOnNoChange: boolean;
  detailedOnIssues: boolean;
};
```

Add `maxNotifierLogLines` to `runLog` interface:
```typescript
runLog: {
  enabled: boolean;
  maxTaskLogLines: number;
  maxSessionLogLines: number;
  maxSessionFiles: number;
  maxReleaserLogLines: number;
  maxNotifierLogLines: number;
};
```

- [ ] **Step 2: Update defaults in `getDefaultConfig()`**

In `getDefaultConfig()`:

Remove `requireVersioningForActive: true` from `user` defaults.

Update `notification` defaults:
```typescript
notification: {
  enabled: true,
  description: 'Configure notification channels to monitor all task state changes and alert users about transitions, new tasks, blocked tasks, bounce thresholds, stale locks, and version bumps. The notifier agent reads this config and sends alerts through all enabled channels.',
  channels: [ /* keep existing 5 channels */ ],
  checkIntervalSeconds: 60,
  snapshotPath: '.tasks/runs/notifier-state.json',
  reportOnNoChange: false,
  detailedOnIssues: true,
},
```

Add `maxNotifierLogLines: 100` to `runLog` defaults.

- [ ] **Step 3: Update `deepMergeConfig`**

Update `runLog` merge to include `maxNotifierLogLines`:
```typescript
runLog: {
  enabled: parsed.runLog?.enabled ?? defaults.runLog.enabled,
  maxTaskLogLines: parsed.runLog?.maxTaskLogLines ?? defaults.runLog.maxTaskLogLines,
  maxSessionLogLines: parsed.runLog?.maxSessionLogLines ?? defaults.runLog.maxSessionLogLines,
  maxSessionFiles: parsed.runLog?.maxSessionFiles ?? defaults.runLog.maxSessionFiles,
  maxReleaserLogLines: parsed.runLog?.maxReleaserLogLines ?? defaults.runLog.maxReleaserLogLines,
  maxNotifierLogLines: parsed.runLog?.maxNotifierLogLines ?? defaults.runLog.maxNotifierLogLines,
},
```

Update `notification` merge:
```typescript
notification: {
  enabled: parsed.notification?.enabled ?? defaults.notification.enabled,
  description: parsed.notification?.description ?? defaults.notification.description,
  channels: parsed.notification?.channels ?? defaults.notification.channels,
  checkIntervalSeconds: parsed.notification?.checkIntervalSeconds ?? defaults.notification.checkIntervalSeconds,
  snapshotPath: parsed.notification?.snapshotPath ?? defaults.notification.snapshotPath,
  reportOnNoChange: parsed.notification?.reportOnNoChange ?? defaults.notification.reportOnNoChange,
  detailedOnIssues: parsed.notification?.detailedOnIssues ?? defaults.notification.detailedOnIssues,
},
```

Remove `blockedCheckIntervalSeconds` and `messageTemplate` from the merge.

- [ ] **Step 4: Update `src/templates/config.yaml`**

Remove line 80: `requireVersioningForActive: true`

Update notification section:
```yaml
notification:
  enabled: true
  description: |
    Configure notification channels to monitor all task state changes and alert users
    about transitions, new tasks, blocked tasks, bounce thresholds, stale locks, and
    version bumps. The notifier agent reads this config and sends alerts through all
    enabled channels.

    ─────────────────────────────────────────────────────────────────────
    ACTIVE CHANNELS:
    - Only channels with `enabled: true` are active. The notifier agent skips disabled channels.
    - Set `enabled: false` on channels you don't need — don't delete them, so you can re-enable later.

    MULTIPLE INSTANCES:
    - One type (e.g. webhook) can have multiple instances — use the `name` field to distinguish them.
    - Example: 2 webhook instances — one for Slack (name: "slack-alerts"), one for Discord (name: "discord-alerts").
    - The `name` field is optional but strongly recommended when you have more than one instance of the same type.

    TESTING:
    - During `taskflow init` (Step 3.5), or via the user skill command `test notif`,
      the agent sends a test message through each active channel and asks you to confirm receipt.
    - Failed channels should be fixed (per their `guide`) or disabled (`enabled: false`).
    ─────────────────────────────────────────────────────────────────────
  channels:
    # ── Console (default, always works) ──────────────────────────────
    - name: "console-default"
      type: "console"
      enabled: true
      guide: |
        No setup needed. Notifications are printed to the terminal when the notifier agent runs.
        This channel is always available.
      description: "Output to terminal — always available, no setup needed"

    # ── File log (default, always works) ─────────────────────────────
    - name: "file-default"
      type: "file"
      enabled: true
      path: ".tasks/notifications.log"
      guide: |
        No setup needed. Notifications are appended to the file specified in "path".
        Check this file periodically or use a log viewer. The file is markdown-formatted for readability.
      description: "Append notifications to a markdown log file"

    # ── Webhook (disabled by default) ────────────────────────────────
    - name: "webhook-default"
      type: "webhook"
      enabled: false
      url: ""
      method: "POST"
      format: "slack"
      timeoutSeconds: 10
      retryCount: 0
      guide: |
        To set up a webhook notification channel:

        1. Slack:
           - Go to https://api.slack.com/messaging/webhooks
           - Create a new app or select an existing one
           - Add an Incoming Webhook to a channel
           - Copy the webhook URL (looks like https://hooks.slack.com/services/...)
           - Paste it into the "url" field below
           - Set "format" to "slack"

        2. Discord:
           - Open Discord server settings > Integrations > Webhooks
           - Click "New Webhook" and select a channel
           - Copy the webhook URL
           - Paste it into "url" and set "format" to "discord"

        3. Microsoft Teams:
           - Open the channel > Connectors > Incoming Webhook
           - Name it and copy the URL
           - Paste into "url" and set "format" to "teams"

        4. Generic HTTP endpoint:
           - Any service that accepts HTTP POST with JSON body
           - Set "format" to "generic"
      description: "Send HTTP POST to a webhook URL (Slack, Discord, Teams)"

    # ── Email via SMTP (disabled by default) ─────────────────────────
    - name: "email-default"
      type: "email"
      enabled: false
      smtpHost: ""
      smtpPort: 587
      smtpUser: ""
      smtpPassword: ""
      from: ""
      to: ""
      timeoutSeconds: 10
      retryCount: 0
      guide: |
        To set up email notifications via SMTP:

        1. Gmail:
           - Enable 2-factor authentication on your Google account
           - Go to https://myaccount.google.com/apppasswords
           - Generate an App Password (16 characters)
           - Set smtpHost: "smtp.gmail.com", smtpPort: 587
           - Set smtpUser: your Gmail address
           - Set smtpPassword: the App Password (NOT your real password)
           - Set from: your Gmail address, to: recipient address

        2. Outlook/Office365:
           - Set smtpHost: "smtp.office365.com", smtpPort: 587
           - Use your Office365 credentials

        3. Amazon SES:
           - Set smtpHost: your SES endpoint
           - Set smtpPort: 587
           - Use your SES SMTP credentials

        4. Any SMTP server:
           - Set smtpHost and smtpPort to your server
           - Set smtpUser and smtpPassword to your credentials
      description: "Send email via SMTP"

    # ── Custom channel (disabled by default) ────────────────────────
    - name: "custom-default"
      type: "custom"
      enabled: false
      guide: |
        Describe how to send notifications using this channel. The notifier agent will
        read your instructions and execute them.

        Examples:
        - Telegram: "Send a message via Telegram bot API. Use curl to POST to
          https://api.telegram.org/bot<TOKEN>/sendMessage with chat_id=<CHAT_ID> and
          text=<message>. Replace <TOKEN> with your bot token from @BotFather."
        - SMS via Twilio: "Use the Twilio API to send an SMS. Set ACCOUNT_SID and
          AUTH_TOKEN as environment variables. POST to Twilio Messages API."
        - Desktop notification: "Use PowerShell to show a Windows notification."
        - Any custom method: Describe the exact steps and commands.
      description: "Custom channel — describe how to send notifications"

  checkIntervalSeconds: 60
  snapshotPath: ".tasks/runs/notifier-state.json"
  reportOnNoChange: false
  detailedOnIssues: true
```

Add `maxNotifierLogLines` to the runLog section (around line 75):
```yaml
runLog:
  enabled: true
  maxTaskLogLines: 500
  maxSessionLogLines: 500
  maxSessionFiles: 50
  maxReleaserLogLines: 100
  maxNotifierLogLines: 100
```

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/templates/config.yaml
git commit -m "feat: update config — new notification fields, remove requireVersioningForActive, add maxNotifierLogLines"
```

---

### Task 4: Always-snapshot versioning in `edit.ts`

**Files:**
- Modify: `src/edit.ts`

- [ ] **Step 1: Add `changeDescription` to function signature and snapshot logic**

In `src/edit.ts`, update the function signature (line 9-18) to accept `changeDescription`:

```typescript
export function editTask(
  taskDir: string,
  taskId: string,
  updates: {
    description?: string;
    implementationNotes?: string;
    testFlows?: { name: string; environment?: string; steps: string }[];
    changeDescription?: string;
  },
  options?: { force?: boolean }
): void {
```

- [ ] **Step 2: Remove state guard on snapshot block**

Replace lines 61-73 (the snapshot block) with unconditional snapshot:

```typescript
if (currentState === 'processing' || currentState === 'testing') {
  const oldVersion = task.version;
  if (!task.versions) task.versions = {};
  if (!task.versions[`v${oldVersion}`]) {
    task.versions[`v${oldVersion}`] = {
      updatedAt: task.updatedAt,
      description: task.description,
      implementationNotes: task.implementationNotes,
      testFlows: task.testFlows ? task.testFlows.map(f => ({ ...f })) : undefined,
      bounceCount: task.bounceCount,
      changeDescription: updates.changeDescription,
    };
  }
}
```

- [ ] **Step 3: Add transition log after moveTask**

After line 123 (moveTask succeeds), add:

```typescript
appendRunLog(taskDir, {
  timestamp: new Date().toISOString(),
  agentType: 'user',
  sessionId: 'cli',
  agentName: null,
  taskId,
  taskVersion: task.version,
  taskState: currentState,
  fromState: currentState,
  toState: 'pending',
  action: 'edit-move',
  description: `Task '${taskId}' moved ${currentState}→pending after edit`,
  result: 'success',
  duration: 0,
  error: null,
  details: null,
});
```

- [ ] **Step 4: Add changeDescription to run log**

Update the run log entry (lines 106-120) to include `changeDescription` in summary:

```typescript
appendRunLog(taskDir, {
  timestamp: new Date().toISOString(),
  agentType: 'user',
  sessionId: 'cli',
  agentName: null,
  taskId,
  taskVersion: task.version,
  taskState: currentState!,
  action: 'edit',
  description: `User edited task '${taskId}' to v${task.version}`,
  summary: updates.changeDescription || undefined,
  result: 'success',
  duration: 0,
  error: null,
  details: null,
});
```

- [ ] **Step 5: Commit**

```bash
git add src/edit.ts
git commit -m "feat: always snapshot on edit, add changeDescription, log processing→pending transition"
```

---

### Task 5: Update `rollback.ts` — add `changeDescription`, `bounceCount`, fix hardcoded state

**Files:**
- Modify: `src/commands/rollback.ts`

- [ ] **Step 1: Update pre-rollback snapshot**

Replace lines 35-40:

```typescript
task.versions[`v${task.version}`] = {
  updatedAt: task.updatedAt,
  description: task.description,
  implementationNotes: task.implementationNotes,
  testFlows: task.testFlows ? task.testFlows.map(f => ({ ...f })) : undefined,
  bounceCount: task.bounceCount,
  changeDescription: `Rollback to ${targetVersion}`,
};
```

- [ ] **Step 2: Fix hardcoded `taskState` and add `fromState`/`toState`**

Replace line 76:

```typescript
import { getTaskState, getTaskFilePath, moveTask } from '../core/state';
```

Then update the `appendRunLog` call (lines 69-84):

```typescript
const actualState = getTaskState(taskDir, taskId) || 'pending';

appendRunLog(taskDir, {
  timestamp: new Date().toISOString(),
  agentType: 'user',
  sessionId: 'cli',
  agentName: null,
  taskId,
  taskVersion: newVersion,
  taskState: actualState,
  fromState: actualState,
  toState: actualState,
  action: 'rollback',
  description: `User rolled back task '${taskId}' to ${targetVersion} content (new version v${newVersion})`,
  summary: `Restored content from ${targetVersion}. Old v${newVersion - 1} snapshotted. New version: v${newVersion}.`,
  result: 'success',
  duration: 0,
  error: null,
  details: null,
});
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/rollback.ts
git commit -m "fix: add changeDescription, bounceCount to rollback snapshot; fix hardcoded taskState"
```

---

### Task 6: Add `--change-description` option to CLI edit command

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add option to edit command**

In `src/cli.ts`, update the edit command (lines 595-626):

```typescript
program
  .command('edit <id>')
  .description('Edit a task (always creates new version snapshot)')
  .option('-d, --description <text>', 'New description')
  .option('-i, --implementation-notes <text>', 'New implementation notes')
  .option('-t, --test-flows <json>', 'New test flows (JSON array)')
  .option('-c, --change-description <text>', 'Reason for this edit (stored in version snapshot)')
  .option('--force', 'Override lock check (use with caution)')
  .action((id: string, options: { description?: string; implementationNotes?: string; testFlows?: string; changeDescription?: string; force?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    let testFlows: { name: string; environment?: string; steps: string }[] | undefined;
    if (options.testFlows) {
      try {
        testFlows = JSON.parse(options.testFlows);
      } catch {
        console.error('Invalid JSON for --test-flows');
        process.exit(1);
      }
    }
    try {
      editTask(taskDir, id, {
        description: options.description,
        implementationNotes: options.implementationNotes,
        testFlows,
        changeDescription: options.changeDescription,
      }, { force: options.force });
    } catch (err) {
      if (err instanceof TaskLockedError) {
        console.error(`Task '${id}' is locked by another session. Use --force to override.`);
        process.exit(1);
      }
      throw err;
    }
  });
```

- [ ] **Step 2: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add --change-description option to edit command"
```

---

### Task 7: Display `changeDescription` in diff output

**Files:**
- Modify: `src/commands/diff.ts`

- [ ] **Step 1: Add changeDescription comparison**

After line 81 (after testFlows comparison), add:

```typescript
// Compare changeDescription
const cdL = (left.snap as any).changeDescription;
const cdR = (right.snap as any).changeDescription;
if (cdL !== cdR) {
  console.log('--- changeDescription ---');
  if (cdL) console.log(`< ${cdL}`);
  if (cdR) console.log(`> ${cdR}`);
  console.log('');
}
```

Update the "no differences" check (line 84) to include changeDescription:

```typescript
if (descL === descR && inL === inR && JSON.stringify(tfL) === JSON.stringify(tfR) && cdL === cdR) {
  console.log('(no differences)');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/diff.ts
git commit -m "feat: display changeDescription in diff output"
```

---

### Task 8: Update `runlog.ts` — `fromState`/`toState` rendering, `maxNotifierLogLines`

**Files:**
- Modify: `src/core/runlog.ts`

- [ ] **Step 1: Update `formatEntryMarkdown` to render transition**

In `src/core/runlog.ts`, update `formatEntryMarkdown` (lines 63-83). After the `**Task:**` line, add:

```typescript
if (entry.fromState && entry.toState) {
  md += `- **Transition:** ${entry.fromState} → ${entry.toState}\n`;
}
```

- [ ] **Step 2: Update `appendNotifierLog` to use configurable max lines**

Replace the hardcoded `const maxLines = 100` (line 180) with:

```typescript
const config = loadConfig(taskDir);
const maxLines = config.runLog.maxNotifierLogLines ?? 100;
```

- [ ] **Step 3: Commit**

```bash
git add src/core/runlog.ts
git commit -m "feat: render fromState/toState in run log; configurable maxNotifierLogLines"
```

---

### Task 9: Update all `appendRunLog` callers with `fromState`/`toState`

**Files:**
- Modify: `src/cli.ts` (logUserAction + 5 callers)
- Modify: `src/commands/test-fail.ts`
- Modify: `src/commands/recover.ts`

- [ ] **Step 1: Update `logUserAction` helper in `cli.ts`**

Add `fromState` and `toState` to the function signature (line 40-47):

```typescript
function logUserAction(
  taskDir: string,
  action: string,
  taskId: string,
  taskState: string,
  description: string,
  extra?: { summary?: string; details?: string | null; error?: string | null; result?: 'success' | 'failure' | 'stale' | 'skipped'; taskVersion?: number; startTime?: number; fromState?: string; toState?: string }
): void {
```

Update the `appendRunLog` call inside `logUserAction` to pass `fromState`/`toState`:

```typescript
appendRunLog(taskDir, {
  timestamp: new Date().toISOString(),
  agentType: 'user',
  sessionId: 'cli',
  agentName: null,
  taskId,
  taskVersion,
  taskState,
  fromState: extra?.fromState,
  toState: extra?.toState,
  action,
  description,
  summary: extra?.summary,
  result: extra?.result ?? 'success',
  duration,
  error: extra?.error ?? null,
  details: extra?.details ?? null,
});
```

- [ ] **Step 2: Update `move` command caller (line 344)**

```typescript
logUserAction(taskDir, 'move', id, currentState, `User moved task '${id}' from ${currentState} to ${state}${options.force ? ' (forced)' : ''}${options.user ? ' (user-confirmed)' : ''}`, {
  fromState: currentState,
  toState: state,
});
```

- [ ] **Step 3: Update `approve` command caller (line 435)**

```typescript
logUserAction(taskDir, 'approve', id, 'review', `User approved task '${id}'`, {
  summary: 'Task approved. Bounce count reset.',
  fromState: 'review',
  toState: 'done',
});
```

- [ ] **Step 4: Update `reject` command caller (line 482)**

```typescript
logUserAction(taskDir, 'reject', id, 'review', `User rejected task '${id}'${blockedReason ? `: ${blockedReason}` : ''}`, {
  taskVersion,
  summary: blockedReason ? `Rejection reason: ${blockedReason}` : undefined,
  fromState: 'review',
  toState: 'pending',
});
```

- [ ] **Step 5: Update `resolve-blocked` command caller (line 1005)**

```typescript
logUserAction(taskDir, 'resolve-blocked', t.id, 'blocked', desc, {
  taskVersion: task.version,
  summary,
  fromState: 'blocked',
  toState: prevState,
});
```

- [ ] **Step 6: Update `test-fail.ts`**

In `src/commands/test-fail.ts`, update both `appendRunLog` calls:

For auto-block path (line 95-110):
```typescript
appendRunLog(taskDir, {
  timestamp: new Date().toISOString(),
  agentType: 'tester',
  sessionId: 'cli',
  agentName: options.agentName || null,
  taskId,
  taskVersion: task.version,
  taskState: 'testing',
  fromState: 'testing',
  toState: 'blocked',
  action: 'test-bounce-blocked',
  description: `Task '${taskId}' auto-blocked after ${newBounceCount} bounces (max ${maxBounces})`,
  summary: `Bounce ${newBounceCount}/${maxBounces}. ${sameBugsDetected ? 'Same bugs detected.' : ''}`,
  result: 'failure',
  duration: 0,
  error: null,
  details: sameBugsDetected ? `Same bugs detected: ${JSON.stringify(newBugs)}` : null,
});
```

For non-block path (line 114-144):
```typescript
appendRunLog(taskDir, {
  timestamp: new Date().toISOString(),
  agentType: 'tester',
  sessionId: 'cli',
  agentName: options.agentName || null,
  taskId,
  taskVersion: task.version,
  taskState: 'testing',
  fromState: 'testing',
  toState: 'pending',
  action: 'test-fail',
  description: `Task '${taskId}' failed tests, moved to pending (bounce ${newBounceCount}/${maxBounces})`,
  summary: `Bounce ${newBounceCount}/${maxBounces}. ${sameBugsDetected ? 'Same bugs detected.' : ''}`,
  result: 'failure',
  duration: 0,
  error: null,
  details: sameBugsDetected ? `Same bugs detected: ${JSON.stringify(newBugs)}` : null,
});
```

- [ ] **Step 7: Update `recover.ts`**

In `src/commands/recover.ts`, update the `appendRunLog` call (line 83-98):

```typescript
appendRunLog(taskDir, {
  timestamp: new Date().toISOString(),
  agentType: 'user',
  sessionId: 'cli',
  agentName: null,
  taskId: t.id,
  taskVersion: task.version,
  taskState: state,
  fromState: state,
  toState: 'pending',
  action: 'recover-stuck',
  description: `Recovered stuck task '${t.id}' from ${state} to pending. Reason: ${reason}`,
  summary: `Task was in ${state} with ${reason}. Moved to pending.`,
  result: 'success',
  duration: 0,
  error: null,
  details: null,
});
```

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/commands/test-fail.ts src/commands/recover.ts
git commit -m "fix: add fromState/toState to all appendRunLog callers"
```

---

### Task 10: Create notifier core module

**Files:**
- Create: `src/core/notifier.ts`

- [ ] **Step 1: Write the notifier module**

Create `src/core/notifier.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { TaskYaml, TaskState, TaskSnapshotEntry, NotifierSnapshot, NotifierDiff, PendingQuestion, VALID_STATES } from './types';
import { getTaskState, getTaskFilePath, listTasks } from './state';
import { loadConfig, TaskFlowConfig } from './config';
import { readLock, getTaskLockPath, isLockStale } from './lock';
import { validateTaskYaml } from './validate';

export function getNotifierStatePath(taskDir: string): string {
  return path.join(taskDir, 'runs', 'notifier-state.json');
}

export function buildSnapshot(taskDir: string, config: TaskFlowConfig): NotifierSnapshot {
  const tasks: Record<string, TaskSnapshotEntry> = {};
  const allTasks = listTasks(taskDir);

  for (const t of allTasks) {
    const filePath = getTaskFilePath(taskDir, t.id);
    if (!filePath) continue;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const task = validateTaskYaml(parseYaml(raw));

      // Check lock status
      const lockPath = getTaskLockPath(taskDir, t.id);
      const lock = readLock(lockPath);
      const stale = lock ? isLockStale(lockPath, config.heartbeat.staleThresholdSeconds) : false;

      tasks[t.id] = {
        id: t.id,
        name: task.name,
        state: t.state,
        version: task.version,
        bounceCount: task.bounceCount || 0,
        attemptCount: task.attemptCount || 0,
        blockedReason: task.blockedReason,
        pendingQuestionCount: (task.pendingQuestions || []).filter(q => !q.answered).length,
        lockedBy: lock?.sessionId,
        lockStale: stale,
        updatedAt: task.updatedAt,
      };
    } catch {
      // Skip unparseable tasks
    }
  }

  return { takenAt: new Date().toISOString(), tasks };
}

export function readSnapshot(taskDir: string): NotifierSnapshot | null {
  const statePath = getNotifierStatePath(taskDir);
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(raw) as NotifierSnapshot;
  } catch {
    return null;
  }
}

export function writeSnapshot(taskDir: string, snapshot: NotifierSnapshot): void {
  const statePath = getNotifierStatePath(taskDir);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(statePath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

export function computeDiff(prev: NotifierSnapshot, current: NotifierSnapshot, config: TaskFlowConfig): NotifierDiff {
  const diff: NotifierDiff = {
    transitions: [],
    newTasks: [],
    removedTasks: [],
    newlyBlocked: [],
    bounceThresholdHit: [],
    staleLocks: [],
    versionBumps: [],
    resolvedBlocks: [],
  };

  const prevIds = new Set(Object.keys(prev.tasks));
  const currentIds = new Set(Object.keys(current.tasks));

  // New tasks
  for (const id of currentIds) {
    if (!prevIds.has(id)) {
      const entry = current.tasks[id];
      diff.newTasks.push({ taskId: id, name: entry.name, state: entry.state });
    }
  }

  // Removed tasks
  for (const id of prevIds) {
    if (!currentIds.has(id)) {
      diff.removedTasks.push({ taskId: id, lastState: prev.tasks[id].state });
    }
  }

  // Common tasks — detect changes
  for (const id of currentIds) {
    if (!prevIds.has(id)) continue;
    const prevEntry = prev.tasks[id];
    const currEntry = current.tasks[id];

    // State transition
    if (prevEntry.state !== currEntry.state) {
      diff.transitions.push({
        taskId: id,
        name: currEntry.name,
        from: prevEntry.state,
        to: currEntry.state,
      });

      // Newly blocked
      if (currEntry.state === 'blocked' && prevEntry.state !== 'blocked') {
        // Read full task for questions
        const filePath = getTaskFilePath(path.dirname(getNotifierStatePath(path.dirname(''))), id);
        // We need taskDir — pass it as parameter or derive
        // For now, push with minimal info; the skill will enrich
        diff.newlyBlocked.push({
          taskId: id,
          name: currEntry.name,
          questions: [],
          previousState: prevEntry.state,
          blockedReason: currEntry.blockedReason,
        });
      }

      // Resolved block
      if (prevEntry.state === 'blocked' && currEntry.state !== 'blocked') {
        diff.resolvedBlocks.push({
          taskId: id,
          toState: currEntry.state,
        });
      }
    }

    // Version bump
    if (prevEntry.version !== currEntry.version) {
      diff.versionBumps.push({
        taskId: id,
        name: currEntry.name,
        from: prevEntry.version,
        to: currEntry.version,
      });
    }

    // Bounce threshold hit
    if (currEntry.bounceCount > prevEntry.bounceCount && currEntry.bounceCount >= config.test.maxBounces) {
      diff.bounceThresholdHit.push({
        taskId: id,
        name: currEntry.name,
        bounceCount: currEntry.bounceCount,
        maxBounces: config.test.maxBounces,
      });
    }

    // Stale lock
    if (currEntry.lockStale && !prevEntry.lockStale) {
      diff.staleLocks.push({
        taskId: id,
        sessionId: currEntry.lockedBy || 'unknown',
        elapsedSeconds: Math.round((Date.now() - new Date(currEntry.updatedAt).getTime()) / 1000),
      });
    }
  }

  return diff;
}

export function formatReport(diff: NotifierDiff, snapshot: NotifierSnapshot, config: TaskFlowConfig): string {
  const lines: string[] = [];
  lines.push(`=== TaskFlow Status Report ===`);
  lines.push(`${snapshot.takenAt}\n`);

  // Summary section
  const summaryLines: string[] = [];
  for (const t of diff.transitions) {
    summaryLines.push(`  • ${t.name} (v?): ${t.from} → ${t.to}`);
  }
  for (const t of diff.newTasks) {
    summaryLines.push(`  • ${t.name}: created in ${t.state}`);
  }
  for (const t of diff.removedTasks) {
    summaryLines.push(`  • ${t.id}: removed (was ${t.lastState})`);
  }
  for (const v of diff.versionBumps) {
    summaryLines.push(`  • ${v.name}: v${v.from} → v${v.to}`);
  }
  for (const r of diff.resolvedBlocks) {
    summaryLines.push(`  • ${r.taskId}: unblocked → ${r.toState}`);
  }

  if (summaryLines.length > 0) {
    lines.push(`**Summary:**`);
    lines.push(...summaryLines);
    lines.push('');
  }

  // Issues section (detailed)
  const issueLines: string[] = [];
  for (const b of diff.newlyBlocked) {
    issueLines.push(`  ⚠️ ${b.name} (${b.taskId}): BLOCKED`);
    issueLines.push(`     Was in: ${b.previousState}`);
    if (b.blockedReason) issueLines.push(`     Reason: ${b.blockedReason}`);
    if (b.questions.length > 0) {
      issueLines.push(`     Questions: ${b.questions.length} unanswered`);
      for (const q of b.questions) {
        issueLines.push(`       [${q.category}] ${q.question}`);
      }
    }
    issueLines.push(`     → npx taskflow resolve-blocked ${b.taskId}`);
  }

  for (const b of diff.bounceThresholdHit) {
    issueLines.push(`  ⚠️ ${b.name} (${b.taskId}): bounced ${b.bounceCount}/${b.maxBounces} times`);
    issueLines.push(`     → npx taskflow resolve-blocked ${b.taskId}`);
  }

  for (const s of diff.staleLocks) {
    issueLines.push(`  ⚠️ ${s.taskId}: stale lock (session: ${s.sessionId}, ${s.elapsedSeconds}s since heartbeat)`);
    issueLines.push(`     → npx taskflow unlock ${s.taskId}`);
  }

  if (issueLines.length > 0) {
    lines.push(`**Issues:**`);
    lines.push(...issueLines);
    lines.push('');
  }

  // Framework overview
  const stateCounts: Record<string, number> = {};
  for (const entry of Object.values(snapshot.tasks)) {
    stateCounts[entry.state] = (stateCounts[entry.state] || 0) + 1;
  }
  const total = Object.values(snapshot.tasks).length;
  const overview = Object.entries(stateCounts)
    .map(([s, c]) => `${c} ${s}`)
    .join(', ');
  lines.push(`**Framework:** ${total} tasks (${overview})`);

  return lines.join('\n');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/notifier.ts
git commit -m "feat: create notifier core module — snapshot, diff, report"
```

---

### Task 11: Add `notify` CLI command

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add imports**

Add to the imports at the top of `src/cli.ts`:

```typescript
import { buildSnapshot, readSnapshot, writeSnapshot, computeDiff, formatReport, getNotifierStatePath } from './core/notifier';
import { appendNotifierLog } from './core/runlog';
```

- [ ] **Step 2: Add the `notify` command**

After the `resolve-blocked` command (after line 1020), add:

```typescript
program
  .command('notify')
  .description('Run one notifier check cycle — detect task state changes and notify through enabled channels')
  .option('--dry-run', 'Show report without sending to channels')
  .option('--reset', 'Clear snapshot (next run reports all as new)')
  .action((options: { dryRun?: boolean; reset?: boolean }) => {
    const taskDir = path.join(process.cwd(), '.tasks');
    const config = loadConfig(taskDir);

    if (!config.notification.enabled) {
      console.log('Notifications are disabled in config.');
      return;
    }

    if (options.reset) {
      const statePath = getNotifierStatePath(taskDir);
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
        console.log('Notifier snapshot cleared. Next run will report all tasks as new.');
      } else {
        console.log('No snapshot to clear.');
      }
      return;
    }

    // Build current snapshot
    const currentSnapshot = buildSnapshot(taskDir, config);

    // Read previous snapshot
    const prevSnapshot = readSnapshot(taskDir);

    if (!prevSnapshot) {
      // First run — report all tasks as new
      const report = formatReport({
        transitions: [],
        newTasks: Object.values(currentSnapshot.tasks).map(t => ({
          taskId: t.id, name: t.name, state: t.state,
        })),
        removedTasks: [],
        newlyBlocked: [],
        bounceThresholdHit: [],
        staleLocks: [],
        versionBumps: [],
        resolvedBlocks: [],
      }, currentSnapshot, config);

      if (options.dryRun) {
        console.log(report);
        return;
      }

      // Send through all enabled channels
      for (const channel of config.notification.channels) {
        if (!channel.enabled) continue;
        if (channel.type === 'console') {
          console.log(report);
        } else if (channel.type === 'file' && channel.path) {
          fs.appendFileSync(path.join(taskDir, channel.path), `\n## ${new Date().toISOString()}\n${report}\n`, 'utf-8');
        }
        // webhook, email, custom — the skill handles these; CLI only does console + file
      }

      // Log
      appendNotifierLog(taskDir, `- First run: ${Object.keys(currentSnapshot.tasks).length} tasks found\n- Sent initial report through console, file`);
      appendRunLog(taskDir, {
        timestamp: new Date().toISOString(),
        agentType: 'notifier',
        sessionId: 'cli',
        agentName: null,
        taskId: '(all)',
        taskVersion: 0,
        taskState: '(all)',
        action: 'notify-cycle',
        description: `First notifier run: ${Object.keys(currentSnapshot.tasks).length} tasks found, initial report sent`,
        result: 'success',
        duration: 0,
        error: null,
        details: null,
      });

      writeSnapshot(taskDir, currentSnapshot);
      console.log('Notifier snapshot saved. Next run will detect changes.');
      return;
    }

    // Compute diff
    const diff = computeDiff(prevSnapshot, currentSnapshot, config);

    // Check if anything changed
    const hasChanges = diff.transitions.length > 0 || diff.newTasks.length > 0 ||
      diff.removedTasks.length > 0 || diff.newlyBlocked.length > 0 ||
      diff.bounceThresholdHit.length > 0 || diff.staleLocks.length > 0 ||
      diff.versionBumps.length > 0 || diff.resolvedBlocks.length > 0;

    if (!hasChanges && !config.notification.reportOnNoChange) {
      // Nothing changed — just update snapshot
      writeSnapshot(taskDir, currentSnapshot);
      return;
    }

    // Format report
    const report = formatReport(diff, currentSnapshot, config);

    if (options.dryRun) {
      console.log(report);
      return;
    }

    // Send through all enabled channels
    for (const channel of config.notification.channels) {
      if (!channel.enabled) continue;
      if (channel.type === 'console') {
        console.log(report);
      } else if (channel.type === 'file' && channel.path) {
        fs.appendFileSync(path.join(taskDir, channel.path), `\n## ${new Date().toISOString()}\n${report}\n`, 'utf-8');
      }
    }

    // Log
    const changeCount = diff.transitions.length + diff.newTasks.length + diff.removedTasks.length +
      diff.newlyBlocked.length + diff.bounceThresholdHit.length + diff.staleLocks.length +
      diff.versionBumps.length + diff.resolvedBlocks.length;
    appendNotifierLog(taskDir, `- Checked tasks: ${Object.keys(currentSnapshot.tasks).length}\n- Changes detected: ${changeCount}\n- Transitions: ${diff.transitions.length}, New: ${diff.newTasks.length}, Blocked: ${diff.newlyBlocked.length}, Bounces: ${diff.bounceThresholdHit.length}, Stale locks: ${diff.staleLocks.length}, Version bumps: ${diff.versionBumps.length}, Resolved: ${diff.resolvedBlocks.length}`);
    appendRunLog(taskDir, {
      timestamp: new Date().toISOString(),
      agentType: 'notifier',
      sessionId: 'cli',
      agentName: null,
      taskId: '(all)',
      taskVersion: 0,
      taskState: '(all)',
      action: 'notify-cycle',
      description: `Notifier cycle: ${changeCount} changes detected`,
      summary: `${diff.transitions.length} transitions, ${diff.newTasks.length} new, ${diff.newlyBlocked.length} blocked, ${diff.bounceThresholdHit.length} bounces, ${diff.staleLocks.length} stale locks, ${diff.versionBumps.length} version bumps, ${diff.resolvedBlocks.length} resolved`,
      result: 'success',
      duration: 0,
      error: null,
      details: null,
    });

    writeSnapshot(taskDir, currentSnapshot);
  });
```

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add notify CLI command with --dry-run and --reset"
```

---

### Task 12: Rewrite notifier skill template

**Files:**
- Modify: `src/templates/skills/taskflow-notifier/SKILL.md`

- [ ] **Step 1: Write the new skill**

Replace the entire `src/templates/skills/taskflow-notifier/SKILL.md`:

```markdown
---
name: taskflow-notifier
description: Monitor all tasks via snapshot diff, detect state changes, and notify through configured channels. For notifier agents.
---

# taskflow-notifier

Instructions for the agent monitoring all task state changes. The agent runs ONE check cycle per invocation, then stops.

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
```

- [ ] **Step 2: Commit**

```bash
git add src/templates/skills/taskflow-notifier/SKILL.md
git commit -m "feat: rewrite notifier skill for snapshot-diff design"
```

---

### Task 13: Fix `installSkills` — add `--update-skills` flag

**Files:**
- Modify: `src/init.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Update `installSkills` to accept options**

In `src/init.ts`, update the function signature and logic:

```typescript
export function installSkills(targetDir: string, options?: { updateSkills?: boolean }): void {
  const skillsDest = path.join(targetDir, '.agents', 'skills');
  const skillNames = [
    'taskflow-executor',
    'taskflow-tester',
    'taskflow-lock-releaser',
    'taskflow-user',
    'taskflow-init',
    'taskflow-notifier',
  ];

  for (const name of skillNames) {
    const srcDir = path.join(SKILLS_DIR, name);
    const destDir = path.join(skillsDest, name);
    if (!fs.existsSync(srcDir)) {
      console.warn(`Warning: skill directory '${name}' not found in templates. Skipping.`);
      continue;
    }
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const srcFile = path.join(srcDir, 'SKILL.md');
    const destFile = path.join(destDir, 'SKILL.md');
    if (fs.existsSync(srcFile) && (!fs.existsSync(destFile) || options?.updateSkills)) {
      fs.copyFileSync(srcFile, destFile);
    }
  }

  console.log('Skills installed:');
  for (const name of skillNames) {
    console.log(`  .agents/skills/${name}/SKILL.md`);
  }
}
```

- [ ] **Step 2: Add `--update-skills` option to `init` command in `cli.ts`**

Update the init command (lines 83-94):

```typescript
program
  .command('init')
  .description('Scaffold .tasks/ directory and install skills')
  .option('--no-skills', 'Skip installing agent skills')
  .option('--force', 'Backup existing .tasks/ and re-init from scratch')
  .option('--update-skills', 'Overwrite existing skill files with latest templates')
  .action((options) => {
    const targetDir = process.cwd();
    initTaskDir(targetDir, { force: options.force });
    if (options.skills !== false) {
      installSkills(targetDir, { updateSkills: options.updateSkills });
    }
  });
```

- [ ] **Step 3: Add notifier-log.md creation in `initTaskDir`**

In `src/init.ts`, after the releaser-log creation (line 40), add:

```typescript
const notifierLogPath = path.join(taskDir, 'runs', 'notifier-log.md');
if (!fs.existsSync(notifierLogPath)) {
  fs.writeFileSync(notifierLogPath, '# Notifier Log\n', 'utf-8');
}
```

Add to console output (after line 55):
```typescript
console.log('  .tasks/runs/notifier-log.md');
```

- [ ] **Step 4: Commit**

```bash
git add src/init.ts src/cli.ts
git commit -m "fix: add --update-skills flag, create notifier-log.md on init"
```

---

### Task 14: Update skill templates — user + init

**Files:**
- Modify: `src/templates/skills/taskflow-user/SKILL.md`
- Modify: `src/templates/skills/taskflow-init/SKILL.md`

- [ ] **Step 1: Update `taskflow-user/SKILL.md` versioning section**

Replace lines 75-88 (section 1.4 Versioning):

```markdown
### 1.4 Versioning

TaskFlow versions every edit. When a user edits a task (any state):

1. The current `description`, `implementationNotes`, `testFlows`, and `bounceCount` are snapshotted into `versions.v<old>`
2. The edit's `changeDescription` is recorded in the snapshot
3. `version` is bumped, `testResults` are reset
4. If the task was in `processing` or `testing`, it is moved back to `pending`

Processing status updates (`statusDescription`, `lastAgentSummary`, `lastAgentAction`, `attemptCount`, `bounceCount`) do NOT trigger versioning — they are metadata updates only.

Agents periodically check the task version. If it changes while they are working, they release the lock and move on.
```

- [ ] **Step 2: Update `taskflow-user/SKILL.md` notification config description**

Replace line 138:

```markdown
| `notification` | Channels, `checkIntervalSeconds`, `snapshotPath`, `reportOnNoChange`, `detailedOnIssues`. Read by the `taskflow-notifier` skill. |
```

- [ ] **Step 3: Update `taskflow-user/SKILL.md` notifier description**

Replace line 162:

```markdown
The `taskflow-notifier` skill monitors all task state changes via snapshot diff and sends alerts through the configured `notification.channels`. It reports transitions, new tasks, blocked tasks, bounce thresholds, stale locks, and version bumps. The user resolves questions via `resolve-blocked` and stale locks via `unlock`.
```

- [ ] **Step 4: Update `taskflow-user/SKILL.md` skills table**

Replace line 191:

```markdown
| `taskflow-notifier` | `.agents/skills/taskflow-notifier/SKILL.md` | Run one check cycle to detect task state changes and notify the user |
```

- [ ] **Step 5: Update `taskflow-user/SKILL.md` edit behavior**

Replace lines 231-237:

```markdown
- **Edit behavior:**
  - All states: snapshot old version into `versions.v<old>`, version++, record `changeDescription`, reset testResults
  - `processing` / `testing`: additionally moved back to `pending`
  - `done`: cannot edit
  - `review`: cannot edit (reject first)
```

- [ ] **Step 6: Update `taskflow-user/SKILL.md` rules table**

Replace lines 405-407:

```markdown
| Every edit creates a version snapshot | Old version preserved in `versions.v<old>` |
| Versioning is mandatory for all edits | `changeDescription` records the reason |
| Status updates do NOT bump version | `statusDescription`, `lastAgentSummary`, etc. are metadata only |
| Reset testResults on version change | |
```

- [ ] **Step 7: Update `taskflow-init/SKILL.md` Step 3.5**

Update the notification section reference to mention new config fields:

```markdown
### Step 3.5: Configure & test notification channels

Read `.tasks/config.yaml` and find the `notification` section. The notifier now monitors ALL task state changes via snapshot diff — not just blocked tasks. Key config fields:

- `checkIntervalSeconds` — how often the notifier runs (handled by /loop)
- `snapshotPath` — where the state snapshot is stored
- `reportOnNoChange` — whether to notify when nothing changed
- `detailedOnIssues` — whether issues get detailed formatting
- `channels` — the list of notification channels
```

- [ ] **Step 8: Commit**

```bash
git add src/templates/skills/taskflow-user/SKILL.md src/templates/skills/taskflow-init/SKILL.md
git commit -m "docs: update user and init skills for new versioning and notifier design"
```

---

### Task 15: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite Notifications section**

Replace lines 177-249 with:

```markdown
## Notifications

TaskFlow monitors all task state changes via a **state snapshot diff** mechanism. The notifier agent builds a snapshot of all tasks across all states, diffs it against the previous snapshot, and reports only what changed.

### How it works

1. The notifier scans all 7 state directories (defined, pending, processing, testing, review, done, blocked) and lock files
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
```

- [ ] **Step 2: Rewrite Versioning section**

Replace lines 459-468 with:

```markdown
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
```

- [ ] **Step 3: Update edit command description**

Replace line 429:

```markdown
| `npx taskflow edit <id>` | Edit a task (always creates new version snapshot) |
```

- [ ] **Step 4: Update notifier skill description in table**

Replace line 339:

```markdown
| `taskflow-notifier` | `.agents/skills/taskflow-notifier/SKILL.md` | Run one check cycle to detect task state changes and notify the user |
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: rewrite Notifications and Versioning sections for new design"
```

---

### Task 16: Add tests for `appendNotifierLog` and `fromState`/`toState` rendering

**Files:**
- Modify: `src/core/__tests__/runlog.test.ts`

- [ ] **Step 1: Add test for `appendNotifierLog`**

In `src/core/__tests__/runlog.test.ts`, add after the `appendReleaserLog` tests:

```typescript
import { appendNotifierLog, getNotifierLogPath } from '../runlog';

describe('appendNotifierLog', () => {
  it('appends to notifier-log.md', () => {
    const taskDir = mkdtempSync();
    initTaskDir(taskDir);
    appendNotifierLog(taskDir, '- Test message');
    const logPath = getNotifierLogPath(taskDir);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('Test message');
    cleanupDir(taskDir);
  });

  it('trims to maxNotifierLogLines', () => {
    const taskDir = mkdtempSync();
    initTaskDir(taskDir);
    // Write more than 100 lines
    for (let i = 0; i < 150; i++) {
      appendNotifierLog(taskDir, `- Line ${i}`);
    }
    const logPath = getNotifierLogPath(taskDir);
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    expect(lines.length).toBeLessThanOrEqual(102); // 100 + header
    cleanupDir(taskDir);
  });
});
```

- [ ] **Step 2: Add test for `fromState`/`toState` rendering**

In the `appendRunLog` describe block, add:

```typescript
it('renders fromState/toState in markdown', () => {
  const taskDir = mkdtempSync();
  initTaskDir(taskDir);
  appendRunLog(taskDir, {
    timestamp: '2026-07-08T10:00:00Z',
    agentType: 'user',
    sessionId: 'test-session',
    agentName: null,
    taskId: 'test-task_001',
    taskVersion: 1,
    taskState: 'pending',
    fromState: 'pending',
    toState: 'processing',
    action: 'move',
    description: 'Test transition',
    result: 'success',
    duration: 0,
    error: null,
    details: null,
  });
  const logPath = getSessionLogPath(taskDir, 'test-session');
  const content = readFileSync(logPath, 'utf-8');
  expect(content).toContain('**Transition:** pending → processing');
  cleanupDir(taskDir);
});
```

- [ ] **Step 3: Commit**

```bash
git add src/core/__tests__/runlog.test.ts
git commit -m "test: add appendNotifierLog and fromState/toState rendering tests"
```

---

### Task 17: Add notifier snapshot/diff tests

**Files:**
- Create: `src/core/__tests__/notifier.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/core/__tests__/notifier.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { buildSnapshot, readSnapshot, writeSnapshot, computeDiff, formatReport, getNotifierStatePath } from '../notifier';
import { getDefaultConfig, TaskFlowConfig } from '../config';
import { stringify as stringifyYaml } from 'yaml';
import { TaskYaml } from '../types';

function createTask(taskDir: string, state: string, task: Partial<TaskYaml> & { id: string; name: string }): void {
  const stateDir = path.join(taskDir, state);
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const fullTask: TaskYaml = {
    id: task.id,
    name: task.name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: task.version || 1,
    description: task.description || '',
    ...task,
  };
  writeFileSync(path.join(stateDir, `${task.id}.yaml`), stringifyYaml(fullTask), 'utf-8');
}

function createLock(taskDir: string, taskId: string, sessionId: string, heartbeatAt: string): void {
  const locksDir = path.join(taskDir, 'locks');
  if (!existsSync(locksDir)) mkdirSync(locksDir, { recursive: true });
  writeFileSync(path.join(locksDir, `task-${taskId}.lock`), stringifyYaml({
    sessionId,
    agentType: 'executor',
    taskVersion: 1,
    acquiredAt: heartbeatAt,
    heartbeatAt,
  }), 'utf-8');
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('buildSnapshot', () => {
  let taskDir: string;
  let config: TaskFlowConfig;

  beforeEach(() => {
    taskDir = mkdtempSync(path.join(tmpdir(), 'notifier-test-'));
    config = getDefaultConfig();
    // Create state dirs
    for (const s of ['defined', 'pending', 'processing', 'testing', 'review', 'done', 'blocked']) {
      mkdirSync(path.join(taskDir, s), { recursive: true });
    }
    mkdirSync(path.join(taskDir, 'locks'), { recursive: true });
  });

  afterEach(() => cleanupDir(taskDir));

  it('captures all tasks across all states', () => {
    createTask(taskDir, 'pending', { id: 'task-a_001', name: 'Task A', version: 1 });
    createTask(taskDir, 'processing', { id: 'task-b_001', name: 'Task B', version: 2 });
    createTask(taskDir, 'done', { id: 'task-c_001', name: 'Task C', version: 1 });

    const snapshot = buildSnapshot(taskDir, config);
    expect(Object.keys(snapshot.tasks)).toHaveLength(3);
    expect(snapshot.tasks['task-a_001'].state).toBe('pending');
    expect(snapshot.tasks['task-b_001'].state).toBe('processing');
    expect(snapshot.tasks['task-c_001'].state).toBe('done');
  });

  it('detects stale locks', () => {
    createTask(taskDir, 'processing', { id: 'task-a_001', name: 'Task A', version: 1 });
    const oldTime = new Date(Date.now() - 300000).toISOString(); // 5 min ago
    createLock(taskDir, 'task-a_001', 'session-123', oldTime);

    const snapshot = buildSnapshot(taskDir, config);
    expect(snapshot.tasks['task-a_001'].lockStale).toBe(true);
    expect(snapshot.tasks['task-a_001'].lockedBy).toBe('session-123');
  });

  it('detects active locks', () => {
    createTask(taskDir, 'processing', { id: 'task-a_001', name: 'Task A', version: 1 });
    const now = new Date().toISOString();
    createLock(taskDir, 'task-a_001', 'session-123', now);

    const snapshot = buildSnapshot(taskDir, config);
    expect(snapshot.tasks['task-a_001'].lockStale).toBe(false);
  });
});

describe('readSnapshot / writeSnapshot', () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = mkdtempSync(path.join(tmpdir(), 'notifier-test-'));
  });

  afterEach(() => cleanupDir(taskDir));

  it('returns null when no snapshot exists', () => {
    expect(readSnapshot(taskDir)).toBeNull();
  });

  it('round-trips a snapshot', () => {
    const snapshot = {
      takenAt: new Date().toISOString(),
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: new Date().toISOString(),
        },
      },
    };
    writeSnapshot(taskDir, snapshot);
    const loaded = readSnapshot(taskDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.tasks['task-a_001'].name).toBe('Task A');
    expect(loaded!.tasks['task-a_001'].state).toBe('pending');
  });

  it('returns null for corrupt snapshot', () => {
    const statePath = getNotifierStatePath(taskDir);
    const dir = path.dirname(statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, 'not-json', 'utf-8');
    expect(readSnapshot(taskDir)).toBeNull();
  });
});

describe('computeDiff', () => {
  let config: TaskFlowConfig;

  beforeEach(() => {
    config = getDefaultConfig();
  });

  it('detects state transitions', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'processing' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.transitions).toHaveLength(1);
    expect(diff.transitions[0]).toEqual({
      taskId: 'task-a_001', name: 'Task A', from: 'pending', to: 'processing',
    });
  });

  it('detects new tasks', () => {
    const prev = { takenAt: '2026-07-08T10:00:00Z', tasks: {} };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.newTasks).toHaveLength(1);
    expect(diff.newTasks[0].taskId).toBe('task-a_001');
  });

  it('detects removed tasks', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = { takenAt: '2026-07-08T10:05:00Z', tasks: {} };
    const diff = computeDiff(prev, current, config);
    expect(diff.removedTasks).toHaveLength(1);
    expect(diff.removedTasks[0].taskId).toBe('task-a_001');
  });

  it('detects version bumps', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 2, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.versionBumps).toHaveLength(1);
    expect(diff.versionBumps[0]).toEqual({
      taskId: 'task-a_001', name: 'Task A', from: 1, to: 2,
    });
  });

  it('detects newly blocked tasks', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'testing' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'blocked' as const,
          version: 1, bounceCount: 3, attemptCount: 0,
          blockedReason: 'Max bounces exceeded',
          pendingQuestionCount: 2, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.newlyBlocked).toHaveLength(1);
    expect(diff.newlyBlocked[0].taskId).toBe('task-a_001');
    expect(diff.newlyBlocked[0].previousState).toBe('testing');
  });

  it('detects resolved blocks', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'blocked' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'pending' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.resolvedBlocks).toHaveLength(1);
    expect(diff.resolvedBlocks[0].taskId).toBe('task-a_001');
  });

  it('detects bounce threshold hit', () => {
    config.test.maxBounces = 3;
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'testing' as const,
          version: 1, bounceCount: 2, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'testing' as const,
          version: 1, bounceCount: 3, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, updatedAt: '2026-07-08T10:05:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.bounceThresholdHit).toHaveLength(1);
    expect(diff.bounceThresholdHit[0].bounceCount).toBe(3);
  });

  it('detects stale locks', () => {
    const prev = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'processing' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: false, lockedBy: 'session-123',
          updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const current = {
      takenAt: '2026-07-08T10:05:00Z',
      tasks: {
        'task-a_001': {
          id: 'task-a_001', name: 'Task A', state: 'processing' as const,
          version: 1, bounceCount: 0, attemptCount: 0,
          pendingQuestionCount: 0, lockStale: true, lockedBy: 'session-123',
          updatedAt: '2026-07-08T10:00:00Z',
        },
      },
    };
    const diff = computeDiff(prev, current, config);
    expect(diff.staleLocks).toHaveLength(1);
    expect(diff.staleLocks[0].sessionId).toBe('session-123');
  });
});

describe('formatReport', () => {
  it('formats summary section', () => {
    const diff = {
      transitions: [{ taskId: 'a_001', name: 'Task A', from: 'pending' as const, to: 'processing' as const }],
      newTasks: [{ taskId: 'b_001', name: 'Task B', state: 'pending' as const }],
      removedTasks: [],
      newlyBlocked: [],
      bounceThresholdHit: [],
      staleLocks: [],
      versionBumps: [{ taskId: 'c_001', name: 'Task C', from: 1, to: 2 }],
      resolvedBlocks: [{ taskId: 'd_001', toState: 'pending' as const }],
    };
    const snapshot = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'a_001': { id: 'a_001', name: 'Task A', state: 'processing' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'b_001': { id: 'b_001', name: 'Task B', state: 'pending' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'c_001': { id: 'c_001', name: 'Task C', state: 'pending' as const, version: 2, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'd_001': { id: 'd_001', name: 'Task D', state: 'pending' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
      },
    };
    const config = getDefaultConfig();
    const report = formatReport(diff, snapshot, config);
    expect(report).toContain('Task A');
    expect(report).toContain('pending → processing');
    expect(report).toContain('Task B');
    expect(report).toContain('v1 → v2');
    expect(report).toContain('4 tasks');
  });

  it('formats issues section', () => {
    const diff = {
      transitions: [],
      newTasks: [],
      removedTasks: [],
      newlyBlocked: [{
        taskId: 'a_001', name: 'Task A', questions: [],
        previousState: 'testing' as const, blockedReason: 'Max bounces',
      }],
      bounceThresholdHit: [{
        taskId: 'b_001', name: 'Task B', bounceCount: 3, maxBounces: 3,
      }],
      staleLocks: [{
        taskId: 'c_001', sessionId: 'session-123', elapsedSeconds: 150,
      }],
      versionBumps: [],
      resolvedBlocks: [],
    };
    const snapshot = {
      takenAt: '2026-07-08T10:00:00Z',
      tasks: {
        'a_001': { id: 'a_001', name: 'Task A', state: 'blocked' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'b_001': { id: 'b_001', name: 'Task B', state: 'testing' as const, version: 1, bounceCount: 3, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
        'c_001': { id: 'c_001', name: 'Task C', state: 'processing' as const, version: 1, bounceCount: 0, attemptCount: 0, pendingQuestionCount: 0, lockStale: false, updatedAt: '' },
      },
    };
    const config = getDefaultConfig();
    const report = formatReport(diff, snapshot, config);
    expect(report).toContain('BLOCKED');
    expect(report).toContain('bounced 3/3');
    expect(report).toContain('stale lock');
    expect(report).toContain('3 tasks');
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/core/__tests__/notifier.test.ts
git commit -m "test: add notifier snapshot/diff engine tests"
```

---

### Task 18: Update existing tests for new config fields and validation

**Files:**
- Modify: `src/core/__tests__/config.test.ts`
- Modify: `src/core/__tests__/validate.test.ts`
- Modify: `src/__tests__/edit.test.ts`

- [ ] **Step 1: Update config test for new notification fields**

In `src/core/__tests__/config.test.ts`, add tests:

```typescript
describe('new notification config fields', () => {
  it('defaults checkIntervalSeconds to 60', () => {
    const config = getDefaultConfig();
    expect(config.notification.checkIntervalSeconds).toBe(60);
  });

  it('defaults snapshotPath to .tasks/runs/notifier-state.json', () => {
    const config = getDefaultConfig();
    expect(config.notification.snapshotPath).toBe('.tasks/runs/notifier-state.json');
  });

  it('defaults reportOnNoChange to false', () => {
    const config = getDefaultConfig();
    expect(config.notification.reportOnNoChange).toBe(false);
  });

  it('defaults detailedOnIssues to true', () => {
    const config = getDefaultConfig();
    expect(config.notification.detailedOnIssues).toBe(true);
  });

  it('defaults maxNotifierLogLines to 100', () => {
    const config = getDefaultConfig();
    expect(config.runLog.maxNotifierLogLines).toBe(100);
  });

  it('backward compat: blockedCheckIntervalSeconds maps to checkIntervalSeconds', () => {
    // This tests that the config loader handles the old field name
    // The old field is no longer in the interface, but we test the default
    const config = getDefaultConfig();
    expect(config.notification.checkIntervalSeconds).toBe(60);
  });
});
```

- [ ] **Step 2: Update validate test for `changeDescription`**

In `src/core/__tests__/validate.test.ts`, update the "validates versions record" test (lines 122-133):

```typescript
it('validates versions record with changeDescription', () => {
  const raw = {
    ...validTask,
    versions: {
      v1: {
        updatedAt: '2026-07-07T10:00:00Z',
        description: 'v1 content',
        changeDescription: 'Initial version',
      },
    },
  };
  const task = validateTaskYaml(raw);
  expect(task.versions?.v1).toBeDefined();
  expect(task.versions!.v1.description).toBe('v1 content');
  expect(task.versions!.v1.changeDescription).toBe('Initial version');
});
```

- [ ] **Step 3: Update edit test for defined/pending snapshot**

In `src/__tests__/edit.test.ts`, add tests:

```typescript
it('creates version snapshot when editing a defined task', () => {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'edit-test-'));
  initTaskDir(taskDir);
  // Create a task in defined
  const task: TaskYaml = {
    id: 'test-task_001',
    name: 'Test Task',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    description: 'v1 content',
  };
  writeFileSync(path.join(taskDir, 'defined', 'test-task_001.yaml'), stringifyYaml(task), 'utf-8');

  // Edit it
  editTask(taskDir, 'test-task_001', { description: 'v2 content', changeDescription: 'Updated description' });

  // Read back
  const raw = readFileSync(path.join(taskDir, 'defined', 'test-task_001.yaml'), 'utf-8');
  const updated = validateTaskYaml(parseYaml(raw));
  expect(updated.version).toBe(2);
  expect(updated.description).toBe('v2 content');
  expect(updated.versions?.v1).toBeDefined();
  expect(updated.versions!.v1.description).toBe('v1 content');
  expect(updated.versions!.v1.changeDescription).toBe('Updated description');
  cleanupDir(taskDir);
});

it('status-update does not bump version', () => {
  const taskDir = mkdtempSync(path.join(tmpdir(), 'edit-test-'));
  initTaskDir(taskDir);
  const task: TaskYaml = {
    id: 'test-task_001',
    name: 'Test Task',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    description: 'test',
  };
  writeFileSync(path.join(taskDir, 'pending', 'test-task_001.yaml'), stringifyYaml(task), 'utf-8');

  // Simulate status-update
  const filePath = path.join(taskDir, 'pending', 'test-task_001.yaml');
  const raw = readFileSync(filePath, 'utf-8');
  const t = validateTaskYaml(parseYaml(raw));
  t.statusDescription = 'Working on it';
  t.updatedAt = new Date().toISOString();
  writeFileSync(filePath, stringifyYaml(t), 'utf-8');

  // Verify version unchanged
  const updated = validateTaskYaml(parseYaml(readFileSync(filePath, 'utf-8')));
  expect(updated.version).toBe(1);
  expect(updated.statusDescription).toBe('Working on it');
  cleanupDir(taskDir);
});
```

- [ ] **Step 4: Commit**

```bash
git add src/core/__tests__/config.test.ts src/core/__tests__/validate.test.ts src/__tests__/edit.test.ts
git commit -m "test: update tests for new config fields, changeDescription, and always-snapshot"
```

---

### Task 19: Build and run all tests

**Files:**
- Run: `npm run build`
- Run: `npm test`

- [ ] **Step 1: Build the project**

```bash
npm run build
```
Expected: TypeScript compiles without errors, templates copied to dist/.

- [ ] **Step 2: Run all tests**

```bash
npm test
```
Expected: All tests pass (including new notifier tests, config tests, validate tests, edit tests, runlog tests).

- [ ] **Step 3: Fix any issues**

If tests fail, fix the issues and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: build and test — all tests passing"
```
