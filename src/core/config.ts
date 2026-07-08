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
    maxTaskLogLines: number;
    maxSessionLogLines: number;
    maxSessionFiles: number;
    maxReleaserLogLines: number;
  };
  executor: ExecutorConfig;
  tester: TesterConfig;
  user: {
    allowMoveFromStates: string[];
    requireVersioningForActive: boolean;
  };
  notification: {
    enabled: boolean;
    description: string;
    channels: NotificationChannel[];
    blockedCheckIntervalSeconds: number;
    messageTemplate: string;
  };
  gitFlow: GitFlowConfig;
}

export interface GitFlowConfig {
  enabled: boolean;              // default false — entire git flow is opt-in
  baseBranch: string;            // default "main" — the working branch tester tests on
  worktreeDir: string;           // default ".worktrees" — where worktrees are created
  branchPrefix: string;          // default "taskflow/" — prefix for feature branches
  autoCleanup: boolean;          // default true — remove worktree after task done
  commitConvention: 'conventional' | 'plain';  // default "conventional"
  mergeStrategy: 'merge' | 'rebase' | 'squash'; // default "merge"
}

export interface NotificationChannel {
  name?: string;           // optional label to distinguish multiple instances of the same type
  type: string;
  enabled: boolean;
  guide: string;
  description?: string;
  path?: string;
  url?: string;
  method?: string;
  format?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  from?: string;
  to?: string;
  timeoutSeconds?: number;  // G3: timeout for sending (default 10)
  retryCount?: number;      // G3: retries on failure (default 0)
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
    command?: string;
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
      maxTaskLogLines: 500,
      maxSessionLogLines: 500,
      maxSessionFiles: 50,
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
      allowMoveFromStates: ['defined', 'pending', 'blocked'],
      requireVersioningForActive: true,
    },
    notification: {
      enabled: true,
      description: 'Configure notification channels to alert users when tasks are blocked. The notifier agent reads this config and sends alerts through all enabled channels.',
      channels: [
        {
          name: 'console-default',
          type: 'console',
          enabled: true,
          guide: 'No setup needed. Notifications are printed to the terminal when the notifier agent runs. This channel is always available.',
          description: 'Output to terminal — always available, no setup needed',
        },
        {
          name: 'file-default',
          type: 'file',
          enabled: true,
          path: '.tasks/notifications.log',
          guide: 'No setup needed. Notifications are appended to the file specified in "path". Check this file periodically or use a log viewer. The file is markdown-formatted for readability.',
          description: 'Append notifications to a markdown log file',
        },
        {
          name: 'webhook-default',
          type: 'webhook',
          enabled: false,
          url: '',
          method: 'POST',
          format: 'slack',
          guide: `To set up a webhook notification channel:

1. Slack:
   - Go to https://api.slack.com/messaging/webhooks
   - Create a new app or select an existing one
   - Add an Incoming Webhook to a channel
   - Copy the webhook URL (looks like https://hooks.slack.com/services/...)
   - Paste it into the "url" field below
   - Set "format" to "slack"

2. Discord:
   - Open Discord server settings > Integrations > Webhooks
   - Click "New Webhook" and select a channel
   - Copy the webhook URL
   - Paste it into "url" and set "format" to "discord"

3. Microsoft Teams:
   - Open the channel > Connectors > Incoming Webhook
   - Name it and copy the URL
   - Paste into "url" and set "format" to "teams"

4. Generic HTTP endpoint:
   - Any service that accepts HTTP POST with JSON body
   - Set "format" to "generic"`,
          description: 'Send HTTP POST to a webhook URL (Slack, Discord, Teams)',
        },
        {
          name: 'email-default',
          type: 'email',
          enabled: false,
          smtpHost: '',
          smtpPort: 587,
          smtpUser: '',
          smtpPassword: '',
          from: '',
          to: '',
          guide: `To set up email notifications via SMTP:

1. Gmail:
   - Enable 2-factor authentication on your Google account
   - Go to https://myaccount.google.com/apppasswords
   - Generate an App Password (16 characters)
   - Set smtpHost: "smtp.gmail.com", smtpPort: 587
   - Set smtpUser: your Gmail address
   - Set smtpPassword: the App Password (NOT your real password)
   - Set from: your Gmail address, to: recipient address

2. Outlook/Office365:
   - Set smtpHost: "smtp.office365.com", smtpPort: 587
   - Use your Office365 credentials

3. Amazon SES:
   - Set smtpHost: your SES endpoint (e.g., email-smtp.us-east-1.amazonaws.com)
   - Set smtpPort: 587
   - Use your SES SMTP credentials (not AWS access keys)

4. Any SMTP server:
   - Set smtpHost and smtpPort to your server
   - Set smtpUser and smtpPassword to your credentials`,
          description: 'Send email via SMTP',
        },
        {
          name: 'custom-default',
          type: 'custom',
          enabled: false,
          guide: `Describe how to send notifications using this channel. The notifier agent will read your instructions and execute them.

Examples:
- Telegram: "Send a message via Telegram bot API. Use curl to POST to https://api.telegram.org/bot<TOKEN>/sendMessage with chat_id=<CHAT_ID> and text=<message>. Replace <TOKEN> with your bot token from @BotFather and <CHAT_ID> with your chat ID."
- SMS: "Use the Twilio API to send an SMS. Set ACCOUNT_SID and AUTH_TOKEN as environment variables. POST to https://api.twilio.com/2010-04-01/Accounts/<SID>/Messages with From=<PHONE>, To=<PHONE>, Body=<message>."
- Desktop notification: "Use PowerShell to show a Windows notification: run powershell -Command \\"[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('<message')\\""
- Any custom method: Describe the exact steps and commands the agent should run.`,
          description: 'Custom channel — describe how to send notifications and the agent will follow your instructions',
        },
      ],
      blockedCheckIntervalSeconds: 60,
      messageTemplate: `## Blocked: {{taskName}} ({{taskId}})

**Was in:** {{previousState}} | **By:** {{agentType}} | **At:** {{timestamp}}
**Description:** {{taskDescription}}

### Questions ({{questionCount}})
{{questionsGrouped}}

### Recent activity
{{recentRunSummary}}

**Resolve:** \`npx taskflow resolve-blocked {{taskId}}\``,
    },
    gitFlow: {
      enabled: false,
      baseBranch: 'main',
      worktreeDir: '.worktrees',
      branchPrefix: 'taskflow/',
      autoCleanup: true,
      commitConvention: 'conventional',
      mergeStrategy: 'merge',
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
    runLog: {
      enabled: parsed.runLog?.enabled ?? defaults.runLog.enabled,
      maxTaskLogLines: parsed.runLog?.maxTaskLogLines ?? defaults.runLog.maxTaskLogLines,
      maxSessionLogLines: parsed.runLog?.maxSessionLogLines ?? defaults.runLog.maxSessionLogLines,
      maxSessionFiles: parsed.runLog?.maxSessionFiles ?? defaults.runLog.maxSessionFiles,
      maxReleaserLogLines: parsed.runLog?.maxReleaserLogLines ?? defaults.runLog.maxReleaserLogLines,
    },
    executor: mergeExecutorConfig(defaults.executor, parsed.executor),
    tester: mergeTesterConfig(defaults.tester, parsed.tester),
    user: {
      allowMoveFromStates: parsed.user?.allowMoveFromStates ?? defaults.user.allowMoveFromStates,
      requireVersioningForActive: parsed.user?.requireVersioningForActive ?? defaults.user.requireVersioningForActive,
    },
    notification: {
      enabled: parsed.notification?.enabled ?? defaults.notification.enabled,
      description: parsed.notification?.description ?? defaults.notification.description,
      channels: parsed.notification?.channels ?? defaults.notification.channels,
      blockedCheckIntervalSeconds: parsed.notification?.blockedCheckIntervalSeconds ?? defaults.notification.blockedCheckIntervalSeconds,
      messageTemplate: parsed.notification?.messageTemplate ?? defaults.notification.messageTemplate,
    },
    gitFlow: {
      enabled: parsed.gitFlow?.enabled ?? defaults.gitFlow.enabled,
      baseBranch: parsed.gitFlow?.baseBranch ?? defaults.gitFlow.baseBranch,
      worktreeDir: parsed.gitFlow?.worktreeDir ?? defaults.gitFlow.worktreeDir,
      branchPrefix: parsed.gitFlow?.branchPrefix ?? defaults.gitFlow.branchPrefix,
      autoCleanup: parsed.gitFlow?.autoCleanup ?? defaults.gitFlow.autoCleanup,
      commitConvention: parsed.gitFlow?.commitConvention ?? defaults.gitFlow.commitConvention,
      mergeStrategy: parsed.gitFlow?.mergeStrategy ?? defaults.gitFlow.mergeStrategy,
    },
  };
}

