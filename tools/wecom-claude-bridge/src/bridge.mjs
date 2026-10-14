import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { interpretCommand } from './command-interpreter.mjs';
import { runClaudeTask } from './claude-runner.mjs';
import { ChatTaskQueue } from './task-queue.mjs';
import { ThrottledStreamReply } from './wecom-channel.mjs';

// 组装层：企微消息事件 → 白名单 → 命令/任务分流 → Claude 执行 → 流式回推。
// 各依赖经参数注入（wsClientAdapter / claudeTaskRunner / taskQueueFactory / sessionStore 均可替换为测试替身）。
export function createBridge(dependencies) {
  const bridgeState = {
    dependencies,
    configuration: dependencies.configuration,
    logger: dependencies.logger,
    sessionStore: dependencies.sessionStore,
    wsClientAdapter: dependencies.wsClientAdapter,
    logWriter: dependencies.logWriter,
    draining: false,
    activeTasks: new Map(),
    taskQueue: dependencies.taskQueueFactory
      ? dependencies.taskQueueFactory(dependencies.configuration.maxConcurrentTasks)
      : new ChatTaskQueue(dependencies.configuration.maxConcurrentTasks),
  };

  return {
    dependencies: bridgeState.dependencies,
    taskQueue: bridgeState.taskQueue,

    handleTextMessage: (frame) => handleTextMessage(bridgeState, frame),
    handleEnterChatEvent: (frame) => handleEnterChatEvent(bridgeState, frame),
    beginDrain: () => {
      bridgeState.draining = true;
    },
    shutdown: (shutdownOptions) => shutdownBridge(bridgeState, shutdownOptions),
  };
}

async function handleTextMessage(bridgeState, frame) {
  const messageBody = frame.body ?? {};
  const senderUserId = messageBody.from?.userid;

  if (!bridgeState.configuration.allowedUserIds.has(senderUserId)) {
    bridgeState.logger.warn(`已忽略未授权用户的消息：${senderUserId}`);

    return;
  }

  const messageContent = (messageBody.text?.content ?? '').trim();

  if (!messageContent) {
    return;
  }

  if (bridgeState.draining) {
    await sendSingleReply(bridgeState, frame, '🔄 服务正在重启维护，暂不接收新消息；运行中的任务会继续完成，稍后请重发。');

    return;
  }

  const chatIdentifier = messageBody.chatid ?? `single:${senderUserId}`;
  const activeChatIdentifier = messageBody.chatid ?? senderUserId;
  const command = interpretCommand(messageContent);

  if (command) {
    await executeCommand(bridgeState, frame, command, chatIdentifier);

    return;
  }

  const queueStatus = bridgeState.taskQueue.getStatus();
  const queuedCount = queueStatus.chatQueueLength(chatIdentifier);

  if (queuedCount > 0) {
    await sendSingleReply(bridgeState, frame, `⏳ 当前会话还有 ${queuedCount} 个任务在排队，新任务已加入队列。`);
  }

  await bridgeState.taskQueue.enqueue(
    chatIdentifier,
    () => executeClaudeTask(bridgeState, frame, chatIdentifier, activeChatIdentifier, messageContent),
  );
}

async function handleEnterChatEvent(bridgeState, frame) {
  await bridgeState.wsClientAdapter.replyWelcome(frame, {
    msgtype: 'text',
    text: { content: '你好，我是 Claude 远程助手。直接发消息即可下达任务；6 小时内自动续聊，/resume 恢复历史会话，/new 重开，/cwd 切换目录，/stop 终止运行中任务，/status 查看队列。' },
  });
}

async function executeCommand(bridgeState, frame, command, chatIdentifier) {
  if (command.name === 'resetSession') {
    bridgeState.sessionStore.demoteActiveSession(chatIdentifier);
    await sendSingleReply(bridgeState, frame, '🆕 已开启新会话；上一会话已存入历史，发 /resume 可找回。');

    return;
  }

  if (command.name === 'listResumableSessions') {
    await executeResumeListCommand(bridgeState, frame, chatIdentifier);

    return;
  }

  if (command.name === 'selectResumableSession') {
    await executeResumeSelectCommand(bridgeState, frame, chatIdentifier, command.index);

    return;
  }

  if (command.name === 'setWorkingDirectory') {
    await executeSetWorkingDirectoryCommand(bridgeState, frame, chatIdentifier, command.workingDirectory);

    return;
  }

  if (command.name === 'stopTask') {
    await executeStopTaskCommand(bridgeState, frame, chatIdentifier);

    return;
  }

  if (command.name === 'queryStatus') {
    const queueStatus = bridgeState.taskQueue.getStatus();
    await sendSingleReply(
      bridgeState,
      frame,
      `📊 任务运行中：${queueStatus.runningCount} 个，排队中：${queueStatus.queuedTaskCount} 个。`,
    );
  }
}

