// 验证企微机器人凭证：建立 WebSocket 长连接并等待认证结果。
// 用法：BOT_ID=xxx BOT_SECRET=yyy node scripts/verify-bot.mjs（凭证不落盘）
import AiBot from '@wecom/aibot-node-sdk';

const botId = process.env.BOT_ID;
const botSecret = process.env.BOT_SECRET;

if (!botId || !botSecret) {
  console.error('用法：BOT_ID=xxx BOT_SECRET=yyy node scripts/verify-bot.mjs');
  process.exit(1);
}

const wsClient = new AiBot.WSClient({ botId, secret: botSecret, maxReconnectAttempts: 1 });

const timeoutHandle = setTimeout(() => {
  console.error('❌ 15 秒内未完成认证：BotID/Secret 有误，或当前网络无法访问 wss://openws.work.weixin.qq.com');
  process.exit(1);
}, 15_000);

wsClient.on('authenticated', () => {
  clearTimeout(timeoutHandle);
  console.log('✅ 认证成功：BotID 与 Secret 有效，WebSocket 长连接已建立并完成订阅');
  wsClient.disconnect();
  process.exit(0);
});

wsClient.on('connected', () => console.log('… 连接已建立，等待认证'));
wsClient.on('error', (error) => console.error('连接错误：', error?.message ?? error));

wsClient.connect();
