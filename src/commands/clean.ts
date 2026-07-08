import * as fs from 'fs';
import * as path from 'path';
import { listTasks } from '../core/state';

/**
 * Move done tasks older than --before to .tasks/archive/.
 * --dry-run only lists them.
 */
export function cleanDone(taskDir: string, options: { before?: string; dryRun?: boolean }): void {
  const beforeDate = options.before ? new Date(options.before) : new Date(0);
  if (options.before && Number.isNaN(beforeDate.getTime())) {
    console.error(`Invalid --before date: '${options.before}'. Use ISO format, e.g. 2026-01-01.`);
    process.exit(1);
  }

  const archiveDir = path.join(taskDir, 'archive');
  const doneTasks = listTasks(taskDir, 'done');
  const toArchive: { id: string; filename: string; updatedAt: string }[] = [];

  for (const t of doneTasks) {
    const filePath = path.join(taskDir, 'done', t.filename);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { parse: parseYaml } = require('yaml');
      const task = parseYaml(raw);
      const updatedAt = new Date(task.updatedAt || task.createdAt || 0);
      if (updatedAt < beforeDate) {
        toArchive.push({ id: t.id, filename: t.filename, updatedAt: updatedAt.toISOString() });
      }
    } catch {
      // skip unreadable
    }
  }

  if (toArchive.length === 0) {
    console.log('No done tasks match the criteria.');
    return;
  }

  if (options.dryRun) {
    console.log(`Would archive ${toArchive.length} task(s):\n`);
    for (const t of toArchive) {
      console.log(`  ${t.id} (updated: ${t.updatedAt})`);
    }
    return;
  }

  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  let archived = 0;
  for (const t of toArchive) {
    const src = path.join(taskDir, 'done', t.filename);
    const dest = path.join(archiveDir, t.filename);
    try {
      fs.renameSync(src, dest);
      archived++;
    } catch (err: any) {
      if (err.code === 'EXDEV') {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
        archived++;
      } else {
        console.error(`Failed to archive '${t.id}': ${err.message}`);
      }
    }
  }
  console.log(`Archived ${archived} task(s) to .tasks/archive/.`);
}