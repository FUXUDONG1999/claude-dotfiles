# claude-dotfiles

`~/.claude` 用户配置与自研工具的**分类备份仓库**（快照，非开发主库）。
skills 等内容的日常开发在 `~/.claude/` 进行，本仓库定期同步打包，
密钥均已脱敏为占位符。

## 目录地图

| 目录 / 文件 | 内容 | 恢复目标 |
|---|---|---|
| `tools/statusline/` | 状态栏工具（模型 / 上下文 / 目录 / git 分支 / GLM 额度进度条），详见其目录内 README | `~/.claude/`（由 `install.sh` 完成） |
| `skills/ai-mentor/` | 自定义 skill：AI 导师（费曼式教学课件生成） | `~/.claude/skills/ai-mentor/` |
| `skills/code-refactoring/` | 自定义 skill：代码抽象与重构工程方法论 | `~/.claude/skills/code-refactoring/` |
| `mcp/mcp-servers.json` | MCP 服务器配置（从 `~/.claude.json` 的 `mcpServers` 字段提取） | 合并回 `~/.claude.json` 的 `mcpServers` 字段 |
| `config/CLAUDE.md` | 全局指令（图片处理规则：强制使用智谱 MCP 视觉工具） | `~/.claude/CLAUDE.md` |
| `config/settings.json` | 主设置：环境变量、模型映射（GLM）、权限黑白名单、主题、状态栏 | `~/.claude/settings.json` |
| `config/settings.local.json` | 本地权限补充 | `~/.claude/settings.local.json` |

## 密钥恢复

所有 `YOUR_ZHIPU_API_KEY` 占位符需替换为真实的智谱 API Key（格式
`xxxxxxxx.yyyyyyyy`，从 [open.bigmodel.cn](https://open.bigmodel.cn)
获取），共涉及：

- `config/settings.json` → `env.ANTHROPIC_AUTH_TOKEN`
- `mcp/mcp-servers.json` → `zai-mcp-server.env.Z_AI_API_KEY`
- `mcp/mcp-servers.json` → `web-search-prime` / `web-reader` / `zread` 的
  `headers.Authorization`（`Bearer ` 前缀保留）

## 恢复方法

```bash
cp config/CLAUDE.md config/settings.json config/settings.local.json ~/.claude/
cp -r skills/. ~/.claude/skills/
bash tools/statusline/install.sh    # 状态栏三件套 + settings 合并
# mcp/mcp-servers.json 需手动合并进 ~/.claude.json 的 "mcpServers" 字段
# 最后将所有 YOUR_ZHIPU_API_KEY 替换为真实密钥
```

## 快照更新方法

在 `~/.claude` 侧内容变更后，反向同步进本仓库：

```bash
cp ~/.claude/CLAUDE.md config/
cp ~/.claude/settings.json ~/.claude/settings.local.json config/
cp -r ~/.claude/skills/ai-mentor ~/.claude/skills/code-refactoring skills/
# mcp-servers.json 从 ~/.claude.json 的 mcpServers 字段重新提取
# 提交前务必把真实密钥替换回 YOUR_ZHIPU_API_KEY 占位符
```

## 未包含的内容

以下为运行时状态或隐私数据，刻意排除：

- `projects/`、`sessions/`、`history.jsonl` — 会话记录与对话历史
- `~/.claude.json` 中除 `mcpServers` 外的字段 — 机器 ID、使用统计、项目缓存等运行时状态
- `backups/`、`debug/`、`shell-snapshots/`、`file-history/`、`paste-cache/` — 临时/缓存文件
- `plugins/` — 插件本体可由 marketplace（superpowers 等）重新安装，`config/settings.json` 中已保留 marketplace 与插件开关配置
