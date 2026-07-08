import * as fs from 'fs';
import * as path from 'path';
import { ensureStateDirs } from './core/state';

const SKILLS_DIR = path.join(__dirname, 'templates', 'skills');

export function initTaskDir(targetDir: string, options?: { force?: boolean }): void {
  const taskDir = path.join(targetDir, '.tasks');

  // --force: backup existing .tasks/ before re-init
  if (options?.force && fs.existsSync(taskDir)) {
    const backupDir = path.join(targetDir, `.tasks.backup.${Date.now()}`);
    fs.renameSync(taskDir, backupDir);
    console.log(`Backed up existing .tasks/ to ${path.basename(backupDir)}/`);
  }

  ensureStateDirs(taskDir);

  // Create archive/ for deleted/archived tasks
  const archiveDir = path.join(taskDir, 'archive');
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  // Create .tasks/.gitignore to avoid committing locks/runs
  const gitignorePath = path.join(taskDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, 'locks/\nruns/\nnotifications.log\narchive/\n', 'utf-8');
  }

  const configSrc = path.join(__dirname, 'templates', 'config.yaml');
  const configDest = path.join(taskDir, 'config.yaml');
  if (!fs.existsSync(configDest) || options?.force) {
    fs.copyFileSync(configSrc, configDest);
  }

  const releaserLogPath = path.join(taskDir, 'runs', 'releaser-log.md');
  if (!fs.existsSync(releaserLogPath)) {
    fs.writeFileSync(releaserLogPath, '# Lock-releaser Log\n', 'utf-8');
  }

  console.log('Created:');
  console.log('  .tasks/defined/');
  console.log('  .tasks/pending/');
  console.log('  .tasks/processing/');
  console.log('  .tasks/testing/');
  console.log('  .tasks/review/');
  console.log('  .tasks/done/');
  console.log('  .tasks/blocked/');
  console.log('  .tasks/archive/');
  console.log('  .tasks/locks/');
  console.log('  .tasks/runs/');
  console.log('  .tasks/config.yaml');
  console.log('  .tasks/.gitignore');
  console.log('  .tasks/runs/releaser-log.md');
  console.log('');
  console.log('Next: edit .tasks/config.yaml to configure heartbeat, infrastructure, browserMCP');
}

export function installSkills(targetDir: string): void {
  const skillsDest = path.join(targetDir, '.agents', 'skills');
  const skillNames = [
    'taskflow-executor',
    'taskflow-tester',
    'taskflow-lock-releaser',
    'taskflow-user',
    'taskflow-init',
    'taskflow-notifier',
  ];

  for (const name of skillNames) {
    const srcDir = path.join(SKILLS_DIR, name);
    const destDir = path.join(skillsDest, name);
    if (!fs.existsSync(srcDir)) {
      console.warn(`Warning: skill directory '${name}' not found in templates. Skipping.`);
      continue;
    }
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const srcFile = path.join(srcDir, 'SKILL.md');
    const destFile = path.join(destDir, 'SKILL.md');
    if (fs.existsSync(srcFile) && !fs.existsSync(destFile)) {
      fs.copyFileSync(srcFile, destFile);
    }
  }

  console.log('Skills installed:');
  for (const name of skillNames) {
    console.log(`  .agents/skills/${name}/SKILL.md`);
  }
}