import * as fs from 'fs';
import * as path from 'path';
import { stringify as stringifyYaml, parse as parseYaml, parseAllDocuments } from 'yaml';
import { RunLogEntry } from './types';
import { loadConfig } from './config';

export function getRunsDir(taskDir: string): string {
  return path.join(taskDir, 'runs');
}

export function getDailyLogPath(taskDir: string, date: Date): string {
  const y = date.getUTCFullYear().toString();
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return path.join(getRunsDir(taskDir), `${y}-${m}-${d}.yaml`);
}

export function getReleaserLogPath(taskDir: string): string {
  return path.join(getRunsDir(taskDir), 'releaser-log.md');
}

export function getSeqFilePath(taskDir: string, date: Date): string {
  const y = date.getUTCFullYear().toString();
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return path.join(getRunsDir(taskDir), `${y}-${m}-${d}.seq`);
}

export function getNextRunSeq(taskDir: string, date: Date): number {
  const seqPath = getSeqFilePath(taskDir, date);
  if (!fs.existsSync(seqPath)) return 1;
  try {
    const content = fs.readFileSync(seqPath, 'utf-8').trim();
    return parseInt(content, 10) + 1;
  } catch {
    return 1;
  }
}

function writeSeq(taskDir: string, date: Date, seq: number): void {
  const seqPath = getSeqFilePath(taskDir, date);
  fs.writeFileSync(seqPath, seq.toString(), 'utf-8');
}

export function appendRunLog(
  taskDir: string,
  entry: Omit<RunLogEntry, 'runId'>
): RunLogEntry | null {
  const config = loadConfig(taskDir);
  if (!config.runLog.enabled) return null;

  const now = new Date();
  const seq = getNextRunSeq(taskDir, now);
  const y = now.getUTCFullYear().toString();
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  const runId = `run_${y}${m}${d}_${seq.toString().padStart(3, '0')}`;

  const fullEntry: RunLogEntry = { ...entry, runId };

  const logPath = getDailyLogPath(taskDir, now);
  const runsDir = getRunsDir(taskDir);
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }

  const yamlContent = `\n---\n${stringifyYaml(fullEntry)}`;
  fs.appendFileSync(logPath, yamlContent, 'utf-8');
  writeSeq(taskDir, now, seq);

  return fullEntry;
}

export function appendReleaserLog(taskDir: string, message: string): void {
  const config = loadConfig(taskDir);
  if (!config.runLog.enabled) return;
  const maxLines = config.runLog.maxReleaserLogLines;

  const logPath = getReleaserLogPath(taskDir);
  const runsDir = getRunsDir(taskDir);
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }

  const now = new Date().toISOString();
  const entry = `\n## ${now}\n${message}\n`;
  fs.appendFileSync(logPath, entry, 'utf-8');

  if (maxLines > 0) {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      const trimmed = lines.slice(-maxLines).join('\n');
      fs.writeFileSync(logPath, trimmed, 'utf-8');
    }
  }
}

export function readRunLog(taskDir: string, date?: Date): RunLogEntry[] {
  const logDate = date || new Date();
  const logPath = getDailyLogPath(taskDir, logDate);
  if (!fs.existsSync(logPath)) return [];

  const content = fs.readFileSync(logPath, 'utf-8');
  const docs = parseAllDocuments(content);
  const entries: RunLogEntry[] = [];
  for (const doc of docs) {
    try {
      const entry = doc.toJS() as RunLogEntry;
      if (entry && entry.runId) entries.push(entry);
    } catch {
      // Skip malformed entries
    }
  }
  return entries;
}