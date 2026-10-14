import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createBridge } from '../src/bridge.mjs';
import { SessionStore } from '../src/session-store.mjs';

const SIX_HOURS = 6 * 3600_000;

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

function createBridgeFixture({
  allowedUserIds = ['dong'],
  chatSessionContinuationEnabled = false,
  heartbeatIntervalMilliseconds = 0,
  useRealTaskQueue = false,
  maxConcurrentTasks = 3,
  claudeTaskRunner,
} = {}) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'wecom-bridge-test-'));
  let currentTime = 1_000;

  const sessionStore = new SessionStore(join(stateDirectory, 'state.json'), () => currentTime);
  const sentFrames = [];
  const activeMessages = [];
  const capturedRunnerOptions = [];

  const bridge = createBridge({
    configuration: {
      allowedUserIds: new Set(allowedUserIds),
      chatSessionContinuationEnabled,
      sessionTtlMilliseconds: SIX_HOURS,
      defaultWorkingDirectory: '/tmp',
      streamIntervalMilliseconds: 10,
      streamHardDeadlineMilliseconds: 60_000,
      hardDeadlineNoticeText: '任务仍在运行，完成后另行推送',
      heartbeatIntervalMilliseconds,
      drainTimeoutMilliseconds: 2_000,
      maxConcurrentTasks,
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
    claudeTaskRunner: claudeTaskRunner ?? (async (runnerOptions) => {
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
    }),
    taskQueueFactory: useRealTaskQueue ? undefined : (maxConcurrentTasks) => {
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
    stateDirectory,
    advanceClock: (milliseconds) => {
      currentTime += milliseconds;
    },
    cleanup: () => rmSync(stateDirectory, { recursive: true, force: true }),
  };
}

function finishFramesOf(fixture) {
  return fixture.sentFrames.filter((frame) => frame.finish === true);
}

function allRepliedTextOf(fixture) {
  return fixture.sentFrames.map((frame) => frame.content).join('\n');
}

test('createBridge 白名单外的发送者被忽略', async () => {
  const fixture = createBridgeFixture();

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ userId: 'stranger', content: '偷跑' }));

    assert.equal(fixture.sentFrames.length, 0);
    assert.equal(fixture.sessionStore.getRecord('single:dong'), null);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 正常任务：流式进度 + finish 收尾；续接开关关闭时不写会话记录', async () => {
  const fixture = createBridgeFixture();

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '跑一下测试' }));

    const finishFrames = finishFramesOf(fixture);
    assert.equal(finishFrames.length, 1);
    assert.ok(finishFrames[0].content.includes('任务完成的结果'));
    // 成本展示已移除：自备模型后端不按 Claude 计费，耗时后不再跟美元金额。
    assert.ok(finishFrames[0].content.includes('✅ 耗时 0.5s'));
    assert.ok(!finishFrames[0].content.includes('$'));
    assert.ok(fixture.sentFrames.some((frame) => frame.content.includes('中间进度')));

    assert.equal(fixture.sessionStore.getRecord('single:dong'), null);
    assert.equal(fixture.capturedRunnerOptions[0].resumeSessionId, null);
    assert.equal(fixture.capturedRunnerOptions[0].workingDirectory, '/tmp');
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 续接开关关闭时即使存有当前会话也不续接、不改动记录', async () => {
  const fixture = createBridgeFixture();

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'old-session', firstPrompt: '旧问题' });
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '新任务' }));

    assert.equal(fixture.capturedRunnerOptions[0].resumeSessionId, null);
    assert.equal(fixture.sessionStore.getRecord('single:dong').active.sessionId, 'old-session');
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 续接开关开启、TTL 内：自动续接并刷新闲置计时', async () => {
  const fixture = createBridgeFixture({ chatSessionContinuationEnabled: true });

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'old-session', firstPrompt: '旧问题' });
    fixture.advanceClock(3600_000);

    await fixture.bridge.handleTextMessage(createTextFrame({ content: '继续任务' }));

    assert.equal(fixture.capturedRunnerOptions[0].resumeSessionId, 'old-session');

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.active.sessionId, 'old-session');
    assert.equal(record.active.lastActiveAt, 1_000 + 3600_000);
    assert.deepEqual(record.history, []);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 续接开关开启、闲置超过 TTL：提示开新会话，旧会话降级进历史', async () => {
  const fixture = createBridgeFixture({ chatSessionContinuationEnabled: true });

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'old-session', firstPrompt: '旧问题' });
    fixture.advanceClock(SIX_HOURS + 1);

    await fixture.bridge.handleTextMessage(createTextFrame({ content: '全新问题' }));

    assert.equal(fixture.capturedRunnerOptions[0].resumeSessionId, null);
    assert.ok(allRepliedTextOf(fixture).includes('6 小时'));
    assert.ok(allRepliedTextOf(fixture).includes('/resume'));

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.active.sessionId, 'session-integration-1');
    assert.equal(record.active.firstPrompt, '全新问题');
    assert.deepEqual(
      record.history.map((entry) => entry.sessionId),
      ['old-session'],
    );
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 任务失败时当前会话自愈降级进历史', async () => {
  const fixture = createBridgeFixture({ chatSessionContinuationEnabled: true });
  fixture.bridge.dependencies.claudeTaskRunner = async () => ({
    success: false,
    sessionId: 'old-session',
    resultText: 'claude 进程异常退出',
    costUsd: null,
    durationMilliseconds: 100,
    timedOut: false,
    exitCode: 1,
  });

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'old-session', firstPrompt: '旧问题' });
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '任何任务' }));

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.active, null);
    assert.deepEqual(
      record.history.map((entry) => entry.sessionId),
      ['old-session'],
    );
  } finally {
    fixture.cleanup();
  }
});

