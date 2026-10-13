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
    taskQueue: dependencies.taskQueueFactory
      ? dependencies.taskQueueFactory(dependencies.configuration.maxConcurrentTasks)
      : new ChatTaskQueue(dependencies.configuration.maxConcurrentTasks),
  };

  return {
    dependencies: bridgeState.dependencies,

    handleTextMessage: (frame) => handleTextMessage(bridgeState, frame),
    handleEnterChatEvent: (frame) => handleEnterChatEvent(bridgeState, frame),
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
    text: { content: '你好，我是 Claude 远程助手。直接发消息即可下达任务；6 小时内自动续聊，/resume 恢复历史会话，/new 重开，/cwd 切换目录，/status 查看队列。' },
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

async function executeClaudeTask(bridgeState, frame, chatIdentifier, activeChatIdentifier, messageContent) {
  const configuration = bridgeState.configuration;
  const record = bridgeState.sessionStore.getRecord(chatIdentifier);
  const workingDirectory = record?.workingDirectory ?? configuration.defaultWorkingDirectory;
  const streamIdentifier = generateStreamIdentifier();

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
      onProgressText: (progressText) => reply.push(progressText),
    });

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
  }
}

// 任务结束后的会话记录维护：失败自愈降级；成功则按「续接→刷新计时 / 全新→建立当前会话」落账。
function persistSessionAfterTask(bridgeState, chatIdentifier, { continuationEnabled, resumeSessionId, taskResult, messageContent }) {
  if (!continuationEnabled) {
    return;
  }

  if (!taskResult.success) {
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
  const outcomeMarker = taskResult.success ? '✅' : taskResult.timedOut ? '⏱️' : '❌';
  const durationSeconds = (taskResult.durationMilliseconds / 1000).toFixed(1);
  const costText = taskResult.costUsd != null ? ` · $${taskResult.costUsd.toFixed(4)}` : '';

  return `${taskResult.resultText}\n\n---\n${outcomeMarker} 耗时 ${durationSeconds}s${costText}`;
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
