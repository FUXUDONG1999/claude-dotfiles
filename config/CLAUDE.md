# graphify
- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, invoke the Skill tool with `skill: "graphify"` before doing anything else.

# 团队编码规则（强制）

写码、改码、评审前必须先完整阅读以下两份规则文件（以文件当前内容为唯一权威版本，凭记忆动手即违规）：

@/Users/fuxudong/.claude/rules/代码编写规范.md

@/Users/fuxudong/.claude/rules/代码架构规则.md

# 问题排查规则（强制）

问题排查、问题分析、调用链 / 影响面 / 耦合分析时，优先使用 codegraph 检索，结论必须回到源码取证：

@/Users/fuxudong/.claude/rules/问题排查优先使用codegraph.md

# 图片处理规则（强制）

禁止使用内置的图片分析工具，会超时或拿不到视觉内容：

- ❌ `mcp__4_5v_mcp__analyze_image`（Z.ai Built-in Tool，服务器端执行易超时）
- ❌ 用 `Read` 工具直接读图片（只会把图上传到 CDN，模型看不到内容）

需要识别/分析图片时，一律改用智谱（Zhipu）的 MCP 工具，支持本地路径和远程 URL：

- `mcp__zai-mcp-server__analyze_image` — 通用图片分析
- `mcp__zai-mcp-server__extract_text_from_screenshot` — 截图 OCR 提取文字
- `mcp__zai-mcp-server__diagnose_error_screenshot` — 报错截图诊断
- 其他 `mcp__zai-mcp-server__*` 视觉工具（UI 转代码、图表分析、视频分析等）按需选用
