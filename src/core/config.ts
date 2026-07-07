import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface TaskFlowConfig {
  system: {
    name: string;
    version: string;
    projectRoot: string;
    taskDir: string;
  };
  heartbeat: {
    intervalSeconds: number;
    jitterSeconds: number;
    staleThresholdSeconds: number;
    lockReleaserIntervalSeconds: number;
  };
  lock: {
    acquireMode: string;
    releaseMode: string;
  };
  test: {
    passRatioRequired: number;
    maxRetriesPerFlow: number;
    infraLockRequired: boolean;
    skipPassedFlows: boolean;
    warnNoBrowserMCP: boolean;
  };
  browserMCP: BrowserMCPEntry[];
  infrastructure: {
    defaultEnvironment: string;
    environments: Record<string, EnvironmentConfig>;
    seed: SeedEntry[];
  };
  runLog: {
    enabled: boolean;
    filePerDay: boolean;
    maxReleaserLogLines: number;
  };
  executor: ExecutorConfig;
  tester: TesterConfig;
  user: {
    allowMoveFromPendingOnly: boolean;
    requireVersioningForActive: boolean;
  };
  notification: {
    enabled: boolean;
    channels: { type: string; enabled: boolean; path?: string }[];
    events: Record<string, boolean>;
  };
}

export interface CustomSkill {
  name: string;
  path: string;
  description?: string;
}

export interface CustomTool {
  name: string;
  type: string;
  command?: string[];
  description?: string;
}

export interface ExecutorConfig {
  maxPickupAttempts: number;
  pickupRetryDelaySeconds: number;
  customInstructions?: string;
  customSkills?: CustomSkill[];
  customTools?: CustomTool[];
}

export interface TesterConfig {
  infraLockRequired: boolean;
  warnNoBrowserMCP: boolean;
  skipPassedFlows: boolean;
  customInstructions?: string;
  customSkills?: CustomSkill[];
  customTools?: CustomTool[];
}

export interface BrowserMCPEntry {
  name: string;           // MCP tool name the agent has connected (e.g., "playwriter")
  available: boolean;     // Whether it is connected and ready for UI tests
  lastCheck: string | null; // Last time availability was verified
  description?: string;   // Optional description
}

export interface EnvironmentConfig {
  description: string;
  setupGuide: string;
  services: ServiceConfig[];
}

export interface ServiceConfig {
  name: string;
  description: string;
  type: 'docker' | 'process' | 'remote';
  check: {
    method: 'port' | 'http' | 'command';
    port?: number;
    host?: string;
    url?: string;
    expectedStatus?: number;
    timeoutSeconds?: number;
  };
  setup: {
    auto: boolean;
    command?: string;
    instruction?: string;
    timeoutSeconds?: number;
  };
  depends_on?: string[];
  required: boolean;
}

export interface SeedEntry {
  name: string;
  description: string;
  check: {
    method: 'api' | 'command';
    url?: string;
    expectedStatus?: number;
  };
  setup: {
    auto: boolean;
    command?: string;
    timeoutSeconds?: number;
  };
  required: boolean;
}

export function getDefaultConfig(): TaskFlowConfig {
  return {
    system: {
      name: 'TaskFlow',
      version: '1.0.0',
      projectRoot: '.',
      taskDir: '.tasks',
    },
    heartbeat: {
      intervalSeconds: 60,
      jitterSeconds: 5,
      staleThresholdSeconds: 120,
      lockReleaserIntervalSeconds: 60,
    },
    lock: {
      acquireMode: 'create-exclusive',
      releaseMode: 'delete-file',
    },
    test: {
      passRatioRequired: 1.0,
      maxRetriesPerFlow: 3,
      infraLockRequired: true,
      skipPassedFlows: true,
      warnNoBrowserMCP: true,
    },
    browserMCP: [
      {
        name: 'playwriter',
        available: false,
        lastCheck: null,
        description: 'Playwriter MCP — browser automation tool',
      },
    ],
    infrastructure: {
      defaultEnvironment: 'dev',
      environments: {},
      seed: [],
    },
    runLog: {
      enabled: true,
      filePerDay: true,
      maxReleaserLogLines: 100,
    },
    executor: {
      maxPickupAttempts: 5,
      pickupRetryDelaySeconds: 30,
      customInstructions: '',
      customSkills: [],
      customTools: [],
    },
    tester: {
      infraLockRequired: true,
      warnNoBrowserMCP: true,
      skipPassedFlows: true,
      customInstructions: '',
      customSkills: [],
      customTools: [],
    },
    user: {
      allowMoveFromPendingOnly: true,
      requireVersioningForActive: true,
    },
    notification: {
      enabled: true,
      channels: [
        { type: 'console', enabled: true },
        { type: 'file', enabled: true, path: '.tasks/notifications.log' },
      ],
      events: {
        taskBlocked: true,
        taskTestFailed: true,
        taskCompleted: true,
        staleLockReleased: true,
        versionChanged: true,
      },
    },
  };
}

