import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../core/config';
import * as http from 'http';
import * as https from 'https';
import { execSync } from 'child_process';

interface ServiceCheckResult {
  name: string;
  role?: string;
  status: 'ok' | 'fail' | 'skipped' | 'dep-down';
  message: string;
  interactionGuide?: string;
}

function checkPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { resolve(false); });
    socket.connect(port, host);
  });
}

function checkHttp(url: string, expectedStatus: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res: any) => {
      res.resume();
      resolve(res.statusCode === expectedStatus);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function checkCommand(cmd: string, timeoutMs = 10000): boolean {
  try {
    execSync(cmd, { timeout: timeoutMs, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function topologicalSort(names: string[], dependsOn: Record<string, string[]>): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];
  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular dependency detected involving '${name}'`);
    visiting.add(name);
    for (const dep of dependsOn[name] || []) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    result.push(name);
  }
  for (const name of names) {
    visit(name);
  }
  return result;
}

export async function checkInfrastructure(taskDir: string, envName?: string, checkSeedOnly = false): Promise<void> {
  const config = loadConfig(taskDir);
  const env = envName || config.infrastructure.defaultEnvironment || 'dev';
  const envConfig = config.infrastructure.environments[env];
  if (!envConfig) {
    console.error(`Environment '${env}' not found in config.`);
    console.error('Available:', Object.keys(config.infrastructure.environments).join(', ') || '(none configured)');
    process.exit(1);
  }

  const components = envConfig.components || [];
  const seeds = config.infrastructure.seed || [];

  if (!checkSeedOnly) {
    if (components.length === 0) {
      console.log(`No components configured for environment '${env}'.`);
      return;
    }

    // Build dependency map
    const dependsOn: Record<string, string[]> = {};
    for (const c of components) {
      dependsOn[c.name] = c.dependsOn || [];
    }
    const sorted = topologicalSort(components.map(c => c.name), dependsOn);
    const checked = new Set<string>();
    const results: ServiceCheckResult[] = [];
    let allRequiredOk = true;

    console.log(`Checking infrastructure: ${env} (${components.length} components)\n`);

    for (const name of sorted) {
      const svc = components.find(c => c.name === name);
      if (!svc) continue;

      // Check if any dependency failed
      const deps = svc.dependsOn || [];
      let depFailed = false;
      for (const dep of deps) {
        const depResult = results.find(r => r.name === dep);
        if (depResult && (depResult.status === 'fail' || depResult.status === 'dep-down')) {
          depFailed = true;
          break;
        }
      }

      if (depFailed) {
        results.push({
          name: svc.name,
          role: svc.role,
          status: 'dep-down',
          message: `skipped (dependency down: ${deps.filter(d => {
            const r = results.find(rr => rr.name === d);
            return r && (r.status === 'fail' || r.status === 'dep-down');
          }).join(', ')})`,
          interactionGuide: svc.interactionGuide,
        });
        if (svc.required) allRequiredOk = false;
        continue;
      }

      const check = svc.check;
      let ok = false;
      let message = '';

      try {
        if (check.method === 'port' || check.method === 'tcp') {
          ok = await checkPort(check.host || 'localhost', check.port || 80, check.timeoutSeconds ? check.timeoutSeconds * 1000 : 3000);
          message = `port ${check.port} on ${check.host || 'localhost'}`;
        } else if (check.method === 'http') {
          ok = await checkHttp(check.url || '', check.expectedStatus || 200, check.timeoutSeconds ? check.timeoutSeconds * 1000 : 5000);
          message = `HTTP ${check.url} → ${check.expectedStatus || 200}`;
        } else if (check.method === 'command') {
          ok = checkCommand(check.command || '', check.timeoutSeconds ? check.timeoutSeconds * 1000 : 10000);
          message = `command: ${check.command?.slice(0, 60)}`;
        } else {
          message = `unknown check method: ${check.method}`;
        }
      } catch (err: any) {
        message = `error: ${err.message}`;
      }

      // Auto-setup if auto=true and check failed (skip for remote components)
      if (!ok && svc.setup.auto && svc.setup.command && svc.type !== 'remote') {
        try {
          execSync(svc.setup.command, { timeout: (svc.setup.timeoutSeconds || 30) * 1000, stdio: 'pipe' });
          // Re-check after setup
          if (check.method === 'port' || check.method === 'tcp') {
            ok = await checkPort(check.host || 'localhost', check.port || 80, 5000);
          } else if (check.method === 'http') {
            ok = await checkHttp(check.url || '', check.expectedStatus || 200, 5000);
          } else if (check.method === 'command') {
            ok = checkCommand(check.command || '', 10000);
          }
          if (ok) message += ' (auto-started)';
        } catch {
          message += ' (auto-setup failed)';
        }
      }

      const status: ServiceCheckResult['status'] = ok ? 'ok' : (svc.required ? 'fail' : 'skipped');
      if (!ok && svc.required) allRequiredOk = false;
      results.push({
        name: svc.name,
        role: svc.role,
        status,
        message,
        interactionGuide: !ok && svc.interactionGuide ? svc.interactionGuide : undefined,
      });
      checked.add(name);
    }

    for (const r of results) {
      const icon = r.status === 'ok' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'dep-down' ? '⊘' : '○';
      const roleStr = r.role ? ` (${r.role})` : '';
      console.log(`  ${icon} ${r.name}${roleStr}: ${r.message}`);
      if (r.interactionGuide) {
        const firstLine = r.interactionGuide.split('\n').find(l => l.trim().length > 0) || '';
        console.log(`     Guide: ${firstLine.slice(0, 120)}`);
      }
    }

    console.log('');
    if (!allRequiredOk) {
      console.error('Some required services are not available.');
      process.exit(1);
    } else {
      console.log('All required services are available.');
    }
  }

  // Check seed entries
  if (seeds.length > 0) {
    console.log(`\nChecking seed (${seeds.length} entries):\n`);
    let allSeedOk = true;
    for (const seed of seeds) {
      let ok = false;
      let message = '';
      try {
        if (seed.check.method === 'api') {
          ok = await checkHttp(seed.check.url || '', seed.check.expectedStatus || 200, 5000);
          message = `API ${seed.check.url} → ${seed.check.expectedStatus || 200}`;
        } else if (seed.check.method === 'command') {
          ok = checkCommand(seed.check.command || seed.setup.command || '', (seed.setup.timeoutSeconds || 30) * 1000);
          message = `command: ${seed.setup.command?.slice(0, 60)}`;
        }
      } catch (err: any) {
        message = `error: ${err.message}`;
      }

      // Auto-setup if auto=true and check failed
      if (!ok && seed.setup.auto && seed.setup.command) {
        try {
          execSync(seed.setup.command, { timeout: (seed.setup.timeoutSeconds || 60) * 1000, stdio: 'pipe' });
          ok = true;
          message += ' (auto-seeded)';
        } catch {
          message += ' (auto-seed failed)';
        }
      }

      const icon = ok ? '✓' : seed.required ? '✗' : '○';
      if (!ok && seed.required) allSeedOk = false;
      console.log(`  ${icon} ${seed.name}: ${message}`);
      if (!ok && seed.interactionGuide) {
        const firstLine = seed.interactionGuide.split('\n').find(l => l.trim().length > 0) || '';
        console.log(`     Guide: ${firstLine.slice(0, 120)}`);
      }
    }
    console.log('');
    if (!allSeedOk) {
      console.error('Some required seed entries are not available.');
      process.exit(1);
    } else if (seeds.length > 0) {
      console.log('All seed entries are available.');
    }
  }
}