function createStoppedTaskResult() {
  return {
    success: false,
    stopped: true,
    timedOut: false,
    sessionId: 'session-stopped',
    resultText: '任务已被手动终止（运行 5 秒）。终止前的产出：\n\n部分产出',
    costUsd: null,
    durationMilliseconds: 5_000,
    exitCode: null,
  };
}

test('createBridge /stop 对运行中的任务发出终止信号并回复确认', async () => {
  const fixture = createBridgeFixture({
    useRealTaskQueue: true,
    claudeTaskRunner: (runnerOptions) => new Promise((resolveTask) => {
      // 模拟真实 runner 契约：注册终止句柄，被调用时进程退出并产出 stopped 结果。
      // 2 秒安全兜底：/stop 未生效（回归）时也让任务收尾，避免悬挂定时器拖住测试进程。
      const safetyTimer = setTimeout(() => resolveTask(createStoppedTaskResult()), 2_000);
      runnerOptions.onStopReady(() => {
        clearTimeout(safetyTimer);
        resolveTask(createStoppedTaskResult());
      });
    }),
  });

  try {
    const handlePromise = fixture.bridge.handleTextMessage(createTextFrame({ content: '跑偏的任务' }));

    await waitForBridgeCondition(() => fixture.bridge.taskQueue.getStatus().runningCount === 1);

    await fixture.bridge.handleTextMessage(createTextFrame({ content: '/stop' }));

    assert.ok(allRepliedTextOf(fixture).includes('终止信号'), `期望包含终止信号确认，实际回复：${allRepliedTextOf(fixture)}`);

    await handlePromise;

    const finishFrames = finishFramesOf(fixture);
    assert.ok(finishFrames.some((frame) => frame.content.includes('手动终止')));
    assert.ok(finishFrames.some((frame) => frame.content.includes('🛑')));
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /stop 空闲时回复没有运行中的任务', async () => {
  const fixture = createBridgeFixture();

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '/stop' }));

    assert.ok(allRepliedTextOf(fixture).includes('没有运行中的任务'));
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /stop 对排队中（尚未开始）的任务提示无法提前终止', async () => {
  let releaseBlockingTask;
  const fixture = createBridgeFixture({
    useRealTaskQueue: true,
    maxConcurrentTasks: 1,
    claudeTaskRunner: (runnerOptions) => {
      if (runnerOptions.prompt === '占用槽位的任务') {
        return new Promise((resolveTask) => {
          releaseBlockingTask = resolveTask;
        });
      }

      return Promise.resolve(createBlockingTaskResult());
    },
  });

  try {
    const blockingHandlePromise = fixture.bridge.handleTextMessage(
      createTextFrame({ chatId: 'room-a', content: '占用槽位的任务' }),
    );

    await waitForBridgeCondition(() => fixture.bridge.taskQueue.getStatus().runningCount === 1);

    // B 的消息入队但不 await：enqueue 返回的 Promise 要等任务真正跑完才会 resolve
    const queuedHandlePromise = fixture.bridge.handleTextMessage(createTextFrame({ chatId: 'room-b', content: '排队任务' }));

    await waitForBridgeCondition(() => fixture.bridge.taskQueue.getStatus().chatQueueLength('room-b') === 1);

    await fixture.bridge.handleTextMessage(createTextFrame({ chatId: 'room-b', content: '/stop' }));

    assert.ok(allRepliedTextOf(fixture).includes('尚未开始'), `期望包含排队提示，实际回复：${allRepliedTextOf(fixture)}`);

    releaseBlockingTask(createBlockingTaskResult());
    await blockingHandlePromise;
    await queuedHandlePromise;
  } finally {
    releaseBlockingTask?.(createBlockingTaskResult());
    fixture.cleanup();
  }
});

