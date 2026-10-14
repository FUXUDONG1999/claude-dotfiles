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

test('buildClaudeArguments 提供 MCP 配置文件时切换为严格 MCP 模式', () => {
  const arguments_ = buildClaudeArguments({
    prompt: '搜索一下',
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    allowedTools: [],
    mcpServersFile: '/srv/bridge/mcp-servers.json',
  });

  assert.ok(arguments_.includes('--strict-mcp-config'));
  assert.equal(arguments_[arguments_.indexOf('--mcp-config') + 1], '/srv/bridge/mcp-servers.json');
});

test('buildClaudeArguments 未提供 MCP 配置文件时不加严格 MCP 旗标', () => {
  const arguments_ = buildClaudeArguments({
    prompt: '总结这个项目',
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    allowedTools: [],
    mcpServersFile: null,
  });

  assert.ok(!arguments_.includes('--strict-mcp-config'));
  assert.ok(!arguments_.includes('--mcp-config'));
});

test('buildClaudeArguments 按开关注入禁用 hooks 的覆盖 settings', () => {
  const argumentsWithHooksDisabled = buildClaudeArguments({
    prompt: '总结这个项目',
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    allowedTools: [],
    disableAllHooks: true,
  });

  assert.equal(argumentsWithHooksDisabled[argumentsWithHooksDisabled.indexOf('--settings') + 1], '{"disableAllHooks":true}');

  const argumentsWithHooksEnabled = buildClaudeArguments({
    prompt: '总结这个项目',
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    allowedTools: [],
    disableAllHooks: false,
  });

  assert.ok(!argumentsWithHooksEnabled.includes('--settings'));
});
