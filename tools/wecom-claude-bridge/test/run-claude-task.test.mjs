import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { test } from 'node:test';

import { runClaudeTask } from '../src/claude-runner.mjs';

const fakeClaudePath = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;

chmodSync(fakeClaudePath, 0o755);

function createConfiguration(overrides = {}) {
  return {
    claudeBinaryPath: fakeClaudePath,
    permissionMode: 'acceptEdits',
    allowedTools: [],
    taskTimeoutMilliseconds: 5_000,
    ...overrides,
  };
}

test('runClaudeTask 正常路径：进度回调、最终结果与元数据齐全', async () => {
  process.env.FAKE_CLAUDE_MODE = 'normal';

  const progressTexts = [];
  const taskResult = await runClaudeTask({
    prompt: '修复测试',
    resumeSessionId: null,
    workingDirectory: process.cwd(),
    configuration: createConfiguration(),
    onProgressText: (text) => progressTexts.push(text),
  });

  assert.equal(taskResult.success, true);
  assert.equal(taskResult.sessionId, 'fake-session-001');
  assert.equal(taskResult.resultText, '修复完成：3 个用例全部通过。');
  assert.equal(taskResult.costUsd, 0.02);
  assert.ok(progressTexts.length >= 2);
  assert.ok(progressTexts.at(-1).includes('测试通过，修复完成。'));
});

test('runClaudeTask 进程失败：返回 stderr 且标记失败', async () => {
  process.env.FAKE_CLAUDE_MODE = 'fail';

  const taskResult = await runClaudeTask({
    prompt: '触发崩溃',
    resumeSessionId: null,
    workingDirectory: process.cwd(),
    configuration: createConfiguration(),
    onProgressText: () => {},
  });

  assert.equal(taskResult.success, false);
  assert.equal(taskResult.exitCode, 2);
  assert.ok(taskResult.resultText.includes('fake claude crashed'));
});

test('runClaudeTask 超时：SIGTERM 终止并标记 timedOut', async () => {
  process.env.FAKE_CLAUDE_MODE = 'hang';

  const taskResult = await runClaudeTask({
    prompt: '挂起任务',
    resumeSessionId: null,
    workingDirectory: process.cwd(),
    configuration: createConfiguration({ taskTimeoutMilliseconds: 200 }),
    onProgressText: () => {},
  });

  assert.equal(taskResult.success, false);
  assert.equal(taskResult.timedOut, true);
  assert.ok(taskResult.resultText.includes('超时'));
});
