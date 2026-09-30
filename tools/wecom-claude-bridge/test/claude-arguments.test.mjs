import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildClaudeArguments } from '../src/claude-runner.mjs';

test('buildClaudeArguments 生成无会话续接时的最小参数集', () => {
  const arguments_ = buildClaudeArguments({
    prompt: '总结这个项目',
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    allowedTools: [],
  });

  assert.deepEqual(arguments_, [
    '-p',
    '总结这个项目',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
  ]);
});

test('buildClaudeArguments 附带会话续接与工具白名单', () => {
  const arguments_ = buildClaudeArguments({
    prompt: '继续',
    resumeSessionId: 'session-abc',
    permissionMode: 'dontAsk',
    allowedTools: ['Read', 'Edit', 'Bash'],
  });

  assert.ok(arguments_.includes('--resume'));
  assert.equal(arguments_[arguments_.indexOf('--resume') + 1], 'session-abc');
  assert.equal(arguments_[arguments_.indexOf('--allowedTools') + 1], 'Read,Edit,Bash');
  assert.equal(arguments_[arguments_.indexOf('--permission-mode') + 1], 'dontAsk');
});
