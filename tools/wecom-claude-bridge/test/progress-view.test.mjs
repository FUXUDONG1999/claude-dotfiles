import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractToolDigest, renderProgressMarkdown } from '../src/progress-view.mjs';

function createSnapshot(overrides = {}) {
  return {
    thinkingText: '',
    toolEntries: [],
    text: '',
    ...overrides,
  };
}

test('renderProgressMarkdown 把思考内容包进 <think> 标签', () => {
  const markdown = renderProgressMarkdown(createSnapshot({ thinkingText: '先看看测试文件在哪。' }), 12);

  assert.ok(markdown.includes('<think>\n先看看测试文件在哪。\n</think>'));
});

test('renderProgressMarkdown 思考为空时不输出 think 区块', () => {
  const markdown = renderProgressMarkdown(createSnapshot({ thinkingText: '' }), 12);

  assert.ok(!markdown.includes('<think>'));
});

test('renderProgressMarkdown 思考超长时只保留尾部并加截断标记', () => {
  const longThinking = '甲'.repeat(2000);
  const markdown = renderProgressMarkdown(createSnapshot({ thinkingText: longThinking }), 12);

  const thinkMatch = markdown.match(/<think>\n([\s\S]*?)\n<\/think>/);
  assert.ok(thinkMatch);
  assert.ok(thinkMatch[1].startsWith('…'));
  assert.ok(thinkMatch[1].endsWith('甲'));
  assert.ok(thinkMatch[1].length <= 1210);
});

test('renderProgressMarkdown 渲染工具时间线：名称加粗、摘要行内代码、状态图标区分', () => {
  const markdown = renderProgressMarkdown(
    createSnapshot({
      toolEntries: [
        { name: 'Bash', digest: 'npm test', status: 'ok' },
        { name: 'Read', digest: 'bridge.mjs', status: 'error' },
        { name: 'Edit', digest: 'config.mjs', status: 'pending' },
      ],
    }),
    12,
  );

  assert.ok(markdown.includes('- 🔧 **Bash** `npm test` ✅'));
  assert.ok(markdown.includes('- 🔧 **Read** `bridge.mjs` ❌'));
  assert.ok(markdown.includes('- 🔧 **Edit** `config.mjs` ⏳'));
});

test('renderProgressMarkdown 只保留最近 5 条工具调用', () => {
  const markdown = renderProgressMarkdown(
    createSnapshot({
      toolEntries: Array.from({ length: 8 }, (_, index) => ({
        name: 'Bash',
        digest: `cmd-${index}`,
        status: 'ok',
      })),
    }),
    12,
  );

  assert.ok(!markdown.includes('cmd-0'));
  assert.ok(!markdown.includes('cmd-2'));
  assert.ok(markdown.includes('cmd-3'));
  assert.ok(markdown.includes('cmd-7'));
  assert.equal(markdown.match(/- 🔧/g).length, 5);
});

test('renderProgressMarkdown 头部含进行中标记、耗时与工具完成统计', () => {
  const markdown = renderProgressMarkdown(
    createSnapshot({
      toolEntries: [
        { name: 'Bash', digest: 'npm test', status: 'ok' },
        { name: 'Read', digest: 'bridge.mjs', status: 'pending' },
      ],
    }),
    34,
  );

  assert.ok(markdown.includes('⏳ 进行中 · 34s · 工具 1/2'));
});

test('renderProgressMarkdown 正文文本置于分隔线之后', () => {
  const markdown = renderProgressMarkdown(createSnapshot({ text: '先分析依赖。' }), 12);

  assert.ok(markdown.includes('---\n先分析依赖。'));
});

test('renderProgressMarkdown 无思考无工具无文本时仍渲染头部', () => {
  const markdown = renderProgressMarkdown(createSnapshot(), 5);

  assert.ok(markdown.includes('⏳ 进行中 · 5s'));
});

test('extractToolDigest 按字段优先级提取摘要：command 首行、file_path 取 basename、pattern、query、url', () => {
  assert.equal(extractToolDigest('Bash', { command: 'npm test\n--reporter dot', description: '跑测试' }), 'npm test');
  assert.equal(extractToolDigest('Read', { file_path: '/root/workspace/src/bridge.mjs' }), 'bridge.mjs');
  assert.equal(extractToolDigest('Grep', { pattern: 'replyStream' }), 'replyStream');
  assert.equal(extractToolDigest('WebSearch', { query: '企微 markdown 文档' }), '企微 markdown 文档');
  assert.equal(extractToolDigest('WebFetch', { url: 'https://example.com/doc' }), 'https://example.com/doc');
});

test('extractToolDigest 无已知字段时回退到 JSON 摘要，空输入回退占位符', () => {
  assert.equal(extractToolDigest('Custom', { magic: 42 }), '{"magic":42}');
  assert.equal(extractToolDigest('Bash', {}), '（无参数）');
});

test('extractToolDigest 超长摘要截断到 60 字符', () => {
  const digest = extractToolDigest('Bash', { command: 'x'.repeat(200) });

  assert.equal(digest, `${'x'.repeat(59)}…`);
});
