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
    text: { content: '你好，我是 Claude 远程助手。直接发消息即可下达任务；/new 重开会话，/cwd 切换目录，/status 查看队列。' },
  });
}

async function executeCommand(bridgeState, frame, command, chatIdentifier) {
  if (command.name === 'resetSession') {
    bridgeState.sessionStore.removeSession(chatIdentifier);
    await sendSingleReply(bridgeState, frame, '🆕 已开启新会话，下一条消息将从全新 Claude 会话开始。');

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

async function executeSetWorkingDirectoryCommand(bridgeState, frame, chatIdentifier, requestedDirectory) {
  const targetDirectory = resolve(requestedDirectory);

  if (!existsSync(targetDirectory) || !statSync(targetDirectory).isDirectory()) {
    await sendSingleReply(bridgeState, frame, `❌ 目录不存在：${targetDirectory}`);

    return;
  }

  bridgeState.sessionStore.saveSession(chatIdentifier, { sessionId: null, workingDirectory: targetDirectory });
  await sendSingleReply(bridgeState, frame, `📁 工作目录已切换到 ${targetDirectory}，会话已重置。`);
}

async function executeClaudeTask(bridgeState, frame, chatIdentifier, activeChatIdentifier, messageContent) {
  const configuration = bridgeState.configuration;
  const storedSession = bridgeState.sessionStore.getSession(chatIdentifier);
  const workingDirectory = storedSession?.workingDirectory ?? configuration.defaultWorkingDirectory;
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

  reply.push('⏳ 已接收任务，Claude 开始执行…');

  const continuationEnabled = configuration.chatSessionContinuationEnabled;
  const resumeSessionId = continuationEnabled ? storedSession?.sessionId ?? null : null;

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

    if (continuationEnabled && taskResult.sessionId) {
      bridgeState.sessionStore.saveSession(chatIdentifier, { sessionId: taskResult.sessionId, workingDirectory });
    } else {
      bridgeState.sessionStore.saveSession(chatIdentifier, { sessionId: null, workingDirectory });
    }

    await bridgeState.logWriter.appendTaskRecord({
      messageId: frame.body?.msgid,
      chatIdentifier,
      prompt: messageContent,
      taskResult,
    });
  } catch (error) {
    bridgeState.logger.error('任务执行异常', error);
    await reply.finish(`❌ 任务执行异常：${error.message}`);
  }
}

function decorateTaskResultText(taskResult) {
  const outcomeMarker = taskResult.success ? '✅' : taskResult.timedOut ? '⏱️' : '❌';
  const durationSeconds = (taskResult.durationMilliseconds / 1000).toFixed(1);
  const costText = taskResult.costUsd != null ? ` · $${taskResult.costUsd.toFixed(4)}` : '';

  return `${taskResult.resultText}\n\n---\n${outcomeMarker} 耗时 ${durationSeconds}s${costText}`;
}

async function sendSingleReply(bridgeState, frame, content) {
  await bridgeState.wsClientAdapter.replyStream(frame, generateStreamIdentifier(), content, true);
}

function generateStreamIdentifier() {
  return `stream-${randomUUID()}`;
}
