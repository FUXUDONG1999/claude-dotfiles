import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfiguration } from '../src/configuration.mjs';

const BASE_ENVIRONMENT = {
  BOT_ID: 'bot-id',
  BOT_SECRET: 'bot-secret',
  ALLOWED_USER_IDS: 'dong',
  DEFAULT_WORKING_DIRECTORY: '/tmp',
};

test('loadConfiguration 将 SESSION_TTL_HOURS 换算为毫秒', () => {
  const configuration = loadConfiguration({ ...BASE_ENVIRONMENT, SESSION_TTL_HOURS: '2' });

  assert.equal(configuration.sessionTtlMilliseconds, 7_200_000);
});

test('loadConfiguration 对非法 TTL 值回退到默认 6 小时', () => {
  const configuration = loadConfiguration({ ...BASE_ENVIRONMENT, SESSION_TTL_HOURS: 'not-a-number' });

  assert.equal(configuration.sessionTtlMilliseconds, 6 * 3600_000);
});
