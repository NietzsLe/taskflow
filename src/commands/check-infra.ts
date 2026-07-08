import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../core/config';
import * as http from 'http';
import * as https from 'https';
import { execSync } from 'child_process';

interface ServiceCheckResult {
  name: string;
  status: 'ok' | 'fail' | 'skipped';
  message: string;
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

/**
 * Check infrastructure services for a given environment.
 */
export async function checkInfrastructure(taskDir: string, envName?: string): Promise<void> {
  const config = loadConfig(taskDir);
  const env = envName || config.infrastructure.defaultEnvironment || 'dev';
  const envConfig = config.infrastructure.environments[env];
  if (!envConfig) {
    console.error(`Environment '${env}' not found in config.`);
    console.error('Available:', Object.keys(config.infrastructure.environments).join(', ') || '(none configured)');
    process.exit(1);
  }

  if (!envConfig.services || envConfig.services.length === 0) {
    console.log(`No services configured for environment '${env}'.`);
    return;
  }

  console.log(`Checking infrastructure: ${env} (${envConfig.services.length} services)\n`);
  const results: ServiceCheckResult[] = [];
  let allRequiredOk = true;

  for (const svc of envConfig.services) {
    const check = svc.check;
    let ok = false;
    let message = '';

    try {
      if (check.method === 'port') {
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

    const status: ServiceCheckResult['status'] = ok ? 'ok' : (svc.required ? 'fail' : 'skipped');
    if (!ok && svc.required) allRequiredOk = false;
    results.push({ name: svc.name, status, message });
  }

  for (const r of results) {
    const icon = r.status === 'ok' ? '✓' : r.status === 'fail' ? '✗' : '○';
    console.log(`  ${icon} ${r.name}: ${r.message}`);
  }

  console.log('');
  if (!allRequiredOk) {
    console.error('Some required services are not available.');
    process.exit(1);
  } else {
    console.log('All required services are available.');
  }
}