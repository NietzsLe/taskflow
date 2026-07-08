import { TaskYaml, TaskState, LockFile, TestResults, TestFlow, PendingQuestion, Bug, VersionSnapshot } from './types';

export class ValidationError extends Error {
  constructor(message: string, public fieldPath?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, field: string, opts: { required?: boolean; default?: string } = {}): string {
  if (v === undefined || v === null) {
    if (opts.required) throw new ValidationError(`Missing required field '${field}'`, field);
    return opts.default ?? '';
  }
  if (typeof v !== 'string') throw new ValidationError(`Field '${field}' must be a string, got ${typeof v}`, field);
  return v;
}

function asNumber(v: unknown, field: string, opts: { required?: boolean; default?: number } = {}): number {
  if (v === undefined || v === null) {
    if (opts.required) throw new ValidationError(`Missing required field '${field}'`, field);
    return opts.default ?? 0;
  }
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  throw new ValidationError(`Field '${field}' must be a number, got ${typeof v}`, field);
}

function asOptionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ValidationError(`Field '${field}' must be a string if present`, field);
  return v;
}

function asOptionalNumber(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  throw new ValidationError(`Field '${field}' must be a number if present`, field);
}

function asTestFlow(v: unknown, field: string, index: number): TestFlow {
  if (!isObject(v)) throw new ValidationError(`${field}[${index}] must be an object`, `${field}[${index}]`);
  const name = asString(v.name, `${field}[${index}].name`, { required: true });
  const environment = asOptionalString(v.environment, `${field}[${index}].environment`);
  const steps = asString(v.steps, `${field}[${index}].steps`, { required: true });
  const flow: TestFlow = { name, steps };
  if (environment !== undefined) flow.environment = environment;
  return flow;
}

function asTestResults(v: unknown, field: string): TestResults {
  if (!isObject(v)) {
    // coerce to default if missing
    return { lastRun: null, flows: {}, passRatio: 0 };
  }
  const flows: Record<string, { pass: boolean; lastRun: string | null }> = {};
  const rawFlows = isObject(v.flows) ? v.flows : {};
  for (const [key, val] of Object.entries(rawFlows)) {
    if (!isObject(val)) {
      flows[key] = { pass: false, lastRun: null };
      continue;
    }
    flows[key] = {
      pass: val.pass === true,
      lastRun: typeof val.lastRun === 'string' ? val.lastRun : null,
    };
  }
  return {
    lastRun: typeof v.lastRun === 'string' ? v.lastRun : null,
    flows,
    passRatio: asNumber(v.passRatio, `${field}.passRatio`, { default: 0 }),
  };
}

function asBug(v: unknown, field: string, index: number): Bug {
  if (!isObject(v)) throw new ValidationError(`${field}[${index}] must be an object`, `${field}[${index}]`);
  return {
    flow: asString(v.flow, `${field}[${index}].flow`, { required: true }),
    description: asString(v.description, `${field}[${index}].description`, { required: true }),
    foundAt: asString(v.foundAt, `${field}[${index}].foundAt`, { required: true }),
  };
}

function asPendingQuestion(v: unknown, field: string, index: number): PendingQuestion {
  if (!isObject(v)) throw new ValidationError(`${field}[${index}] must be an object`, `${field}[${index}]`);
  return {
    id: asString(v.id, `${field}[${index}].id`, { required: true }),
    askedAt: asString(v.askedAt, `${field}[${index}].askedAt`, { required: true }),
    askedBy: asString(v.askedBy, `${field}[${index}].askedBy`, { required: true }),
    category: asString(v.category, `${field}[${index}].category`, { required: true }),
    question: asString(v.question, `${field}[${index}].question`, { required: true }),
    context: asOptionalString(v.context, `${field}[${index}].context`),
    answered: v.answered === true,
    answer: asOptionalString(v.answer, `${field}[${index}].answer`),
    answeredAt: asOptionalString(v.answeredAt, `${field}[${index}].answeredAt`),
  };
}