test('createBridge 手动终止的任务不降级当前会话（续接场景）', async () => {
  const fixture = createBridgeFixture({
    chatSessionContinuationEnabled: true,
    claudeTaskRunner: async () => createStoppedTaskResult(),
  });

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'old-session', firstPrompt: '旧问题' });
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '跑偏的任务' }));

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.active.sessionId, 'old-session');
    assert.deepEqual(record.history, []);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 手动终止的任务仍建立当前会话（新会话场景）', async () => {
  const fixture = createBridgeFixture({
    chatSessionContinuationEnabled: true,
    claudeTaskRunner: async () => createStoppedTaskResult(),
  });

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '跑偏的任务' }));

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.active.sessionId, 'session-stopped');
    assert.equal(record.active.firstPrompt, '跑偏的任务');
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /new 命令把当前会话降级进历史、保留工作目录并回复确认', async () => {
  const fixture = createBridgeFixture();

  try {
    fixture.sessionStore.setWorkingDirectory('single:dong', '/tmp');
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'old-session', firstPrompt: '旧问题' });
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '/new' }));

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.active, null);
    assert.equal(record.workingDirectory, '/tmp');
    assert.deepEqual(
      record.history.map((entry) => entry.sessionId),
      ['old-session'],
    );
    assert.ok(finishFramesOf(fixture).some((frame) => frame.content.includes('新会话')));
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /cwd 命令切换目录并重置当前会话', async () => {
  const fixture = createBridgeFixture();

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'old-session', firstPrompt: '旧问题' });
    await fixture.bridge.handleTextMessage(createTextFrame({ content: `/cwd ${fixture.stateDirectory}` }));

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.workingDirectory, fixture.stateDirectory);
    assert.equal(record.active, null);
    assert.ok(finishFramesOf(fixture).some((frame) => frame.content.includes(fixture.stateDirectory)));
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 任务抛错时回复错误并把当前会话降级进历史', async () => {
  const fixture = createBridgeFixture();
  fixture.bridge.dependencies.claudeTaskRunner = async () => {
    throw new Error('claude binary not found');
  };
  fixture.sessionStore.activateSession('single:dong', { sessionId: 'old-session', firstPrompt: '旧问题' });

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '任何任务' }));

    const finishFrames = finishFramesOf(fixture);
    assert.equal(finishFrames.length, 1);
    assert.ok(finishFrames[0].content.includes('❌'));

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.active, null);
    assert.deepEqual(
      record.history.map((entry) => entry.sessionId),
      ['old-session'],
    );
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /resume 列出当前会话与历史会话（含首问摘要与序号）', async () => {
  const fixture = createBridgeFixture({ chatSessionContinuationEnabled: true });

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'session-a', firstPrompt: '激活函数是什么' });
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'session-b', firstPrompt: '模型蒸馏怎么推导' });
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'session-current', firstPrompt: '正在聊的问题' });

    await fixture.bridge.handleTextMessage(createTextFrame({ content: '/resume' }));

    const repliedText = allRepliedTextOf(fixture);
    assert.ok(repliedText.includes('正在聊的问题'));
    assert.ok(repliedText.includes('1.'));
    assert.ok(repliedText.includes('模型蒸馏怎么推导'));
    assert.ok(repliedText.includes('2.'));
    assert.ok(repliedText.includes('激活函数是什么'));
    assert.ok(repliedText.includes('/resume 序号'));
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /resume 把刚过期的当前会话降级为历史第 1 条', async () => {
  const fixture = createBridgeFixture({ chatSessionContinuationEnabled: true });

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'session-current', firstPrompt: '过期的问题' });
    fixture.advanceClock(SIX_HOURS + 1);

    await fixture.bridge.handleTextMessage(createTextFrame({ content: '/resume' }));

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.active, null);
    assert.deepEqual(
      record.history.map((entry) => entry.sessionId),
      ['session-current'],
    );

    const repliedText = allRepliedTextOf(fixture);
    assert.ok(repliedText.includes('1.'));
    assert.ok(repliedText.includes('过期的问题'));
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /resume 无任何会话时回复暂无提示', async () => {
  const fixture = createBridgeFixture({ chatSessionContinuationEnabled: true });

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '/resume' }));

    assert.ok(allRepliedTextOf(fixture).includes('暂无可恢复的会话'));
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /resume 序号恢复指定历史会话并重置闲置计时', async () => {
  const fixture = createBridgeFixture({ chatSessionContinuationEnabled: true });

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'session-a', firstPrompt: '激活函数是什么' });
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'session-b', firstPrompt: '模型蒸馏怎么推导' });
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'session-c', firstPrompt: '当前正在聊的问题' });
    fixture.advanceClock(60_000);

    await fixture.bridge.handleTextMessage(createTextFrame({ content: '/resume 2' }));

    const record = fixture.sessionStore.getRecord('single:dong');
    assert.equal(record.active.sessionId, 'session-a');
    assert.equal(record.active.firstPrompt, '激活函数是什么');
    assert.equal(record.active.lastActiveAt, 1_000 + 60_000);
    assert.deepEqual(
      record.history.map((entry) => entry.sessionId),
      ['session-c', 'session-b'],
    );
    assert.ok(allRepliedTextOf(fixture).includes('已恢复'));

    await fixture.bridge.handleTextMessage(createTextFrame({ content: '接着聊' }));
    assert.equal(fixture.capturedRunnerOptions[0].resumeSessionId, 'session-a');
  } finally {
    fixture.cleanup();
  }
});

