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
  assert.equal(firstEvent.snapshot.text, '先看一下文件。');
  assert.equal(secondEvent.snapshot.text, '先看一下文件。\n\n正在修复。');
});

test('StreamJsonAccumulator 对纯工具调用的 assistant 行返回带工具时间线的 progress 事件且不污染累计文本', () => {
  const accumulator = new StreamJsonAccumulator();

  const event = accumulator.consumeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
  );

  assert.equal(event.type, 'progress');
  assert.deepEqual(event.snapshot.toolEntries, [{ toolUseId: null, name: 'Bash', digest: '（无参数）', status: 'pending' }]);
  assert.equal(accumulator.accumulatedText, '');
});

test('StreamJsonAccumulator 记录 thinking 块，后一段思考替换前一段', () => {
  const accumulator = new StreamJsonAccumulator();

  const firstEvent = accumulator.consumeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '第一段思考。' }] } }),
  );
  const secondEvent = accumulator.consumeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '第二段思考。' }] } }),
  );

  assert.equal(firstEvent.type, 'progress');
  assert.equal(firstEvent.snapshot.thinkingText, '第一段思考。');
  assert.equal(secondEvent.snapshot.thinkingText, '第二段思考。');
});

test('StreamJsonAccumulator 按 tool_use_id 用 tool_result 标记成功与失败', () => {
  const accumulator = new StreamJsonAccumulator();

  accumulator.consumeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
  );
  accumulator.consumeLine(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/tmp/a.mjs' } }] } }),
  );
  const okEvent = accumulator.consumeLine(
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '全部通过', is_error: false }] } }),
  );
  const errorEvent = accumulator.consumeLine(
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: '文件不存在', is_error: true }] } }),
  );

  assert.equal(okEvent.type, 'progress');
  assert.equal(okEvent.snapshot.toolEntries[0].status, 'ok');
  assert.equal(errorEvent.snapshot.toolEntries[1].status, 'error');
  assert.equal(okEvent.snapshot.toolEntries[0].digest, 'npm test');
  assert.equal(errorEvent.snapshot.toolEntries[1].digest, 'a.mjs');
});

test('StreamJsonAccumulator 对无法对应工具的 tool_result 返回 null', () => {
  const accumulator = new StreamJsonAccumulator();

  const event = accumulator.consumeLine(
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ghost', content: '孤儿结果' }] } }),
  );

  assert.equal(event, null);
});

test('StreamJsonAccumulator 同一 assistant 消息里思考与工具调用同时进入快照', () => {
  const accumulator = new StreamJsonAccumulator();

  const event = accumulator.consumeLine(
    JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'thinking', thinking: '先跑测试看看。' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      ] },
    }),
  );

  assert.equal(event.type, 'progress');
  assert.equal(event.snapshot.thinkingText, '先跑测试看看。');
  assert.equal(event.snapshot.toolEntries[0].name, 'Bash');
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
