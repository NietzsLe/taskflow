import * as fs from 'fs';
import { parse as parseYaml } from 'yaml';
import { TaskYaml } from './types';
import { getTaskFilePath } from './state';

export function getTaskVersion(taskDir: string, taskId: string): number | null {
  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = parseYaml(raw) as TaskYaml;
  return task.version || null;
}

export function hasVersionChanged(taskDir: string, taskId: string, knownVersion: number): boolean {
  const currentVersion = getTaskVersion(taskDir, taskId);
  return currentVersion !== null && currentVersion !== knownVersion;
}