import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { getTaskFilePath } from '../core/state';
import { validateTaskYaml } from '../core/validate';
import { TaskYaml, VersionSnapshot } from '../core/types';

/**
 * Show a diff between two versions of a task (or current vs latest snapshot).
 * Usage: diff <id> [v1] [v2]  — if no args, compare current vs latest snapshot.
 */
export function diffTask(taskDir: string, taskId: string, v1?: string, v2?: string): void {
  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) {
    console.error(`Task '${taskId}' not found.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));
  if (!task.versions || Object.keys(task.versions).length === 0) {
    console.log(`Task '${taskId}' has no version snapshots.`);
    return;
  }

  const versionKeys = Object.keys(task.versions).sort();
  const currentVersion = `v${task.version}`;

  let left: { label: string; snap: VersionSnapshot | TaskYaml };
  let right: { label: string; snap: VersionSnapshot | TaskYaml };

  if (v1 && v2) {
    const l = task.versions[v1];
    const r = task.versions[v2];
    if (!l) { console.error(`Version '${v1}' not found. Available: ${versionKeys.join(', ')}`); process.exit(1); }
    if (!r) { console.error(`Version '${v2}' not found. Available: ${versionKeys.join(', ')}`); process.exit(1); }
    left = { label: v1, snap: l };
    right = { label: v2, snap: r };
  } else if (v1) {
    const l = task.versions[v1];
    if (!l) { console.error(`Version '${v1}' not found. Available: ${versionKeys.join(', ')}`); process.exit(1); }
    left = { label: v1, snap: l };
    right = { label: `current (${currentVersion})`, snap: task };
  } else {
    // compare latest snapshot vs current
    const latestSnap = versionKeys[versionKeys.length - 1];
    const l = task.versions[latestSnap];
    left = { label: latestSnap, snap: l };
    right = { label: `current (${currentVersion})`, snap: task };
  }

  console.log(`Diff: ${left.label} → ${right.label}\n`);

  // Compare description
  const descL = left.snap.description || '';
  const descR = right.snap.description || '';
  if (descL !== descR) {
    console.log('--- description ---');
    console.log(`< ${descL.split('\n').join('\n< ')}`);
    console.log(`> ${descR.split('\n').join('\n> ')}`);
    console.log('');
  }

  // Compare implementationNotes
  const inL = (left.snap as any).implementationNotes || '';
  const inR = (right.snap as any).implementationNotes || '';
  if (inL !== inR) {
    console.log('--- implementationNotes ---');
    console.log(`< ${inL.split('\n').join('\n< ')}`);
    console.log(`> ${inR.split('\n').join('\n> ')}`);
    console.log('');
  }

  // Compare testFlows
  const tfL = (left.snap as any).testFlows || [];
  const tfR = (right.snap as any).testFlows || [];
  if (JSON.stringify(tfL) !== JSON.stringify(tfR)) {
    console.log('--- testFlows ---');
    console.log(`< ${JSON.stringify(tfL, null, 2).split('\n').join('\n< ')}`);
    console.log(`> ${JSON.stringify(tfR, null, 2).split('\n').join('\n> ')}`);
    console.log('');
  }

  // If nothing changed
  if (descL === descR && inL === inR && JSON.stringify(tfL) === JSON.stringify(tfR)) {
    console.log('(no differences)');
  }
}