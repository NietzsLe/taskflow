export interface TaskGitFlow {
  worktreePath?: string;        // .worktrees/<task-id>
  branchName?: string;          // taskflow/<task-id>
  mergeCommit?: string;         // SHA of the merge commit on base branch
  baseBranchAtMerge?: string;   // SHA of base branch at merge time
}

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
  previousState?: TaskState;
  pendingQuestions?: PendingQuestion[];
  gitFlow?: TaskGitFlow;
  // Execution status — updated by executor/tester agents on every heartbeat
  statusDescription?: string;       // Current working status (e.g. "Building Docker image, step 3/5")
  lastAgentSummary?: string;        // Natural language summary of last agent action
  lastAgentType?: 'executor' | 'tester';  // Which agent type last touched this task
  lastAgentAction?: string;         // Last action performed (pickup, implement-start, test-flow-pass, etc.)
  lastAgentActionAt?: string;       // When the last action was performed
  attemptCount?: number;            // How many times this task has been attempted (for retry detection)
  bounceCount?: number;             // How many times task bounced testing → pending (auto-block at maxBounces)
  previousBugs?: Bug[];             // Snapshot of bugs from previous test cycle (for same-bugs detector)
}

export interface PendingQuestion {
  id: string;
  askedAt: string;
  askedBy: string;
  category: string;
  question: string;
  context?: string;
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
  bounceCount?: number;
  changeDescription?: string;
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
  agentType: 'executor' | 'tester' | 'user' | 'lock-releaser' | 'notifier';
  sessionId: string;
  agentName: string | null;
  taskId: string;
  taskVersion: number;
  taskState: string;
  fromState?: string;
  toState?: string;
  action: string;
  description: string;
  summary?: string;
  result: 'success' | 'failure' | 'stale' | 'skipped';
  duration: number;
  error: string | null;
  details: string | null;
}

export type TaskState = 'defined' | 'pending' | 'processing' | 'testing' | 'review' | 'done' | 'blocked';

export const VALID_STATES: TaskState[] = ['defined', 'pending', 'processing', 'testing', 'review', 'done', 'blocked'];

export const VALID_AGENTS = ['executor', 'tester', 'user', 'lock-releaser', 'notifier'] as const;
export type AgentType = typeof VALID_AGENTS[number];

export interface TaskSnapshotEntry {
  id: string;
  name: string;
  state: TaskState;
  version: number;
  bounceCount: number;
  attemptCount: number;
  blockedReason?: string;
  pendingQuestionCount: number;
  pendingQuestions?: PendingQuestion[];
  lockedBy?: string;
  lockStale: boolean;
  updatedAt: string;
}

export interface NotifierSnapshot {
  takenAt: string;
  tasks: Record<string, TaskSnapshotEntry>;
}

export interface NotifierDiff {
  transitions: { taskId: string; name: string; from: TaskState; to: TaskState }[];
  newTasks: { taskId: string; name: string; state: TaskState }[];
  removedTasks: { taskId: string; lastState: TaskState }[];
  newlyBlocked: { taskId: string; name: string; questions: PendingQuestion[]; previousState: TaskState; blockedReason?: string }[];
  bounceThresholdHit: { taskId: string; name: string; bounceCount: number; maxBounces: number }[];
  staleLocks: { taskId: string; sessionId: string; elapsedSeconds: number }[];
  versionBumps: { taskId: string; name: string; from: number; to: number }[];
  resolvedBlocks: { taskId: string; toState: TaskState }[];
}