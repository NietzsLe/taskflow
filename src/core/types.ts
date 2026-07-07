import { v4 as uuidv4 } from 'uuid';

export interface TaskYaml {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  description: string;
  implementationNotes?: string;
  testFlows?: TestFlow[];
  testResults?: TestResults;
  versions?: Record<string, VersionSnapshot>;
  bugs?: Bug[];
  blockedReason?: string;
  pendingQuestions?: PendingQuestion[];
}

export interface PendingQuestion {
  id: string;
  askedAt: string;
  askedBy: string;
  question: string;
  answered: boolean;
  answer?: string;
  answeredAt?: string;
}

export interface TestFlow {
  name: string;
  environment?: string;
  steps: string;
}

export interface TestResults {
  lastRun: string | null;
  flows: Record<string, { pass: boolean; lastRun: string | null }>;
  passRatio: number;
}

export interface VersionSnapshot {
  updatedAt: string;
  description: string;
  implementationNotes?: string;
  testFlows?: TestFlow[];
}

export interface Bug {
  flow: string;
  description: string;
  foundAt: string;
}

export interface LockFile {
  sessionId: string;
  agentType?: 'executor' | 'tester';
  taskVersion?: number;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface RunLogEntry {
  runId: string;
  timestamp: string;
  agentType: 'executor' | 'tester' | 'user' | 'lock-releaser';
  sessionId: string;
  agentName: string | null;
  taskId: string;
  taskVersion: number;
  taskState: string;
  action: string;
  description: string;
  summary?: string;
  result: 'success' | 'failure' | 'stale' | 'skipped';
  duration: number;
  error: string | null;
  details: string | null;
}

export type TaskState = 'defined' | 'pending' | 'processing' | 'testing' | 'review' | 'done';

export function generateSessionId(): string {
  return uuidv4();
}