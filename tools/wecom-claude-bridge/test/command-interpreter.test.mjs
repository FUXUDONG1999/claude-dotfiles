import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interpretCommand } from '../src/command-interpreter.mjs';

test('interpretCommand 识别重开会话命令', () => {
  assert.deepEqual(interpretCommand('/new'), { name: 'resetSession' });
  assert.deepEqual(interpretCommand('  /new  '), { name: 'resetSession' });
});

test('interpretCommand 识别切换工作目录命令并取出参数', () => {
  assert.deepEqual(interpretCommand('/cwd /data/another-project'), {
    name: 'setWorkingDirectory',
    workingDirectory: '/data/another-project',
  });
});

test('interpretCommand 识别状态查询命令', () => {
  assert.deepEqual(interpretCommand('/status'), { name: 'queryStatus' });
});

test('interpretCommand 对普通消息与未知命令返回 null', () => {
  assert.equal(interpretCommand('帮我修个 bug'), null);
  assert.equal(interpretCommand('/unknown args'), null);
  assert.equal(interpretCommand(''), null);
});
