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

test('interpretCommand 识别终止任务命令及其中文别名', () => {
  assert.deepEqual(interpretCommand('/stop'), { name: 'stopTask' });
  assert.deepEqual(interpretCommand('  /stop  '), { name: 'stopTask' });
  assert.deepEqual(interpretCommand('停止任务'), { name: 'stopTask' });
  assert.deepEqual(interpretCommand('终止任务'), { name: 'stopTask' });
  assert.deepEqual(interpretCommand('暂停任务'), { name: 'stopTask' });
});

test('interpretCommand 识别会话恢复列表命令', () => {
  assert.deepEqual(interpretCommand('/resume'), { name: 'listResumableSessions' });
  assert.deepEqual(interpretCommand('  /resume  '), { name: 'listResumableSessions' });
});

test('interpretCommand 识别会话恢复选择命令并取出序号', () => {
  assert.deepEqual(interpretCommand('/resume 2'), { name: 'selectResumableSession', index: 2 });
  assert.deepEqual(interpretCommand('/resume  10'), { name: 'selectResumableSession', index: 10 });
});

test('interpretCommand 对非数字序号的 /resume 返回 null', () => {
  assert.equal(interpretCommand('/resume abc'), null);
  assert.equal(interpretCommand('/resume 0x1f'), null);
});

test('interpretCommand 对普通消息与未知命令返回 null', () => {
  assert.equal(interpretCommand('帮我修个 bug'), null);
  assert.equal(interpretCommand('/unknown args'), null);
  assert.equal(interpretCommand(''), null);
});