test('createBridge /resume 序号超出范围时回复范围提示', async () => {
  const fixture = createBridgeFixture({ chatSessionContinuationEnabled: true });

  try {
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'session-a', firstPrompt: '激活函数是什么' });
    fixture.sessionStore.activateSession('single:dong', { sessionId: 'session-b', firstPrompt: '模型蒸馏怎么推导' });

    await fixture.bridge.handleTextMessage(createTextFrame({ content: '/resume 5' }));

    assert.ok(allRepliedTextOf(fixture).includes('超出范围'));
    assert.equal(fixture.sessionStore.getRecord('single:dong').active.sessionId, 'session-b');
  } finally {
    fixture.cleanup();
  }
});

async function waitForBridgeCondition(conditionFunction, timeoutMilliseconds = 2_000) {
  const startedAtMilliseconds = Date.now();

  while (!conditionFunction()) {
    if (Date.now() - startedAtMilliseconds > timeoutMilliseconds) {
      throw new Error('等待条件超时');
    }

    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5));
  }
}

function createBlockingTaskResult() {
  return {
    success: true,
    sessionId: 'session-blocking',
    resultText: '阻塞任务完成',
    costUsd: 0.01,
    durationMilliseconds: 100,
    timedOut: false,
    exitCode: 0,
  };
}

