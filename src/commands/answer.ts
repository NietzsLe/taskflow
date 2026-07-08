import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getTaskFilePath, getTaskState } from '../core/state';
import { appendRunLog } from '../core/runlog';
import { validateTaskYaml } from '../core/validate';

/**
 * Answer a pending question on a blocked task.
 * Sets answered: true, answer, answeredAt. Does NOT move the task (use resolve-blocked for that).
 */
export function answerQuestion(taskDir: string, taskId: string, questionId: string, answerText: string): void {
  const state = getTaskState(taskDir, taskId);
  if (!state) {
    console.error(`Task '${taskId}' not found.`);
    process.exit(1);
  }
  if (state !== 'blocked') {
    console.error(`Task '${taskId}' is not blocked (current: ${state}). Answers can only be added to blocked tasks.`);
    process.exit(1);
  }

  const filePath = getTaskFilePath(taskDir, taskId);
  if (!filePath) {
    console.error(`Task '${taskId}' file not found.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const task = validateTaskYaml(parseYaml(raw));

  if (!task.pendingQuestions || task.pendingQuestions.length === 0) {
    console.error(`Task '${taskId}' has no pending questions.`);
    process.exit(1);
  }

  const question = task.pendingQuestions.find(q => q.id === questionId);
  if (!question) {
    console.error(`Question '${questionId}' not found on task '${taskId}'.`);
    console.error('Available questions:');
    for (const q of task.pendingQuestions) {
      console.error(`  [${q.id}] ${q.question.slice(0, 80)}`);
    }
    process.exit(1);
  }

  if (question.answered) {
    console.error(`Question '${questionId}' is already answered.`);
    process.exit(1);
  }

  question.answered = true;
  question.answer = answerText;
  question.answeredAt = new Date().toISOString();
  task.statusDescription = `Question '${questionId}' answered`;
  task.updatedAt = new Date().toISOString();

  fs.writeFileSync(filePath, stringifyYaml(task), 'utf-8');

  appendRunLog(taskDir, {
    timestamp: new Date().toISOString(),
    agentType: 'user',
    sessionId: 'cli',
    agentName: null,
    taskId,
    taskVersion: task.version,
    taskState: 'blocked',
    action: 'answer',
    description: `User answered question '${questionId}' on task '${taskId}'`,
    summary: `Q: ${question.question}\nA: ${answerText}`,
    result: 'success',
    duration: 0,
    error: null,
    details: null,
  });

  const remaining = task.pendingQuestions.filter(q => !q.answered).length;
  console.log(`Answered question '${questionId}' on task '${taskId}'.`);
  if (remaining > 0) {
    console.log(`${remaining} unanswered question(s) remaining. Answer them, then run: npx taskflow resolve-blocked ${taskId}`);
  } else {
    console.log(`All questions answered. Run: npx taskflow resolve-blocked ${taskId}`);
  }
}