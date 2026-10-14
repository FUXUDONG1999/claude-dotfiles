import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfiguration } from '../src/configuration.mjs';

const BASE_ENVIRONMENT = {
  BOT_ID: 'bot-id',
  BOT_SECRET: 'bot-secret',
  ALLOWED_USER_IDS: 'dong',
  DEFAULT_WORKING_DIRECTORY: '/tmp',
};

test('loadConfiguration 的任务时限默认 2 小时，TASK_TIMEOUT_MINUTES 可覆盖', () => {
  const defaultConfiguration = loadConfiguration({ ...BASE_ENVIRONMENT });
  const overriddenConfiguration = loadConfiguration({ ...BASE_ENVIRONMENT, TASK_TIMEOUT_MINUTES: '15' });

  assert.equal(defaultConfiguration.taskTimeoutMilliseconds, 120 * 60_000);
  assert.equal(overriddenConfiguration.taskTimeoutMilliseconds, 15 * 60_000);
});

test('loadConfiguration 将 SESSION_TTL_HOURS 换算为毫秒', () => {
  const configuration = loadConfiguration({ ...BASE_ENVIRONMENT, SESSION_TTL_HOURS: '2' });

  assert.equal(configuration.sessionTtlMilliseconds, 7_200_000);
});

test('loadConfiguration 对非法 TTL 值回退到默认 6 小时', () => {
  const configuration = loadConfiguration({ ...BASE_ENVIRONMENT, SESSION_TTL_HOURS: 'not-a-number' });

  assert.equal(configuration.sessionTtlMilliseconds, 6 * 3600_000);
});

test('loadConfiguration 解析 MCP_SERVERS_FILE：文件存在给绝对路径，缺失为 null', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'bridge-mcp-'));
  const existingFile = join(temporaryDirectory, 'mcp-servers.json');
  writeFileSync(existingFile, '{"mcpServers":{}}');
  const missingFile = join(temporaryDirectory, 'absent.json');

  const configurationWithFile = loadConfiguration({ ...BASE_ENVIRONMENT, MCP_SERVERS_FILE: existingFile });
  const configurationWithoutFile = loadConfiguration({ ...BASE_ENVIRONMENT, MCP_SERVERS_FILE: missingFile });

  assert.equal(configurationWithFile.mcpServersFile, existingFile);
  assert.equal(configurationWithoutFile.mcpServersFile, null);
});

test('loadConfiguration 的 DISABLE_ALL_HOOKS 默认开启，显式 false 才关闭', () => {
  const defaultConfiguration = loadConfiguration({ ...BASE_ENVIRONMENT });
  const disabledConfiguration = loadConfiguration({ ...BASE_ENVIRONMENT, DISABLE_ALL_HOOKS: 'false' });

  assert.equal(defaultConfiguration.disableAllHooks, true);
  assert.equal(disabledConfiguration.disableAllHooks, false);
});