async function executeResumeListCommand(bridgeState, frame, chatIdentifier) {
  const configuration = bridgeState.configuration;
  bridgeState.sessionStore.resolveActiveSession(chatIdentifier, configuration.sessionTtlMilliseconds);

  const record = bridgeState.sessionStore.getRecord(chatIdentifier);
  const activeSession = record?.active ?? null;
  const history = record?.history ?? [];

  if (!activeSession && history.length === 0) {
    await sendSingleReply(bridgeState, frame, '📭 暂无可恢复的会话，先发条消息开始对话吧。');

    return;
  }

  const lines = ['📖 可恢复的历史会话（发送 /resume 序号 恢复）：'];

  if (activeSession) {
    lines.push(`🔵 当前会话：首问「${activeSession.firstPrompt ?? '（未知）'}」 · 自动续聊中`);
  }

  history.forEach((entry, index) => {
    lines.push(`${index + 1}. 首问「${entry.firstPrompt ?? '（未知）'}」 · ${formatRelativeTime(entry.endedAt)}`);
  });

  if (history.length === 0) {
    lines.push('（暂无历史会话）');
  }

  await sendSingleReply(bridgeState, frame, lines.join('\n'));
}

async function executeResumeSelectCommand(bridgeState, frame, chatIdentifier, index) {
  const configuration = bridgeState.configuration;
  bridgeState.sessionStore.resolveActiveSession(chatIdentifier, configuration.sessionTtlMilliseconds);

  const history = bridgeState.sessionStore.getRecord(chatIdentifier)?.history ?? [];

  if (history.length === 0) {
    await sendSingleReply(bridgeState, frame, '❌ 暂无可恢复的历史会话。');

    return;
  }

  const selectedEntry = history[index - 1];

  if (!selectedEntry) {
    await sendSingleReply(bridgeState, frame, `❌ 序号超出范围（现有 ${history.length} 条），发 /resume 查看列表。`);

    return;
  }

  bridgeState.sessionStore.activateSession(chatIdentifier, {
    sessionId: selectedEntry.sessionId,
    firstPrompt: selectedEntry.firstPrompt ?? '',
  });
  await sendSingleReply(
    bridgeState,
    frame,
    `↩️ 已恢复会话 ${index}（首问「${selectedEntry.firstPrompt ?? '（未知）'}」）。直接发消息继续，闲置计时已重置。`,
  );
}

async function executeSetWorkingDirectoryCommand(bridgeState, frame, chatIdentifier, requestedDirectory) {
  const targetDirectory = resolve(requestedDirectory);

  if (!existsSync(targetDirectory) || !statSync(targetDirectory).isDirectory()) {
    await sendSingleReply(bridgeState, frame, `❌ 目录不存在：${targetDirectory}`);

    return;
  }

  bridgeState.sessionStore.setWorkingDirectory(chatIdentifier, targetDirectory);
  await sendSingleReply(bridgeState, frame, `📁 工作目录已切换到 ${targetDirectory}，当前会话已重置（/resume 可找回）。`);
}

// /stop：优先终止运行中的任务；排队中的任务尚未开始、无法提前取消；空闲时如实相告。
async function executeStopTaskCommand(bridgeState, frame, chatIdentifier) {
  const activeTaskEntry = bridgeState.activeTasks.get(chatIdentifier);

  if (activeTaskEntry?.stopFunction) {
    activeTaskEntry.stopFunction();
    await sendSingleReply(bridgeState, frame, '🛑 已发出终止信号，正在停止当前任务；终止前的产出会随后推送，会话保留、可直接继续。');

    return;
  }

  const queueStatus = bridgeState.taskQueue.getStatus();

  if (queueStatus.chatQueueLength(chatIdentifier) > 0) {
    await sendSingleReply(bridgeState, frame, '⏳ 该会话的任务还在排队中（尚未开始执行），暂无法终止；等它开始后再发 /stop。');

    return;
  }

  await sendSingleReply(bridgeState, frame, 'ℹ️ 当前没有运行中的任务。');
}

