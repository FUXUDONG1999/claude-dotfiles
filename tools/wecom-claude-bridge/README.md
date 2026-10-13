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
SESSION_TTL_HOURS=6
DRAIN_TIMEOUT_MINUTES=15
HEARTBEAT_INTERVAL_MINUTES=5
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
# 优雅停机必需：默认 control-group 会在 stop 时立即 SIGTERM 全部子进程（含正在跑的 claude 任务）
KillMode=mixed
TimeoutStopSec=16min
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

**优雅重启**：`systemctl restart` 不会立刻杀掉正在运行的 Claude 任务——服务先拒绝新消息，等待在途任务完成（上限 `DRAIN_TIMEOUT_MINUTES`，默认 15 分钟；`TimeoutStopSec` 应大于它）。超时未完成的任务会被中断，并向对应会话推送中断通知（可用 `/resume` 恢复会话）。再发一次 stop 信号则立即退出。**运行中任务静默超过 `HEARTBEAT_INTERVAL_MINUTES`（默认 5，设 0 关闭）时，会主动推送「仍在工作」心跳**，无需发消息探测。

## 使用

直接给机器人发消息即下达任务（单聊、群聊 @机器人 均可，群聊同样校验发送者白名单）。

**会话策略**：默认**每条消息都开全新 Claude 会话**（无上下文续接）。如需同一会话续接上下文，在 `.env` 中设置 `CONTINUE_SESSION_PER_CHAT=true`，此时同一企微会话（单聊或同群）闲置 `SESSION_TTL_HOURS`（默认 6 小时）内自动续聊；超时后自动开新会话并提示，最近 5 个历史会话可用 `/resume` 找回。任务失败/超时的会话也会自动转入历史（避免失效 sessionId 卡死当前会话）；`/stop` 手动终止的会话**不**降级——半成品上下文仍有价值，下一轮继续续接。

| 命令 | 作用 |
| --- | --- |
| `/new` | 重开全新 Claude 会话（旧会话转入历史，可 `/resume` 找回） |
| `/resume` | 列出可恢复的历史会话（首问摘要 + 时间） |
| `/resume <序号>` | 恢复指定历史会话为当前会话，闲置计时重置 |
| `/cwd <绝对路径>` | 切换 Claude 的工作目录（会重置会话） |
| `/stop` | 终止当前会话运行中的任务（发「停止任务/终止任务/暂停任务」等效）；终止前的产出会推送，会话保留、可直接继续 |
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