function mergeArray<T>(def: T[], parsed: T[] | undefined | null): T[] {
  return parsed ?? def;
}

function mergeExecutorConfig(def: ExecutorConfig, parsed: Partial<ExecutorConfig> | undefined): ExecutorConfig {
  if (!parsed) return def;
  return {
    maxPickupAttempts: parsed.maxPickupAttempts ?? def.maxPickupAttempts,
    pickupRetryDelaySeconds: parsed.pickupRetryDelaySeconds ?? def.pickupRetryDelaySeconds,
    customInstructions: parsed.customInstructions ?? def.customInstructions,
    customSkills: mergeArray(def.customSkills || [], parsed.customSkills),
    customTools: mergeArray(def.customTools || [], parsed.customTools),
  };
}

function mergeTesterConfig(def: TesterConfig, parsed: Partial<TesterConfig> | undefined): TesterConfig {
  if (!parsed) return def;
  return {
    infraLockRequired: parsed.infraLockRequired ?? def.infraLockRequired,
    warnNoBrowserMCP: parsed.warnNoBrowserMCP ?? def.warnNoBrowserMCP,
    skipPassedFlows: parsed.skipPassedFlows ?? def.skipPassedFlows,
    customInstructions: parsed.customInstructions ?? def.customInstructions,
    customSkills: mergeArray(def.customSkills || [], parsed.customSkills),
    customTools: mergeArray(def.customTools || [], parsed.customTools),
  };
}

export function deepMergeConfig(defaults: TaskFlowConfig, parsed: Partial<TaskFlowConfig>): TaskFlowConfig {
  return {
    system: { ...defaults.system, ...parsed.system },
    heartbeat: { ...defaults.heartbeat, ...parsed.heartbeat },
    lock: { ...defaults.lock, ...parsed.lock },
    test: { ...defaults.test, ...parsed.test },
    browserMCP: mergeArray(defaults.browserMCP, parsed.browserMCP),
    infrastructure: {
      defaultEnvironment: parsed.infrastructure?.defaultEnvironment ?? defaults.infrastructure.defaultEnvironment,
      environments: { ...defaults.infrastructure.environments, ...parsed.infrastructure?.environments },
      seed: mergeArray(defaults.infrastructure.seed, parsed.infrastructure?.seed),
    },
    runLog: { ...defaults.runLog, ...parsed.runLog },
    executor: mergeExecutorConfig(defaults.executor, parsed.executor),
    tester: mergeTesterConfig(defaults.tester, parsed.tester),
    user: { ...defaults.user, ...parsed.user },
    notification: {
      enabled: parsed.notification?.enabled ?? defaults.notification.enabled,
      channels: mergeArray(defaults.notification.channels, parsed.notification?.channels),
      events: { ...defaults.notification.events, ...parsed.notification?.events },
    },
  };
}

export function loadConfig(taskDir: string): TaskFlowConfig {
  const configPath = path.join(taskDir, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return getDefaultConfig();
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw) as Partial<TaskFlowConfig>;
  const defaults = getDefaultConfig();
  return deepMergeConfig(defaults, parsed);
}