import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTaskFilePath } from '../core/state';
import { validateTaskYaml } from '../core/validate';
import { TaskYaml } from '../core/types';

/**
 * Export a task to JSON or YAML on stdout.
 */
export function exportTask(taskDir: string, taskId: string, format: 'json' | 'yaml'): void {
  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) {
    console.error(`Task '${taskId}' not found.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));
  if (format === 'json') {
    console.log(JSON.stringify(task, null, 2));
  } else {
    console.log(stringifyYaml(task));
  }
}