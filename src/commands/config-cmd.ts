import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadConfig } from '../core/config';

function getByPath(obj: any, key: string): unknown {
  const parts = key.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && (cur as any)[p] !== undefined) {
      cur = (cur as any)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setByPath(obj: any, key: string, value: string): void {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  // Try to coerce value to number/boolean/null
  let coerced: unknown = value;
  if (value === 'true') coerced = true;
  else if (value === 'false') coerced = false;
  else if (value === 'null') coerced = null;
  else if (/^\d+(\.\d+)?$/.test(value)) coerced = Number(value);
  cur[parts[parts.length - 1]] = coerced;
}

export function configGet(taskDir: string, key: string): void {
  const config = loadConfig(taskDir);
  const value = getByPath(config, key);
  if (value === undefined) {
    console.log(`(undefined)`);
  } else if (typeof value === 'object') {
    console.log(stringifyYaml(value).trim());
  } else {
    console.log(value);
  }
}

export function configSet(taskDir: string, key: string, value: string): void {
  const configPath = path.join(taskDir, 'config.yaml');
  let parsed: any = {};
  if (fs.existsSync(configPath)) {
    parsed = parseYaml(fs.readFileSync(configPath, 'utf-8')) || {};
  }
  setByPath(parsed, key, value);
  // Note: stringify loses comments (accepted trade-off per user decision)
  fs.writeFileSync(configPath, stringifyYaml(parsed), 'utf-8');
  console.log(`Set ${key} = ${value}`);
}

export function configList(taskDir: string): void {
  const configPath = path.join(taskDir, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    console.log('(no config.yaml — using defaults)');
    return;
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  console.log(raw);
}