test('createBridge beginDrain 后新消息收到维护提示且不执行任务', async () => {
  const fixture = createBridgeFixture();

  try {
    fixture.bridge.beginDrain();
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '新任务' }));

    assert.ok(allRepliedTextOf(fixture).includes('重启维护'));
    assert.equal(fixture.capturedRunnerOptions.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge shutdown 空闲时立即返回 idle 且无中断通知', async () => {
  const fixture = createBridgeFixture({ useRealTaskQueue: true });

  try {
    const result = await fixture.bridge.shutdown({ drainTimeoutMilliseconds: 100 });

    assert.equal(result.idle, true);
    assert.deepEqual(result.interruptedChatIdentifiers, []);
    assert.equal(fixture.activeMessages.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge shutdown 等待运行中任务自然完成，不打扰会话', async () => {
  let releaseBlockingTask;
  const fixture = createBridgeFixture({
    useRealTaskQueue: true,
    claudeTaskRunner: () => new Promise((resolveTask) => {
      releaseBlockingTask = resolveTask;
    }),
  });

  try {
    const handlePromise = fixture.bridge.handleTextMessage(createTextFrame({ content: '慢任务' }));

    await waitForBridgeCondition(() => fixture.bridge.taskQueue.getStatus().runningCount === 1);

    const shutdownPromise = fixture.bridge.shutdown({ drainTimeoutMilliseconds: 2_000 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));

    releaseBlockingTask(createBlockingTaskResult());
    const result = await shutdownPromise;
    await handlePromise;

    assert.equal(result.idle, true);
    assert.equal(fixture.activeMessages.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge shutdown 超时后向运行中任务的会话推送中断通知（含 /resume 提示）', async () => {
  let releaseBlockingTask;
  const fixture = createBridgeFixture({
    useRealTaskQueue: true,
    claudeTaskRunner: () => new Promise((resolveTask) => {
      releaseBlockingTask = resolveTask;
    }),
  });

  try {
    const handlePromise = fixture.bridge.handleTextMessage(createTextFrame({ content: '慢任务' }));

    await waitForBridgeCondition(() => fixture.bridge.taskQueue.getStatus().runningCount === 1);

    const result = await fixture.bridge.shutdown({ drainTimeoutMilliseconds: 50 });

    assert.equal(result.idle, false);
    assert.deepEqual(result.interruptedChatIdentifiers, ['single:dong']);
    assert.equal(fixture.activeMessages.length, 1);
    assert.equal(fixture.activeMessages[0].chatIdentifier, 'dong');
    assert.ok(fixture.activeMessages[0].body.markdown.content.includes('/resume'));

    releaseBlockingTask(createBlockingTaskResult());
    await handlePromise;
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 任务静默超过心跳间隔时推送"仍在工作"心跳', async () => {
  const fixture = createBridgeFixture({
    heartbeatIntervalMilliseconds: 60,
    claudeTaskRunner: async (runnerOptions) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));

      return createBlockingTaskResult();
    },
  });

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '安静的任务' }));

    const heartbeats = fixture.activeMessages.filter((message) => message.body.markdown.content.includes('仍在工作'));

    assert.ok(heartbeats.length >= 1, `期望至少一条心跳，实际推送：${JSON.stringify(fixture.activeMessages)}`);
  } finally {
    fixture.cleanup();
  }
});

test('createBridge 任务持续有进度时不推送心跳', async () => {
  const fixture = createBridgeFixture({
    heartbeatIntervalMilliseconds: 60,
    claudeTaskRunner: async (runnerOptions) => {
      for (let index = 0; index < 8; index += 1) {
        runnerOptions.onProgressText(`进度 ${index}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }

      return createBlockingTaskResult();
    },
  });

  try {
    await fixture.bridge.handleTextMessage(createTextFrame({ content: '热闹的任务' }));

    const heartbeats = fixture.activeMessages.filter((message) => message.body.markdown.content.includes('仍在工作'));

    assert.equal(heartbeats.length, 0);
  } finally {
    fixture.cleanup();
  }
});
