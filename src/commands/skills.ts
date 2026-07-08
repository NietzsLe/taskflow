import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

interface SkillFrontmatter {
  name: string;
  description: string;
}

function readFrontmatter(filePath: string): SkillFrontmatter | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const fm = parseYaml(match[1]) as SkillFrontmatter;
    return fm;
  } catch {
    return null;
  }
}

export function listSkills(targetDir: string): void {
  const skillsDir = path.join(targetDir, '.agents', 'skills');
  if (!fs.existsSync(skillsDir)) {
    console.log('No skills installed. Run: npx taskflow init');
    return;
  }
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills = entries.filter(e => e.isDirectory());
  if (skills.length === 0) {
    console.log('No skills found in .agents/skills/');
    return;
  }
  console.log('Installed skills:\n');
  for (const s of skills) {
    const skillFile = path.join(skillsDir, s.name, 'SKILL.md');
    const fm = readFrontmatter(skillFile);
    if (fm) {
      console.log(`  ${fm.name} — ${fm.description}`);
    } else {
      console.log(`  ${s.name} — (no frontmatter or unreadable)`);
    }
  }
}

const EXPECTED_SKILLS = [
  'taskflow-init',
  'taskflow-executor',
  'taskflow-tester',
  'taskflow-lock-releaser',
  'taskflow-notifier',
  'taskflow-user',
];

export function verifySkills(targetDir: string): void {
  const skillsDir = path.join(targetDir, '.agents', 'skills');
  let allOk = true;
  console.log('Skill verification:\n');
  for (const name of EXPECTED_SKILLS) {
    const skillFile = path.join(skillsDir, name, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      console.log(`  ✓ ${name}`);
    } else {
      console.log(`  ✗ ${name} — MISSING (run: npx taskflow init)`);
      allOk = false;
    }
  }
  // Check for unexpected skills
  if (fs.existsSync(skillsDir)) {
    const installed = fs.readdirSync(skillsDir).filter(e => fs.statSync(path.join(skillsDir, e)).isDirectory());
    const extra = installed.filter(e => !EXPECTED_SKILLS.includes(e));
    for (const e of extra) {
      console.log(`  + ${e} — custom skill`);
    }
  }
  if (!allOk) {
    process.exit(1);
  }
}