function coerceNumber(v: unknown, field: string, opts: { min?: number; max?: number; default: number }): number {
  let n: number;
  if (typeof v === 'number' && !Number.isNaN(v)) {
    n = v;
  } else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) {
    n = Number(v);
  } else if (v === undefined || v === null) {
    return opts.default;
  } else {
    throw new Error(`Config field '${field}' must be a number, got ${typeof v} ('${v}')`);
  }
  if (opts.min !== undefined && n < opts.min) {
    n = opts.min;
  }
  if (opts.max !== undefined && n > opts.max) {
    n = opts.max;
  }
  return n;
}

export function coerceConfig(parsed: Partial<TaskFlowConfig>): Partial<TaskFlowConfig> {
  const result: Partial<TaskFlowConfig> = { ...parsed };
  if (parsed.heartbeat) {
    result.heartbeat = {
      ...parsed.heartbeat,
      intervalSeconds: coerceNumber(parsed.heartbeat.intervalSeconds, 'heartbeat.intervalSeconds', { min: 5, default: 60 }),
      jitterSeconds: coerceNumber(parsed.heartbeat.jitterSeconds, 'heartbeat.jitterSeconds', { min: 0, default: 5 }),
      staleThresholdSeconds: coerceNumber(parsed.heartbeat.staleThresholdSeconds, 'heartbeat.staleThresholdSeconds', { min: 10, default: 120 }),
      lockReleaserIntervalSeconds: coerceNumber(parsed.heartbeat.lockReleaserIntervalSeconds, 'heartbeat.lockReleaserIntervalSeconds', { min: 5, default: 60 }),
    };
  }
  if (parsed.test) {
    result.test = {
      ...parsed.test,
      passRatioRequired: coerceNumber(parsed.test.passRatioRequired, 'test.passRatioRequired', { min: 0, max: 1, default: 1.0 }),
    };
  }
  return result;
}

export function loadConfig(taskDir: string): TaskFlowConfig {
  const configPath = path.join(taskDir, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return getDefaultConfig();
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  // G1: resolve ${ENV_VAR} references in the raw text before parsing
  const resolved = resolveEnvVars(raw);
  const parsed = parseYaml(resolved) as Partial<TaskFlowConfig> | null;
  if (!parsed || typeof parsed !== 'object') {
    return getDefaultConfig();
  }
  const coerced = coerceConfig(parsed);
  const defaults = getDefaultConfig();
  return deepMergeConfig(defaults, coerced);
}

/**
 * Replace ${ENV_VAR} and ${ENV_VAR:default} patterns with environment values.
 * G1: allows secrets (SMTP passwords, webhook URLs) to be referenced without hardcoding.
 */
function resolveEnvVars(text: string): string {
  return text.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::([^}]*))?\}/g, (match, varName, defaultVal) => {
    const envVal = process.env[varName];
    if (envVal !== undefined) return envVal;
    if (defaultVal !== undefined) return defaultVal;
    return match; // leave unresolved as-is so validation can catch it
  });
}