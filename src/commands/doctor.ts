import * as fs from 'fs';
import * as path from 'path';
import { ensureStateDirs, STATE_DIRS } from '../core/state';
import { TaskState, VALID_STATES } from '../core/types';
import { loadConfig } from '../core/config';

export interface DoctorResult {
  ok: boolean;
  checks: { name: string; status: 'ok' | 'fail' | 'warn'; message: string }[];
}

/**
 * Run health checks on the .tasks/ directory and configuration.
 * Returns a report; exit code 0 if all ok, 1 if any fail.
 */
export function runDoctor(taskDir: string): DoctorResult {
  const checks: DoctorResult['checks'] = [];

  // 1. State directories
  for (const state of STATE_DIRS) {
    const dirPath = path.join(taskDir, state);
    if (fs.existsSync(dirPath)) {
      checks.push({ name: `dir/${state}`, status: 'ok', message: `exists` });
    } else {
      checks.push({ name: `dir/${state}`, status: 'fail', message: `missing` });
    }
  }

  // 2. Locks dir
  const locksDir = path.join(taskDir, 'locks');
  checks.push({
    name: 'dir/locks',
    status: fs.existsSync(locksDir) ? 'ok' : 'fail',
    message: fs.existsSync(locksDir) ? 'exists' : 'missing',
  });

  // 3. Runs dir
  const runsDir = path.join(taskDir, 'runs');
  const sessionsDir = path.join(runsDir, 'sessions');
  const tasksLogDir = path.join(runsDir, 'tasks');
  for (const d of [runsDir, sessionsDir, tasksLogDir]) {
    const name = `dir/runs/${path.relative(runsDir, d) || '.'}`;
    checks.push({
      name,
      status: fs.existsSync(d) ? 'ok' : 'fail',
      message: fs.existsSync(d) ? 'exists' : 'missing',
    });
  }

  // 4. Config parseable
  try {
    const config = loadConfig(taskDir);
    checks.push({ name: 'config/parse', status: 'ok', message: 'config.yaml parsed successfully' });
    // 5. Config bound check
    if (config.heartbeat.staleThresholdSeconds < 10) {
      checks.push({ name: 'config/staleThreshold', status: 'warn', message: `staleThresholdSeconds=${config.heartbeat.staleThresholdSeconds} is very low (<10), locks may be reaped too aggressively` });
    } else {
      checks.push({ name: 'config/staleThreshold', status: 'ok', message: `staleThresholdSeconds=${config.heartbeat.staleThresholdSeconds}` });
    }
    if (config.test.passRatioRequired < 0 || config.test.passRatioRequired > 1) {
      checks.push({ name: 'config/passRatio', status: 'warn', message: `passRatioRequired=${config.test.passRatioRequired} out of [0,1]` });
    } else {
      checks.push({ name: 'config/passRatio', status: 'ok', message: `passRatioRequired=${config.test.passRatioRequired}` });
    }
  } catch (err: any) {
    checks.push({ name: 'config/parse', status: 'fail', message: `config.yaml parse error: ${err.message}` });
  }

  // 6. Orphan locks (lock exists but task not in processing/testing)
  if (fs.existsSync(locksDir)) {
    const lockFiles = fs.readdirSync(locksDir).filter(f => f.startsWith('task-') && f.endsWith('.lock'));
    for (const lf of lockFiles) {
      const taskId = lf.replace(/^task-/, '').replace(/\.lock$/, '');
      const state = STATE_DIRS.find(s => fs.existsSync(path.join(taskDir, s, `${taskId}.yaml`)));
      if (state && (state === 'processing' || state === 'testing')) {
        checks.push({ name: `lock/${taskId}`, status: 'ok', message: `locked, task in ${state}` });
      } else if (state) {
        checks.push({ name: `lock/${taskId}`, status: 'warn', message: `lock exists but task is in ${state} (not processing/testing) — possible orphan` });
      } else {
        checks.push({ name: `lock/${taskId}`, status: 'warn', message: `lock exists but task file not found — orphan lock` });
      }
    }
    // Infra lock
    const infraLock = path.join(locksDir, 'infra.lock');
    if (fs.existsSync(infraLock)) {
      checks.push({ name: 'lock/infra', status: 'ok', message: 'infra lock held' });
    }
  }

  // 7. Skills installed
  const skillsDir = path.join(process.cwd(), '.agents', 'skills');
  const expectedSkills = ['taskflow-init', 'taskflow-executor', 'taskflow-tester', 'taskflow-lock-releaser', 'taskflow-notifier', 'taskflow-user'];
  for (const skill of expectedSkills) {
    const skillFile = path.join(skillsDir, skill, 'SKILL.md');
    checks.push({
      name: `skill/${skill}`,
      status: fs.existsSync(skillFile) ? 'ok' : 'warn',
      message: fs.existsSync(skillFile) ? 'installed' : 'not installed (run: npx taskflow init)',
    });
  }

  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  return { ok: !hasFail, checks };
}