import * as fs from 'fs';
import * as path from 'path';

/**
 * Write a minimal valid config.yaml for tests.
 * Uses the default config shape so loadConfig returns defaults.
 */
export function writeDefaultConfig(taskDir: string): void {
  // Empty config file → loadConfig falls back to all defaults via deepMergeConfig
  const configPath = path.join(taskDir, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, '# test config\nrunLog:\n  enabled: true\n', 'utf-8');
  }
}