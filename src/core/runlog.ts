import * as fs from 'fs';
import * as path from 'path';
import { RunLogEntry } from './types';
import { loadConfig } from './config';

export function getRunsDir(taskDir: string): string {
  return path.join(taskDir, 'runs');
}

export function getSessionsDir(taskDir: string): string {
  return path.join(getRunsDir(taskDir), 'sessions');
}

export function getTasksLogDir(taskDir: string): string {
  return path.join(getRunsDir(taskDir), 'tasks');
}

export function getReleaserLogPath(taskDir: string): string {
  return path.join(getRunsDir(taskDir), 'releaser-log.md');
}

export function getNotifierLogPath(taskDir: string): string {
  return path.join(getRunsDir(taskDir), 'notifier-log.md');
}

export function getGlobalSeqPath(taskDir: string): string {
  return path.join(getRunsDir(taskDir), '.seq');
}

export function getSessionLogPath(taskDir: string, sessionId: string): string {
  return path.join(getSessionsDir(taskDir), `${sessionId}.md`);
}

export function getTaskLogPath(taskDir: string, taskId: string): string {
  return path.join(getTasksLogDir(taskDir), `${taskId}.md`);
}

function getNextRunSeq(taskDir: string): number {
  const seqPath = getGlobalSeqPath(taskDir);
  if (!fs.existsSync(seqPath)) return 1;
  try {
    const content = fs.readFileSync(seqPath, 'utf-8').trim();
    return parseInt(content, 10) + 1;
  } catch {
    return 1;
  }
}

function writeSeq(taskDir: string, seq: number): void {
  const seqPath = getGlobalSeqPath(taskDir);
  fs.writeFileSync(seqPath, seq.toString(), 'utf-8');
}

function ensureDirs(taskDir: string): void {
  const runsDir = getRunsDir(taskDir);
  if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
  const sessionsDir = getSessionsDir(taskDir);
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
  const tasksDir = getTasksLogDir(taskDir);
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });
}

function formatEntryMarkdown(entry: RunLogEntry): string {
  let md = `### ${entry.timestamp} — ${entry.action}\n`;
  md += `- **Run ID:** ${entry.runId}\n`;
  md += `- **Agent:** ${entry.agentType}\n`;
  md += `- **Session:** ${entry.sessionId}\n`;
  md += `- **Task:** ${entry.taskId} (v${entry.taskVersion}, ${entry.taskState})\n`;
  md += `- **Result:** ${entry.result}\n`;
  md += `- **Duration:** ${entry.duration}s\n`;
  if (entry.summary) {
    md += `\n**Summary:** ${entry.summary}\n`;
  }
  if (entry.error) {
    md += `\n**Error:** ${entry.error}\n`;
  }
  if (entry.details) {
    md += `\n**Details:**\n${entry.details}\n`;
  }
  md += `\n`;
  return md;
}

function trimFile(filePath: string, maxLines: number): void {
  if (maxLines <= 0) return;
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  if (lines.length > maxLines) {
    const trimmed = lines.slice(-maxLines).join('\n');
    fs.writeFileSync(filePath, trimmed, 'utf-8');
  }
}

function trimSessionFiles(taskDir: string, maxFiles: number): void {
  if (maxFiles <= 0) return;
  const sessionsDir = getSessionsDir(taskDir);
  if (!fs.existsSync(sessionsDir)) return;
  let files: { name: string; mtime: number }[];
  try {
    files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(sessionsDir, f)).mtimeMs;
        } catch {
          // file may have been deleted concurrently — treat as old so it gets pruned
          mtime = 0;
        }
        return { name: f, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return; // directory may have been deleted
  }
  if (files.length > maxFiles) {
    for (const f of files.slice(maxFiles)) {
      try {
        fs.unlinkSync(path.join(sessionsDir, f.name));
      } catch {
        // already gone
      }
    }
  }
}

export function appendRunLog(
  taskDir: string,
  entry: Omit<RunLogEntry, 'runId'>
): RunLogEntry | null {
  const config = loadConfig(taskDir);
  if (!config.runLog.enabled) return null;

  ensureDirs(taskDir);

  const seq = getNextRunSeq(taskDir);
  const now = new Date();
  const y = now.getUTCFullYear().toString();
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  const runId = `run_${y}${m}${d}_${seq.toString().padStart(3, '0')}`;

  const fullEntry: RunLogEntry = { ...entry, runId };

  const mdContent = formatEntryMarkdown(fullEntry);

  const sessionPath = getSessionLogPath(taskDir, entry.sessionId);
  fs.appendFileSync(sessionPath, mdContent, 'utf-8');
  trimFile(sessionPath, config.runLog.maxSessionLogLines);
  trimSessionFiles(taskDir, config.runLog.maxSessionFiles);

  const taskLogPath = getTaskLogPath(taskDir, entry.taskId);
  fs.appendFileSync(taskLogPath, mdContent, 'utf-8');
  trimFile(taskLogPath, config.runLog.maxTaskLogLines);

  writeSeq(taskDir, seq);

  return fullEntry;
}

export function appendReleaserLog(taskDir: string, message: string): void {
  const config = loadConfig(taskDir);
  if (!config.runLog.enabled) return;
  const maxLines = config.runLog.maxReleaserLogLines;

  ensureDirs(taskDir);

  const logPath = getReleaserLogPath(taskDir);
  const now = new Date().toISOString();
  const entry = `\n## ${now}\n${message}\n`;
  fs.appendFileSync(logPath, entry, 'utf-8');
  trimFile(logPath, maxLines);
}

export function appendNotifierLog(taskDir: string, message: string): void {
  const config = loadConfig(taskDir);
  if (!config.runLog.enabled) return;
  const maxLines = 100; // notifier log uses a fixed 100-line trim

  ensureDirs(taskDir);

  const logPath = getNotifierLogPath(taskDir);
  const now = new Date().toISOString();
  const entry = `\n## ${now}\n${message}\n`;
  fs.appendFileSync(logPath, entry, 'utf-8');
  trimFile(logPath, maxLines);
}

export function readSessionLog(taskDir: string, sessionId: string): string {
  const sessionPath = getSessionLogPath(taskDir, sessionId);
  if (!fs.existsSync(sessionPath)) return '';
  return fs.readFileSync(sessionPath, 'utf-8');
}

export function readTaskLog(taskDir: string, taskId: string): string {
  const taskLogPath = getTaskLogPath(taskDir, taskId);
  if (!fs.existsSync(taskLogPath)) return '';
  return fs.readFileSync(taskLogPath, 'utf-8');
}

export function readAllSessionLogs(taskDir: string, agentFilter?: string): string {
  const sessionsDir = getSessionsDir(taskDir);
  if (!fs.existsSync(sessionsDir)) return '';
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.md'));
  let result = '';
  for (const f of files) {
    if (agentFilter) {
      const content = fs.readFileSync(path.join(sessionsDir, f), 'utf-8');
      if (!content.includes(`**Agent:** ${agentFilter}`)) continue;
      result += content;
    } else {
      result += fs.readFileSync(path.join(sessionsDir, f), 'utf-8');
    }
  }
  return result;
}

export function listSessionFiles(taskDir: string): { name: string; mtime: number }[] {
  const sessionsDir = getSessionsDir(taskDir);
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}