import AiBot from '@wecom/aibot-node-sdk';
import { join } from 'node:path';

import { createBridge } from './bridge.mjs';
import { loadConfiguration } from './configuration.mjs';
import { TaskLogWriter } from './log-writer.mjs';
import { createLogger } from './logger.mjs';
import { SessionStore } from './session-store.mjs';

const logger = createLogger('bridge');
const configuration = loadConfiguration();
const wsClient = new AiBot.WSClient({
  botId: configuration.botId,
  secret: configuration.botSecret,
  maxReconnectAttempts: -1,
});

const bridge = createBridge({
  configuration,
  wsClientAdapter: {
    replyStream: (frame, streamIdentifier, content, finish) => wsClient.replyStream(frame, streamIdentifier, content, finish),
    sendMessage: (chatIdentifier, body) => wsClient.sendMessage(chatIdentifier, body),
    replyWelcome: (frame, body) => wsClient.replyWelcome(frame, body),
  },
  sessionStore: new SessionStore(join(configuration.stateDirectory, 'state.json')),
  logWriter: new TaskLogWriter(configuration.logDirectory),
  logger,
});

wsClient.on('message.text', (frame) => {
  bridge.handleTextMessage(frame).catch((error) => logger.error('处理消息失败', error));
});
wsClient.on('event.enter_chat', (frame) => {
  bridge.handleEnterChatEvent(frame).catch((error) => logger.error('处理进入会话事件失败', error));
});
wsClient.on('authenticated', () => logger.info('已通过企业微信认证，等待消息…'));
wsClient.on('reconnecting', (attempt) => logger.warn(`连接断开，第 ${attempt} 次重连中…`));
wsClient.on('error', (error) => logger.error('WebSocket 错误', error?.message ?? error));

wsClient.connect();

// 优雅停机：SIGTERM/SIGINT → 拒绝新任务 → 等待在途任务排空（上限 DRAIN_TIMEOUT_MINUTES）
// → 超时会话推送中断通知。再收一次信号则立即退出（逃生门）。
let shutdownStarted = false;

async function shutdownGracefully(signalName) {
  if (shutdownStarted) {
    logger.info('再次收到退出信号，立即退出。');
    process.exit(0);
  }

  shutdownStarted = true;
  logger.info(`收到 ${signalName}，开始排空运行中的任务（上限 ${Math.round(configuration.drainTimeoutMilliseconds / 60_000)} 分钟）…`);

  try {
    const shutdownResult = await bridge.shutdown();

    if (shutdownResult.idle) {
      logger.info('任务已全部排空，正常退出。');
    } else {
      logger.warn(`排空超时，${shutdownResult.interruptedChatIdentifiers.length} 个会话的任务被中断，已推送中断通知。`);
    }
  } catch (error) {
    logger.error('排空过程出错', error);
  }

  wsClient.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdownGracefully('SIGTERM');
});
process.on('SIGINT', () => {
  shutdownGracefully('SIGINT');
});