async function executeClaudeTask(bridgeState, frame, chatIdentifier, activeChatIdentifier, messageContent) {
  const configuration = bridgeState.configuration;
  const record = bridgeState.sessionStore.getRecord(chatIdentifier);
  const workingDirectory = record?.workingDirectory ?? configuration.defaultWorkingDirectory;
  const streamIdentifier = generateStreamIdentifier();
  const heartbeatMonitor = startHeartbeatMonitor(bridgeState, activeChatIdentifier);

  // stopFunction 由 runner 在子进程 spawn 后经 onStopReady 回填，/stop 命令据此终止任务。
  const activeTaskEntry = { activeChatIdentifier, stopFunction: null };
  bridgeState.activeTasks.set(chatIdentifier, activeTaskEntry);

  const reply = new ThrottledStreamReply({
    sendFunction: (content, finish) => bridgeState.wsClientAdapter.replyStream(frame, streamIdentifier, content, finish),
    intervalMilliseconds: configuration.streamIntervalMilliseconds,
    hardDeadlineMilliseconds: configuration.streamHardDeadlineMilliseconds,
    hardDeadlineNoticeText: configuration.hardDeadlineNoticeText,
    activeChatIdentifier,
    activeChatPushFunction: (chatIdentifierForPush, content) => bridgeState.wsClientAdapter.sendMessage(chatIdentifierForPush, {
      msgtype: 'markdown',
      markdown: { content },
    }),
  });

  const continuationEnabled = configuration.chatSessionContinuationEnabled;
  let resumeSessionId = null;
  let expiryNoticeText = null;

  if (continuationEnabled) {
    const resolvedSession = bridgeState.sessionStore.resolveActiveSession(
      chatIdentifier,
      configuration.sessionTtlMilliseconds,
    );

    if (resolvedSession.sessionId) {
      resumeSessionId = resolvedSession.sessionId;
    } else if (resolvedSession.expiredJustNow) {
      expiryNoticeText = `⏱️ 上次会话已闲置超过 ${formatHours(configuration.sessionTtlMilliseconds)} 小时，本轮从新会话开始；发 /resume 可恢复历史会话。`;
    }
  }

  // 提示须并入首条推送：push 是覆盖语义，单独推送会被紧随的进度文本顶掉。
  reply.push(
    expiryNoticeText ? `⏳ 已接收任务，Claude 开始执行…\n\n${expiryNoticeText}` : '⏳ 已接收任务，Claude 开始执行…',
  );

  try {
    const taskRunner = bridgeState.dependencies.claudeTaskRunner ?? runClaudeTask;
    const taskResult = await taskRunner({
      prompt: messageContent,
      resumeSessionId,
      workingDirectory,
      configuration: {
        claudeBinaryPath: configuration.claudeBinaryPath,
        permissionMode: configuration.permissionMode,
        allowedTools: configuration.allowedTools,
        taskTimeoutMilliseconds: configuration.taskTimeoutMilliseconds,
      },
      onProgressText: (progressText) => {
        heartbeatMonitor?.markProgress();
        reply.push(progressText);
      },
      onStopReady: (stopFunction) => {
        activeTaskEntry.stopFunction = stopFunction;
      },
    });

    heartbeatMonitor?.stop();
    await reply.finish(decorateTaskResultText(taskResult));
    persistSessionAfterTask(bridgeState, chatIdentifier, {
      continuationEnabled,
      resumeSessionId,
      taskResult,
      messageContent,
    });

    await bridgeState.logWriter.appendTaskRecord({
      messageId: frame.body?.msgid,
      chatIdentifier,
      prompt: messageContent,
      taskResult,
    });
  } catch (error) {
    bridgeState.logger.error('任务执行异常', error);
    bridgeState.sessionStore.demoteActiveSession(chatIdentifier);
    await reply.finish(`❌ 任务执行异常：${error.message}`);
  } finally {
    heartbeatMonitor?.stop();
    bridgeState.activeTasks.delete(chatIdentifier);
  }
}

