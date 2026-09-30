# wecom-claude-bridge

企业微信智能机器人 ⇄ Claude Code 无头模式桥接服务。

通过企业微信官方 **WebSocket 长连接**（`wss://openws.work.weixin.qq.com`）接收消息，交给同机部署的 `claude -p --output-format stream-json` 执行，再把进度与最终结果**流式推送**回企业微信。

**无需公网 IP、无需回调 URL、无需消息加解密**——服务主动向企业微信建立出站长连接，内网服务器可直接部署。

## 架构

```
你（企业微信 App）
   │ 发消息 / 收流式回复
   ▼
wss://openws.work.weixin.qq.com（企微官方长连接）
   │ WebSocket 双向推送
   ▼
bridge（Node.js ≥18，与 claude 同机，systemd 常驻）
   │ 白名单校验 → 会话队列 → claude -p 子进程
   │ stream-json 增量 → 节流流式回推（finish=false）
   │ result → 收尾推送（finish=true）
   ▼
Claude Code 无头模式（操作服务器上的项目目录）
```

## 准备：企业微信后台

1. 登录 [企业微信管理后台](https://work.weixin.qq.com) → 应用管理 → 智能机器人，创建 **API 模式**机器人
2. 记下 **Bot ID** 与 **Secret**
3. 你的 userid 在「我的企业 → 通讯录」中查看（后续配置白名单用）

## 部署

```bash
# 1. 上传到服务器（与 claude CLI 同机）
scp -r wecom-claude-bridge user@your-server:~/

# 2. 安装依赖
cd ~/wecom-claude-bridge
npm install

# 3. 创建 .env（模板见下方），确认 claude 在 PATH 中：claude --version

# 4. 前台试跑
npm start
```

### .env 配置模板

在项目根目录创建 `.env`（`.env*` 文件不入库）：

```ini
BOT_ID=你的机器人ID
BOT_SECRET=你的机器人Secret
ALLOWED_USER_IDS=你的userid
DEFAULT_WORKING_DIRECTORY=/data/your-project
CLAUDE_BINARY_PATH=claude
PERMISSION_MODE=acceptEdits
ALLOWED_TOOLS=
TASK_TIMEOUT_MINUTES=30
STREAM_INTERVAL_MILLISECONDS=2000
STREAM_HARD_DEADLINE_MILLISECONDS=300000
MAX_CONCURRENT_TASKS=3
CONTINUE_SESSION_PER_CHAT=false
STATE_DIRECTORY=./state
LOG_DIRECTORY=./logs
```

### systemd 常驻

`/etc/systemd/system/wecom-claude-bridge.service`：

```ini
[Unit]
Description=WeCom to Claude Code bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/your-user/wecom-claude-bridge
ExecStart=/usr/bin/node src/main.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wecom-claude-bridge
journalctl -u wecom-claude-bridge -f   # 看日志
```

## 使用

直接给机器人发消息即下达任务（单聊、群聊 @机器人 均可，群聊同样校验发送者白名单）。

**会话策略**：默认**每条消息都开全新 Claude 会话**（无上下文续接）。如需同一会话续接上下文，在 `.env` 中设置 `CONTINUE_SESSION_PER_CHAT=true`。

| 命令 | 作用 |
| --- | --- |
| `/new` | 重开全新 Claude 会话 |
| `/cwd <绝对路径>` | 切换 Claude 的工作目录（会重置会话） |
| `/status` | 查看运行中与排队中的任务数 |

## 已知限制（企业微信侧约束，桥接已自动处理）

| 约束 | 桥接行为 |
| --- | --- |
| 流式回复须 6 分钟内结束 | 默认 5 分钟收尾并提示「仍在运行」；任务完成后经主动推送送达 |
| 单条内容 20480 字节上限 | 超限自动截断，全文落盘 `logs/` 目录 |
| 推送频率 30 条/分钟 | 进度按 `STREAM_INTERVAL_MILLISECONDS` 节流 |

## 安全

- **发送者 userid 白名单**（`ALLOWED_USER_IDS`）——来自 IM 的任何文本都是 prompt injection 载体，务必只放行你自己的账号
- `PERMISSION_MODE` 建议保持 `acceptEdits`；如需更保守，用 `ALLOWED_TOOLS` 收窄工具面
- `BOT_SECRET` 只放 `.env`，不要提交入库

## 开发

```bash
npm test    # node:test，28 个用例（解析器/队列/节流/组装层/集成）
```

模块职责：`configuration`（配置加载校验）· `claude-runner`（stream-json 解析 + 子进程）· `task-queue`（会话串行 + 全局并发）· `wecom-channel`（节流流式回复 + 硬截止兜底 + 截断）· `session-store`（chatid→session 映射持久化）· `command-interpreter`（斜杠命令）· `bridge`（组装层）· `main`（入口）。
