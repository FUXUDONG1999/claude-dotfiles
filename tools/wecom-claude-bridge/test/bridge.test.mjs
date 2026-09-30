import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createBridge } from '../src/bridge.mjs';

function createTextFrame({ userId = 'dong', chatId = null, content }) {
  return {
    headers: { req_id: `req-${Math.random().toString(36).slice(2)}` },
    body: {
      msgid: `msgid-${Math.random().toString(36).slice(2)}`,
      chatid: chatId ?? undefined,
      chattype: chatId ? 'group' : 'single',
      from: { userid: userId },
      msgtype: 'text',
      text: { content },
    },
  };
}

function createBridgeFixture({ allowedUserIds = ['dong'], chatSessionContinuationEnabled = false } = {}) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'wecom-bridge-test-'));
  const sentFrames = [];
  const activeMessages = [];
  const capturedRunnerOptions = [];
  const sessionStore = new (class {
    constructor() {
      this.sessions = new Map();
    }

    getSession(chatIdentifier) {
      return this.sessions.get(chatIdentifier) ?? null;
    }

    saveSession(chatIdentifier, session) {
      this.sessions.set(chatIdentifier, session);
    }

    removeSession(chatIdentifier) {
      this.sessions.delete(chatIdentifier);
    }
  })();

  const bridge = createBridge({
    configuration: {
      allowedUserIds: new Set(allowedUserIds),
      chatSessionContinuationEnabled,
      defaultWorkingDirectory: '/tmp',
      streamIntervalMilliseconds: 10,
      streamHardDeadlineMilliseconds: 60_000,
      hardDeadlineNoticeText: '任务仍在运行，完成后另行推送',
      logDirectory: join(stateDirectory, 'logs'),
    },
    wsClientAdapter: {
      replyStream: async (frame, streamId, content, finish) => {
        sentFrames.push({ frame, streamId, content, finish });
      },
      sendMessage: async (chatIdentifier, body) => {
        activeMessages.push({ chatIdentifier, body });
      },
      replyWelcome: async () => {},
    },
    claudeTaskRunner: async (runnerOptions) => {
      capturedRunnerOptions.push(runnerOptions);
      runnerOptions.onProgressText('中间进度');
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 30));
      return {
        success: true,
        sessionId: 'session-integration-1',
        resultText: '任务完成的结果',
        costUsd: 0.01,
        durationMilliseconds: 500,
        timedOut: false,
        exitCode: 0,
      };
    },
    taskQueueFactory: (maxConcurrentTasks) => {
      const imported = new Map();

      return {
        enqueue: async (chatIdentifier, taskFunction) => {
          const chain = imported.get(chatIdentifier) ?? Promise.resolve();
          const nextInChain = chain.then(taskFunction);
          imported.set(chatIdentifier, nextInChain.catch(() => {}));
          return nextInChain;
        },
        getStatus: () => ({ runningCount: 0, queuedTaskCount: 0, chatQueueLength: () => 0 }),
        maxConcurrentTasks,
      };
    },
    sessionStore,
    logWriter: {
      appendTaskRecord: async () => {},
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  return {
    bridge,
    sentFrames,
    activeMessages,
    sessionStore,
    capturedRunnerOptions,
    cleanup: () => rmSync(stateDirectory, { recursive: true, force: true }),
  };
}

test('createBridge 白名单外的发送者被忽略', async () => {
  const fixture = createBridgeFixture();

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ userId: 'stranger', content: '偷跑' }));

    assert.equal(fixture.sentFrames.length, 0);
    assert.equal(fixture.sessionStore.sessions.size, 0);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 正常任务：流式进度 + finish 收尾 + 保存会话映射', async () => {
  const fixture = createBridgeFixture();

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '跑一下测试' }));

    const finishFrames = fixture.sentFrames.filter((frame) => frame.finish === true);
    assert.equal(finishFrames.length, 1);
    assert.ok(finishFrames[0].content.includes('任务完成的结果'));
    assert.ok(fixture.sentFrames.some((frame) => frame.content.includes('中间进度')));

    const savedSession = fixture.sessionStore.getSession('single:dong');
    assert.equal(savedSession.sessionId, null);
    assert.equal(savedSession.workingDirectory, '/tmp');
    assert.equal(fixture.capturedRunnerOptions[0].resumeSessionId, null);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 默认每条消息开全新 Claude 会话，即使存有旧 session 也不续接', async () => {
  const fixture = createBridgeFixture();

  try {
    fixture.sessionStore.saveSession('single:dong', { sessionId: 'old-session', workingDirectory: '/tmp' });
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '新任务' }));

    assert.equal(fixture.capturedRunnerOptions[0].resumeSessionId, null);
    assert.equal(fixture.sessionStore.getSession('single:dong').sessionId, null);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 开启续接开关时按会话续接并保存 session 映射', async () => {
  const fixture = createBridgeFixture({ chatSessionContinuationEnabled: true });

  try {
    fixture.sessionStore.saveSession('single:dong', { sessionId: 'old-session', workingDirectory: '/tmp' });
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '继续任务' }));

    assert.equal(fixture.capturedRunnerOptions[0].resumeSessionId, 'old-session');
    assert.equal(fixture.sessionStore.getSession('single:dong').sessionId, 'session-integration-1');
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /new 命令清除会话映射并回复确认', async () => {
  const fixture = createBridgeFixture();

  try {
    fixture.sessionStore.saveSession('single:dong', { sessionId: 'old-session', workingDirectory: '/tmp' });
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '/new' }));

    assert.equal(fixture.sessionStore.getSession('single:dong'), null);
    assert.ok(fixture.sentFrames.some((frame) => frame.finish === true && frame.content.includes('新会话')));
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 任务抛错时回复错误并保留旧会话', async () => {
  const fixture = createBridgeFixture();
  fixture.bridge.dependencies.claudeTaskRunner = async () => {
    throw new Error('claude binary not found');
  };
  fixture.sessionStore.saveSession('single:dong', { sessionId: 'old-session', workingDirectory: '/tmp' });

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '任何任务' }));

    const finishFrames = fixture.sentFrames.filter((frame) => frame.finish === true);
    assert.equal(finishFrames.length, 1);
    assert.ok(finishFrames[0].content.includes('❌'));
    assert.equal(fixture.sessionStore.getSession('single:dong').sessionId, 'old-session');
  } finally {
    fixture.cleanup();
  }
});