// 静默心跳：任务长时间无新输出时主动推送「仍在工作」，替代用户发消息探测。
// 返回 null 表示心跳未启用（间隔 ≤ 0）。
function startHeartbeatMonitor(bridgeState, activeChatIdentifier) {
  const intervalMilliseconds = bridgeState.configuration.heartbeatIntervalMilliseconds;

  if (!intervalMilliseconds || intervalMilliseconds <= 0) {
    return null;
  }

  let lastProgressAt = Date.now();

  const timer = setInterval(() => {
    const silentMilliseconds = Date.now() - lastProgressAt;

    if (silentMilliseconds < intervalMilliseconds) {
      return;
    }

    const silentDescription = silentMilliseconds < 60_000
      ? `${Math.round(silentMilliseconds / 1000)} 秒`
      : `${Math.round(silentMilliseconds / 60_000)} 分钟`;

    try {
      bridgeState.wsClientAdapter.sendMessage(activeChatIdentifier, {
        msgtype: 'markdown',
        markdown: { content: `⏳ 任务仍在工作（已静默 ${silentDescription}），完成后会自动推送结果，无需催促。` },
      }).catch((error) => bridgeState.logger.warn('心跳推送失败', error?.message ?? error));
    } catch (sendError) {
      bridgeState.logger.warn('心跳推送失败', sendError?.message ?? sendError);
    }
  }, intervalMilliseconds);

  return {
    markProgress: () => {
      lastProgressAt = Date.now();
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}

// 优雅停机：拒绝新任务 → 等待在途任务排空（上限可配）→ 超时的会话推送中断通知（指向 /resume）。
async function shutdownBridge(bridgeState, shutdownOptions = {}) {
  bridgeState.draining = true;

  const drainTimeoutMilliseconds = shutdownOptions.drainTimeoutMilliseconds
    ?? bridgeState.configuration.drainTimeoutMilliseconds;
  const drainResult = await bridgeState.taskQueue.waitForIdle(drainTimeoutMilliseconds);

  if (drainResult.idle) {
    return { idle: true, interruptedChatIdentifiers: [] };
  }

  const interruptedChatIdentifiers = [...bridgeState.activeTasks.keys()];

  for (const { activeChatIdentifier } of bridgeState.activeTasks.values()) {
    try {
      await bridgeState.wsClientAdapter.sendMessage(activeChatIdentifier, {
        msgtype: 'markdown',
        markdown: { content: '⚠️ 服务重启，正在运行的任务被中断；服务恢复后发 /resume 可恢复会话接着干，未完成的部分请重发指令。' },
      });
    } catch (error) {
      bridgeState.logger.error(`中断通知发送失败（${chatIdentifier}）`, error);
    }
  }

  return { idle: false, interruptedChatIdentifiers };
}

// 任务结束后的会话记录维护：失败自愈降级；手动终止视为有效产出，与成功同等落账；成功则按「续接→刷新计时 / 全新→建立当前会话」处理。
function persistSessionAfterTask(bridgeState, chatIdentifier, { continuationEnabled, resumeSessionId, taskResult, messageContent }) {
  if (!continuationEnabled) {
    return;
  }

  if (!taskResult.success && !taskResult.stopped) {
    bridgeState.sessionStore.demoteActiveSession(chatIdentifier);

    return;
  }

  if (resumeSessionId) {
    bridgeState.sessionStore.touchActiveSession(chatIdentifier);

    return;
  }

  if (taskResult.sessionId) {
    bridgeState.sessionStore.activateSession(chatIdentifier, {
      sessionId: taskResult.sessionId,
      firstPrompt: messageContent,
    });
  }
}

function decorateTaskResultText(taskResult) {
  const outcomeMarker = taskResult.success ? '✅' : taskResult.stopped ? '🛑' : taskResult.timedOut ? '⏱️' : '❌';
  const durationSeconds = (taskResult.durationMilliseconds / 1000).toFixed(1);

  // 不展示美元成本：本桥接用自备模型后端，Claude 计费口径无意义。
  return `${taskResult.resultText}\n\n---\n${outcomeMarker} 耗时 ${durationSeconds}s`;
}

function formatHours(milliseconds) {
  const hours = milliseconds / 3600_000;

  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return '时间未知';
  }

  const elapsedMilliseconds = Date.now() - timestamp;
  const elapsedMinutes = Math.round(elapsedMilliseconds / 60_000);

  if (elapsedMinutes < 1) {
    return '刚刚';
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} 分钟前`;
  }

  const elapsedHours = Math.round(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours} 小时前`;
  }

  return `${Math.round(elapsedHours / 24)} 天前`;
}

async function sendSingleReply(bridgeState, frame, content) {
  await bridgeState.wsClientAdapter.replyStream(frame, generateStreamIdentifier(), content, true);
}

function generateStreamIdentifier() {
  return `stream-${randomUUID()}`;
}
