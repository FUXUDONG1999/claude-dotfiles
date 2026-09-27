# Claude Code 用户配置备份

`~/.claude/` 用户级配置的打包备份（密钥已脱敏，上传于 2026-09-27）。

## 文件说明

| 文件 | 作用 | 恢复位置 |
|------|------|----------|
| `CLAUDE.md` | 全局指令（图片处理规则：强制使用智谱 MCP 视觉工具） | `~/.claude/CLAUDE.md` |
| `settings.json` | 主设置：环境变量、模型映射（GLM）、权限黑白名单、主题、状态栏 | `~/.claude/settings.json` |
| `settings.local.json` | 本地权限补充 | `~/.claude/settings.local.json` |
| `mcp-servers.json` | MCP 服务器配置（从 `~/.claude.json` 的 `mcpServers` 字段提取） | 合并回 `~/.claude.json` 的 `mcpServers` 字段 |
| `skills/ai-mentor/` | 自定义 skill：AI 导师（费曼式教学课件生成） | `~/.claude/skills/ai-mentor/` |
| `skills/code-refactoring/` | 自定义 skill：代码抽象与重构工程方法论 | `~/.claude/skills/code-refactoring/` |

状态栏脚本（`statusline.py` / `statusline.sh` / `glm_quota.py`）在本仓库根目录，不在本备份范围内。

## 密钥恢复

所有 `YOUR_ZHIPU_API_KEY` 占位符需替换为真实的智谱 API Key（格式 `xxxxxxxx.yyyyyyyy`，从
[open.bigmodel.cn](https://open.bigmodel.cn) 获取），共涉及：

- `settings.json` → `env.ANTHROPIC_AUTH_TOKEN`
- `mcp-servers.json` → `zai-mcp-server.env.Z_AI_API_KEY`
- `mcp-servers.json` → `web-search-prime` / `web-reader` / `zread` 的 `headers.Authorization`（`Bearer ` 前缀保留）

## 未包含的内容

以下为运行时状态或隐私数据，刻意排除：

- `projects/`、`sessions/`、`history.jsonl` — 会话记录与对话历史
- `~/.claude.json` 中除 `mcpServers` 外的字段 — 机器 ID、使用统计、项目缓存等运行时状态
- `backups/`、`debug/`、`shell-snapshots/`、`file-history/`、`paste-cache/` — 临时/缓存文件
- `plugins/` — 插件本体可由 marketplace（superpowers 等）重新安装，`settings.json` 中已保留 marketplace 与插件开关配置

## 恢复方法

```bash
cp CLAUDE.md settings.json settings.local.json ~/.claude/
cp -r skills/. ~/.claude/skills/
# mcp-servers.json 需手动合并进 ~/.claude.json 的 "mcpServers" 字段
# 最后将所有 YOUR_ZHIPU_API_KEY 替换为真实密钥
```