function asVersionSnapshot(v: unknown, field: string, key: string): VersionSnapshot {
  if (!isObject(v)) throw new ValidationError(`${field}.${key} must be an object`, `${field}.${key}`);
  const snap: VersionSnapshot = {
    updatedAt: asString(v.updatedAt, `${field}.${key}.updatedAt`, { required: true }),
    description: asString(v.description, `${field}.${key}.description`, { required: true }),
  };
  if (v.implementationNotes !== undefined) snap.implementationNotes = asOptionalString(v.implementationNotes, `${field}.${key}.implementationNotes`);
  if (Array.isArray(v.testFlows)) {
    snap.testFlows = v.testFlows.map((f, i) => asTestFlow(f, `${field}.${key}.testFlows`, i));
  }
  return snap;
}

const VALID_TASK_STATES: TaskState[] = ['defined', 'pending', 'processing', 'testing', 'review', 'done', 'blocked'];

function asTaskState(v: unknown, field: string): TaskState | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ValidationError(`Field '${field}' must be a string`, field);
  if (!VALID_TASK_STATES.includes(v as TaskState)) throw new ValidationError(`Field '${field}' must be one of: ${VALID_TASK_STATES.join(', ')}, got '${v}'`, field);
  return v as TaskState;
}

/**
 * Validate and coerce a parsed YAML object into a well-typed TaskYaml.
 * Throws ValidationError on missing/invalid required fields.
 */
export function validateTaskYaml(raw: unknown): TaskYaml {
  if (!isObject(raw)) throw new ValidationError('Task YAML must be an object');

  const task: TaskYaml = {
    id: asString(raw.id, 'id', { required: true }),
    name: asString(raw.name, 'name', { required: true }),
    createdAt: asString(raw.createdAt, 'createdAt', { required: true }),
    updatedAt: asString(raw.updatedAt, 'updatedAt', { required: true }),
    version: asNumber(raw.version, 'version', { required: true, default: 1 }),
    description: asString(raw.description, 'description', { default: '' }),
  };

  if (raw.implementationNotes !== undefined) {
    task.implementationNotes = asOptionalString(raw.implementationNotes, 'implementationNotes');
  }

  if (Array.isArray(raw.testFlows)) {
    task.testFlows = raw.testFlows.map((f, i) => asTestFlow(f, 'testFlows', i));
  }

  // testResults is coerced to default if missing or invalid
  task.testResults = asTestResults(raw.testResults, 'testResults');

  if (raw.versions !== undefined && isObject(raw.versions)) {
    const versions: Record<string, VersionSnapshot> = {};
    for (const [key, val] of Object.entries(raw.versions)) {
      versions[key] = asVersionSnapshot(val, 'versions', key);
    }
    task.versions = versions;
  }

  if (Array.isArray(raw.bugs)) {
    task.bugs = raw.bugs.map((b, i) => asBug(b, 'bugs', i));
  }

  if (raw.blockedReason !== undefined) {
    task.blockedReason = asOptionalString(raw.blockedReason, 'blockedReason');
  }

  if (raw.previousState !== undefined) {
    task.previousState = asTaskState(raw.previousState, 'previousState');
  }

  if (Array.isArray(raw.pendingQuestions)) {
    task.pendingQuestions = raw.pendingQuestions.map((q, i) => asPendingQuestion(q, 'pendingQuestions', i));
  }

  return task;
}

/**
 * Validate and coerce a parsed YAML object into a well-typed LockFile.
 * Returns null if the input is not a valid lock (e.g. corrupted or missing required fields).
 */
export function validateLockFile(raw: unknown): LockFile | null {
  if (!isObject(raw)) return null;
  try {
    const sessionId = asString(raw.sessionId, 'sessionId', { required: true });
    if (!sessionId) return null;
    const acquiredAt = asString(raw.acquiredAt, 'acquiredAt', { required: true });
    const heartbeatAt = asString(raw.heartbeatAt, 'heartbeatAt', { required: true });
    const lock: LockFile = {
      sessionId,
      acquiredAt,
      heartbeatAt,
    };
    if (raw.agentType === 'executor' || raw.agentType === 'tester') {
      lock.agentType = raw.agentType;
    }
    if (raw.taskVersion !== undefined) {
      lock.taskVersion = asOptionalNumber(raw.taskVersion, 'taskVersion');
    }
    return lock;
  } catch {
    return null;
  }
}