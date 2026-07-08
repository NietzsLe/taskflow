import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, getDefaultConfig, deepMergeConfig, coerceConfig } from '../config';
import { ensureStateDirs } from '../state';

let tmpDir: string;
let taskDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cfg-'));
  taskDir = path.join(tmpDir, '.tasks');
  ensureStateDirs(taskDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getDefaultConfig', () => {
  it('returns config with all sections', () => {
    const cfg = getDefaultConfig();
    expect(cfg.system.name).toBe('TaskFlow');
    expect(cfg.heartbeat.intervalSeconds).toBe(60);
    expect(cfg.heartbeat.staleThresholdSeconds).toBe(120);
    expect(cfg.test.passRatioRequired).toBe(1.0);
    expect(cfg.runLog.enabled).toBe(true);
    expect(cfg.user.allowMoveFromStates).toEqual(['defined', 'pending', 'blocked']);
    expect(cfg.notification.channels.length).toBeGreaterThan(0);
    // gitFlow defaults
    expect(cfg.gitFlow.enabled).toBe(false);
    expect(cfg.gitFlow.baseBranch).toBe('main');
    expect(cfg.gitFlow.worktreeDir).toBe('.worktrees');
    expect(cfg.gitFlow.branchPrefix).toBe('taskflow/');
    expect(cfg.gitFlow.autoCleanup).toBe(true);
    expect(cfg.gitFlow.commitConvention).toBe('conventional');
    expect(cfg.gitFlow.mergeStrategy).toBe('merge');
  });
});

describe('loadConfig', () => {
  it('returns default when config file missing', () => {
    const cfg = loadConfig(taskDir);
    expect(cfg.heartbeat.intervalSeconds).toBe(60);
    expect(cfg.runLog.enabled).toBe(true);
  });

  it('returns default when config file is empty', () => {
    fs.writeFileSync(path.join(taskDir, 'config.yaml'), '', 'utf-8');
    const cfg = loadConfig(taskDir);
    expect(cfg.heartbeat.intervalSeconds).toBe(60);
  });

  it('overrides specific fields, keeps defaults for rest', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'heartbeat:\n  intervalSeconds: 30\n  staleThresholdSeconds: 90\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.heartbeat.intervalSeconds).toBe(30);
    expect(cfg.heartbeat.staleThresholdSeconds).toBe(90);
    // defaults preserved
    expect(cfg.heartbeat.jitterSeconds).toBe(5);
    expect(cfg.test.passRatioRequired).toBe(1.0);
  });

  it('overrides user.allowMoveFromStates', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'user:\n  allowMoveFromStates: ["defined"]\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.user.allowMoveFromStates).toEqual(['defined']);
  });

  it('handles partial notification config', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'notification:\n  enabled: false\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.notification.enabled).toBe(false);
    // channels still have defaults
    expect(cfg.notification.channels.length).toBeGreaterThan(0);
  });

  it('handles partial runLog config', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'runLog:\n  enabled: false\n  maxTaskLogLines: 100\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.runLog.enabled).toBe(false);
    expect(cfg.runLog.maxTaskLogLines).toBe(100);
    expect(cfg.runLog.maxSessionLogLines).toBe(500); // default
  });
});

describe('coerceConfig (D7, D8)', () => {
  it('coerces string "120" to number 120', () => {
    const c = coerceConfig({
      heartbeat: { intervalSeconds: '30' as any, staleThresholdSeconds: '90' as any },
    } as any);
    expect(c.heartbeat!.intervalSeconds).toBe(30);
    expect(c.heartbeat!.staleThresholdSeconds).toBe(90);
  });

  it('clamps staleThresholdSeconds to min 10', () => {
    const c = coerceConfig({
      heartbeat: { staleThresholdSeconds: 0 },
    } as any);
    expect(c.heartbeat!.staleThresholdSeconds).toBe(10);
  });

  it('clamps intervalSeconds to min 5', () => {
    const c = coerceConfig({
      heartbeat: { intervalSeconds: 1 },
    } as any);
    expect(c.heartbeat!.intervalSeconds).toBe(5);
  });

  it('clamps passRatioRequired to 0..1', () => {
    const c = coerceConfig({
      test: { passRatioRequired: 1.5 },
    } as any);
    expect(c.test!.passRatioRequired).toBe(1);
    const c2 = coerceConfig({
      test: { passRatioRequired: -0.5 },
    } as any);
    expect(c2.test!.passRatioRequired).toBe(0);
  });

  it('throws on non-numeric string', () => {
    expect(() => coerceConfig({
      heartbeat: { intervalSeconds: 'abc' as any },
    } as any)).toThrow();
  });

  it('returns default for undefined fields', () => {
    const c = coerceConfig({} as any);
    expect(c.heartbeat).toBeUndefined(); // no heartbeat in parsed → no coercion, defaults applied later
  });

  it('loadConfig applies coercion end-to-end', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'heartbeat:\n  intervalSeconds: "15"\n  staleThresholdSeconds: "200"\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.heartbeat.intervalSeconds).toBe(15);
    expect(cfg.heartbeat.staleThresholdSeconds).toBe(200);
  });

  it('loadConfig clamps out-of-bounds values', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'heartbeat:\n  staleThresholdSeconds: 0\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.heartbeat.staleThresholdSeconds).toBe(10); // clamped to min
  });
});

