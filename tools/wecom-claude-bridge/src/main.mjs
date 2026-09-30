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

process.on('SIGINT', () => {
  logger.info('收到退出信号，断开连接。');
  wsClient.disconnect();
  process.exit(0);
});
