import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { ensureStateDirs, getNextSeq } from '../core/state';
import { stringify as stringifyYaml } from 'yaml';
import { validateTaskYaml, ValidationError } from '../core/validate';
import { TaskYaml } from '../core/types';
import { appendRunLog } from '../core/runlog';

/**
 * Import a task from a JSON or YAML file into .tasks/defined/.
 * Re-assigns id and timestamps to avoid collisions.
 */
export function importTask(taskDir: string, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    console.error(`File '${filePath}' not found.`);
    process.exit(1);
  }
  ensureStateDirs(taskDir);

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  if (filePath.endsWith('.json')) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('Invalid JSON.');
      process.exit(1);
    }
  } else {
    try {
      parsed = parseYaml(raw);
    } catch {
      console.error('Invalid YAML.');
      process.exit(1);
    }
  }

  let task: TaskYaml;
  try {
    task = validateTaskYaml(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error(`Task validation failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Re-assign id, timestamps, version
  const now = new Date();
  const datePrefix = now.toISOString().slice(0, 10);
  const seq = getNextSeq(taskDir, datePrefix);
  const slug = (task.name || 'imported').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const newId = `${datePrefix}_${slug}_${seq.toString().padStart(3, '0')}`;
  const filename = `${newId}.yaml`;

  task.id = newId;
  task.createdAt = now.toISOString();
  task.updatedAt = now.toISOString();
  task.version = 1;
  // Reset testResults
  task.testResults = { lastRun: null, flows: {}, passRatio: 0 };
  // Remove blocked/blocked context
  delete task.blockedReason;
  delete task.previousState;
  delete task.pendingQuestions;
  delete task.bugs;

  const destPath = path.join(taskDir, 'defined', filename);
  fs.writeFileSync(destPath, stringifyYaml(task), 'utf-8');

  appendRunLog(taskDir, {
    timestamp: now.toISOString(),
    agentType: 'user',
    sessionId: 'cli',
    agentName: null,
    taskId: newId,
    taskVersion: 1,
    taskState: 'defined',
    action: 'import',
    description: `User imported task from ${filePath} as '${newId}'`,
    summary: `Imported task '${task.name}' from ${path.basename(filePath)}.`,
    result: 'success',
    duration: 0,
    error: null,
    details: null,
  });

  console.log(`Task imported: .tasks/defined/${filename}`);
  console.log(`ID: ${newId}`);
  console.log(`Next: npx taskflow edit ${newId} -d "..." then npx taskflow move ${newId} pending`);
}