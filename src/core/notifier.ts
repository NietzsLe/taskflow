import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { TaskYaml, TaskState, TaskSnapshotEntry, NotifierSnapshot, NotifierDiff } from './types';
import { getTaskFilePath, listTasks } from './state';
import { TaskFlowConfig } from './config';
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

  for (const id of currentIds) {
    if (!prevIds.has(id)) {
      const entry = current.tasks[id];
      diff.newTasks.push({ taskId: id, name: entry.name, state: entry.state });
    }
  }

  for (const id of prevIds) {
    if (!currentIds.has(id)) {
      diff.removedTasks.push({ taskId: id, lastState: prev.tasks[id].state });
    }
  }

  for (const id of currentIds) {
    if (!prevIds.has(id)) continue;
    const prevEntry = prev.tasks[id];
    const currEntry = current.tasks[id];

    if (prevEntry.state !== currEntry.state) {
      diff.transitions.push({
        taskId: id,
        name: currEntry.name,
        from: prevEntry.state,
        to: currEntry.state,
      });

      if (currEntry.state === 'blocked' && prevEntry.state !== 'blocked') {
        diff.newlyBlocked.push({
          taskId: id,
          name: currEntry.name,
          questions: [],
          previousState: prevEntry.state,
          blockedReason: currEntry.blockedReason,
        });
      }

      if (prevEntry.state === 'blocked' && currEntry.state !== 'blocked') {
        diff.resolvedBlocks.push({
          taskId: id,
          toState: currEntry.state,
        });
      }
    }

    if (prevEntry.version !== currEntry.version) {
      diff.versionBumps.push({
        taskId: id,
        name: currEntry.name,
        from: prevEntry.version,
        to: currEntry.version,
      });
    }

    if (currEntry.bounceCount > prevEntry.bounceCount && currEntry.bounceCount >= config.test.maxBounces) {
      diff.bounceThresholdHit.push({
        taskId: id,
        name: currEntry.name,
        bounceCount: currEntry.bounceCount,
        maxBounces: config.test.maxBounces,
      });
    }

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

  const summaryLines: string[] = [];
  for (const t of diff.transitions) {
    summaryLines.push(`  \u2022 ${t.name}: ${t.from} \u2192 ${t.to}`);
  }
  for (const t of diff.newTasks) {
    summaryLines.push(`  \u2022 ${t.name}: created in ${t.state}`);
  }
  for (const t of diff.removedTasks) {
    summaryLines.push(`  \u2022 ${t.taskId}: removed (was ${t.lastState})`);
  }
  for (const v of diff.versionBumps) {
    summaryLines.push(`  \u2022 ${v.name}: v${v.from} \u2192 v${v.to}`);
  }
  for (const r of diff.resolvedBlocks) {
    summaryLines.push(`  \u2022 ${r.taskId}: unblocked \u2192 ${r.toState}`);
  }

  if (summaryLines.length > 0) {
    lines.push(`**Summary:**`);
    lines.push(...summaryLines);
    lines.push('');
  }

  const issueLines: string[] = [];
  for (const b of diff.newlyBlocked) {
    issueLines.push(`  \u26a0 ${b.name} (${b.taskId}): BLOCKED`);
    issueLines.push(`     Was in: ${b.previousState}`);
    if (b.blockedReason) issueLines.push(`     Reason: ${b.blockedReason}`);
    if (b.questions.length > 0) {
      issueLines.push(`     Questions: ${b.questions.length} unanswered`);
      for (const q of b.questions) {
        issueLines.push(`       [${q.category}] ${q.question}`);
      }
    }
    issueLines.push(`     \u2192 npx taskflow resolve-blocked ${b.taskId}`);
  }

  for (const b of diff.bounceThresholdHit) {
    issueLines.push(`  \u26a0 ${b.name} (${b.taskId}): bounced ${b.bounceCount}/${b.maxBounces} times`);
    issueLines.push(`     \u2192 npx taskflow resolve-blocked ${b.taskId}`);
  }

  for (const s of diff.staleLocks) {
    issueLines.push(`  \u26a0 ${s.taskId}: stale lock (session: ${s.sessionId}, ${s.elapsedSeconds}s since heartbeat)`);
    issueLines.push(`     \u2192 npx taskflow unlock ${s.taskId}`);
  }

  if (issueLines.length > 0) {
    lines.push(`**Issues:**`);
    lines.push(...issueLines);
    lines.push('');
  }

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
