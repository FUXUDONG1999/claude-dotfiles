import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ThrottledStreamReply, truncateTextToByteLimit, WECOM_STREAM_CONTENT_BYTE_LIMIT } from '../src/wecom-channel.mjs';

function createSendRecorder() {
  const sentFrames = [];

  return {
    sentFrames,
    sendFunction: async (content, finish) => {
      sentFrames.push({ content, finish });
    },
  };
}

test('truncateTextToByteLimit 保留未超限原文', () => {
  assert.equal(truncateTextToByteLimit('你好，世界'), '你好，世界');
});

test('truncateTextToByteLimit 按字节截断并追加提示', () => {
  const longText = '修'.repeat(20000);
  const truncatedText = truncateTextToByteLimit(longText, WECOM_STREAM_CONTENT_BYTE_LIMIT);

  assert.ok(Buffer.byteLength(truncatedText, 'utf8') <= WECOM_STREAM_CONTENT_BYTE_LIMIT);
  assert.ok(truncatedText.includes('截断'));
});

test('ThrottledStreamReply 在间隔内多次 push 只发出节流后的帧并以 finish 收尾', async () => {
  const recorder = createSendRecorder();
  const reply = new ThrottledStreamReply({
    sendFunction: recorder.sendFunction,
    intervalMilliseconds: 80,
    hardDeadlineMilliseconds: 60_000,
    hardDeadlineNoticeText: '仍在运行',
    activeChatIdentifier: 'user-1',
    activeChatPushFunction: async () => {},
  });

  reply.push('第一段');
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
  reply.push('第一段\n\n第二段');
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10));
  await reply.finish('最终结果');

  assert.equal(recorder.sentFrames.length, 2);
  assert.equal(recorder.sentFrames[0].content, '第一段');
  assert.equal(recorder.sentFrames[0].finish, false);
  assert.equal(recorder.sentFrames[1].content, '最终结果');
  assert.equal(recorder.sentFrames[1].finish, true);
});

test('ThrottledStreamReply 硬截止后提前 finish，后续结果改走主动推送通道', async () => {
  const recorder = createSendRecorder();
  const pushedMessages = [];
  const reply = new ThrottledStreamReply({
    sendFunction: recorder.sendFunction,
    intervalMilliseconds: 10,
    hardDeadlineMilliseconds: 40,
    hardDeadlineNoticeText: '任务仍在运行',
    activeChatIdentifier: 'chat-9',
    activeChatPushFunction: async (chatIdentifier, content) => {
      pushedMessages.push({ chatIdentifier, content });
    },
  });

  reply.push('进行中');
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 80));

  assert.ok(recorder.sentFrames.some((frame) => frame.finish === true));
  assert.ok(recorder.sentFrames.some((frame) => frame.content.includes('任务仍在运行')));

  await reply.finish('真正的最终结果');
  assert.equal(pushedMessages.length, 1);
  assert.equal(pushedMessages[0].chatIdentifier, 'chat-9');
  assert.equal(pushedMessages[0].content, '真正的最终结果');
});
