import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StreamJsonAccumulator } from '../src/claude-runner.mjs';

test('StreamJsonAccumulator 解析 init 行并提取 session_id', () => {
  const accumulator = new StreamJsonAccumulator();

  const event = accumulator.consumeLine(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123', model: 'claude-sonnet-5' }),
  );

  assert.equal(event.type, 'session_started');
  assert.equal(event.sessionId, 'abc-123');
  assert.equal(accumulator.sessionId, 'abc-123');
});

test('StreamJsonAccumulator 累计多个 assistant 消息的文本块', () => {
  const accumulator = new StreamJsonAccumulator();

  accumulator.consumeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }));
  const firstEvent = accumulator.consumeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '先看一下文件。' }] } }),
  );
  const secondEvent = accumulator.consumeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '正在修复。' }, { type: 'tool_use', name: 'Edit' }] } }),
  );

  assert.equal(firstEvent.type, 'progress');
  assert.equal(firstEvent.text, '先看一下文件。');
  assert.equal(secondEvent.text, '先看一下文件。\n\n正在修复。');
});

test('StreamJsonAccumulator 对纯工具调用的 assistant 行返回 activity 事件且不污染累计文本', () => {
  const accumulator = new StreamJsonAccumulator();

  const event = accumulator.consumeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
  );

  assert.equal(event.type, 'assistant_activity');
  assert.equal(event.description, 'Bash');
  assert.equal(accumulator.accumulatedText, '');
});

test('StreamJsonAccumulator 解析 result 行并携带完整元数据', () => {
  const accumulator = new StreamJsonAccumulator();

  const event = accumulator.consumeLine(
    JSON.stringify({ type: 'result', result: '修复完成', session_id: 'abc-123', total_cost_usd: 0.05, duration_ms: 1200, is_error: false }),
  );

  assert.equal(event.type, 'completed');
  assert.equal(event.resultText, '修复完成');
  assert.equal(event.sessionId, 'abc-123');
  assert.equal(event.costUsd, 0.05);
  assert.equal(event.durationMilliseconds, 1200);
  assert.equal(event.isErrorMessage, false);
});

test('StreamJsonAccumulator 对空行与非 JSON 行容错返回 null', () => {
  const accumulator = new StreamJsonAccumulator();

  assert.equal(accumulator.consumeLine(''), null);
  assert.equal(accumulator.consumeLine('   '), null);
  assert.equal(accumulator.consumeLine('not-json{{{'), null);
  assert.equal(accumulator.consumeLine(JSON.stringify({ type: 'unknown' })), null);
});