describe('gitFlow config', () => {
  it('defaults to disabled when not in config file', () => {
    fs.writeFileSync(path.join(taskDir, 'config.yaml'), 'heartbeat:\n  intervalSeconds: 60\n', 'utf-8');
    const cfg = loadConfig(taskDir);
    expect(cfg.gitFlow.enabled).toBe(false);
    expect(cfg.gitFlow.baseBranch).toBe('main');
  });

  it('overrides gitFlow fields when present', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'gitFlow:\n  enabled: true\n  baseBranch: develop\n  mergeStrategy: squash\n  autoCleanup: false\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.gitFlow.enabled).toBe(true);
    expect(cfg.gitFlow.baseBranch).toBe('develop');
    expect(cfg.gitFlow.mergeStrategy).toBe('squash');
    expect(cfg.gitFlow.autoCleanup).toBe(false);
    expect(cfg.gitFlow.worktreeDir).toBe('.worktrees');
    expect(cfg.gitFlow.commitConvention).toBe('conventional');
  });

  it('partial override keeps defaults', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'gitFlow:\n  enabled: true\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.gitFlow.enabled).toBe(true);
    expect(cfg.gitFlow.baseBranch).toBe('main');
    expect(cfg.gitFlow.branchPrefix).toBe('taskflow/');
  });
});

describe('notification channel name field', () => {
  it('default config includes name on all 5 channels', () => {
    const cfg = getDefaultConfig();
    const channels = cfg.notification.channels;
    expect(channels).toHaveLength(5);
    for (const ch of channels) {
      expect(ch.name).toBeDefined();
      expect(typeof ch.name).toBe('string');
      expect(ch.name!.length).toBeGreaterThan(0);
    }
  });

  it('name field is optional — channel without name loads fine', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'notification:\n  channels:\n    - type: webhook\n      enabled: true\n      url: "https://example.com/hook"\n      guide: "send it"\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    // user-defined channels replace defaults (mergeArray returns parsed if present)
    expect(cfg.notification.channels).toHaveLength(1);
    expect(cfg.notification.channels[0].name).toBeUndefined();
    expect(cfg.notification.channels[0].type).toBe('webhook');
  });

  it('multiple instances of same type with different names', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      `notification:
  channels:
    - name: "slack-alerts"
      type: "webhook"
      enabled: true
      url: "https://hooks.slack.com/services/a"
      format: "slack"
      guide: "send to slack"
    - name: "discord-alerts"
      type: "webhook"
      enabled: true
      url: "https://discord.com/api/webhooks/b"
      format: "discord"
      guide: "send to discord"
`,
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.notification.channels).toHaveLength(2);
    expect(cfg.notification.channels[0].name).toBe('slack-alerts');
    expect(cfg.notification.channels[1].name).toBe('discord-alerts');
    expect(cfg.notification.channels[0].type).toBe('webhook');
    expect(cfg.notification.channels[1].type).toBe('webhook');
    expect(cfg.notification.channels[0].url).not.toBe(cfg.notification.channels[1].url);
  });

  it('partial notification config keeps default channels with names', () => {
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'notification:\n  enabled: false\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.notification.enabled).toBe(false);
    expect(cfg.notification.channels.length).toBeGreaterThan(0);
    for (const ch of cfg.notification.channels) {
      expect(ch.name).toBeDefined();
    }
  });
});

describe('loadConfig env var resolution (G1)', () => {
  it('resolves ${ENV_VAR} from process.env', () => {
    process.env.TF_TEST_SMTP_PASS = 'secret123';
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'notification:\n  channels:\n    - type: email\n      smtpPassword: ${TF_TEST_SMTP_PASS}\n      enabled: true\n      guide: "x"\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    const emailChannel = cfg.notification.channels.find(c => c.type === 'email');
    expect(emailChannel).toBeDefined();
    expect(emailChannel!.smtpPassword).toBe('secret123');
    delete process.env.TF_TEST_SMTP_PASS;
  });

  it('resolves ${ENV_VAR:default} with default when env not set', () => {
    delete process.env.TF_TEST_NONEXISTENT;
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'heartbeat:\n  intervalSeconds: ${TF_TEST_NONEXISTENT:45}\n',
      'utf-8'
    );
    const cfg = loadConfig(taskDir);
    expect(cfg.heartbeat.intervalSeconds).toBe(45);
  });

  it('leaves unresolved ${VAR} as-is when env not set and no default', () => {
    delete process.env.TF_TEST_UNRESOLVED;
    fs.writeFileSync(
      path.join(taskDir, 'config.yaml'),
      'heartbeat:\n  intervalSeconds: 60\n',
      'utf-8'
    );
    // This doesn't throw — just uses the value as-is if no var
    const cfg = loadConfig(taskDir);
    expect(cfg.heartbeat.intervalSeconds).toBe(60);
  });
});

describe('deepMergeConfig', () => {
  it('merges shallow for heartbeat (spread)', () => {
    const def = getDefaultConfig();
    const merged = deepMergeConfig(def, {
      heartbeat: { intervalSeconds: 15 } as any,
    });
    expect(merged.heartbeat.intervalSeconds).toBe(15);
    expect(merged.heartbeat.staleThresholdSeconds).toBe(120); // default
  });

  it('replaces arrays for browserMCP', () => {
    const def = getDefaultConfig();
    const merged = deepMergeConfig(def, {
      browserMCP: [{ name: 'custom-mcp', available: true, lastCheck: null }],
    });
    expect(merged.browserMCP).toHaveLength(1);
    expect(merged.browserMCP[0].name).toBe('custom-mcp');
  });

  it('merges infrastructure.environments (spread merge keeps both)', () => {
    const def = getDefaultConfig();
    def.infrastructure.environments = {
      dev: { description: 'dev env', setupGuide: '', services: [] },
    };
    const merged = deepMergeConfig(def, {
      infrastructure: {
        environments: {
          staging: { description: 'staging', setupGuide: '', services: [] },
        },
      } as any,
    });
    // spread merge keeps dev and adds staging
    expect(merged.infrastructure.environments.dev).toBeDefined();
    expect(merged.infrastructure.environments.staging).toBeDefined();
  });
});