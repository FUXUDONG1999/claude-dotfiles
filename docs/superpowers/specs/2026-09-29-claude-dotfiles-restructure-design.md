# claude-dotfiles 仓库重组设计

日期：2026-09-29
状态：待用户审阅

## 背景与目标

仓库原名 `claude-statuesline`（statues 为 status 的拼写错误），最初只含
statusline 工具，后加入 `claude-config/`（`~/.claude` 配置备份）。现状问题：

1. 仓库名拼写错误且名不副实（内容已远超 statusline）
2. statusline 三件套平铺根目录，与配置备份混杂
3. tools / skills / mcp / 配置文件没有清晰的分类结构

**目标**：重组为分类清晰的备份仓库，并同步重命名（GitHub + 本地目录）。

## 仓库定位（已与用户确认）

**仅分类备份**：本仓库是 `~/.claude` 用户配置与自研工具的分类快照，
不是开发主库。skills 的开发仍在 `~/.claude/skills/` 进行，本仓库定期
同步快照。不提供仓库级统一安装脚本。

## 目标结构（方案 A，已确认）

```
claude-dotfiles/
├── README.md                 ← 总览：定位、目录地图、恢复指引（新写）
├── tools/
│   └── statusline/
│       ├── README.md         ← statusline 专属文档（原根 README 迁入改写）
│       ├── statusline.py
│       ├── glm_quota.py
│       ├── statusline.sh
│       └── install.sh        ← 内容零修改（按 $(dirname $0) 相对定位）
├── skills/                   ← ~/.claude/skills/ 镜像
│   ├── ai-mentor/
│   └── code-refactoring/
├── mcp/
│   └── mcp-servers.json      ← ~/.claude.json 的 mcpServers 快照
└── config/                   ← ~/.claude 顶层配置快照
    ├── CLAUDE.md
    ├── settings.json
    └── settings.local.json
```

## 迁移映射表（全部使用 git mv 保留历史）

| 原路径 | 新路径 | 说明 |
|---|---|---|
| `statusline.py` | `tools/statusline/statusline.py` | git mv |
| `glm_quota.py` | `tools/statusline/glm_quota.py` | git mv |
| `statusline.sh` | `tools/statusline/statusline.sh` | git mv |
| `install.sh` | `tools/statusline/install.sh` | git mv，内容不改 |
| `README.md` | `tools/statusline/README.md` | 内容迁移后按新路径修正 |
| `claude-config/skills/ai-mentor/` | `skills/ai-mentor/` | git mv |
| `claude-config/skills/code-refactoring/` | `skills/code-refactoring/` | git mv |
| `claude-config/mcp-servers.json` | `mcp/mcp-servers.json` | git mv |
| `claude-config/CLAUDE.md` | `config/CLAUDE.md` | git mv |
| `claude-config/settings.json` | `config/settings.json` | git mv |
| `claude-config/settings.local.json` | `config/settings.local.json` | git mv |
| `claude-config/README.md` | （删除，内容并入新根 README） | 恢复指引与密钥说明合并 |
| （新建） | `README.md` | 仓库总览 |

## 文档拆分策略

- **根 README**（新写）：仓库定位（分类快照，非主库）、目录地图表
  （目录 → 内容 → 恢复目标路径）、密钥恢复说明（三处
  `YOUR_ZHIPU_API_KEY` 占位符的替换位置）、未包含内容清单、
  快照更新方法（如何从 `~/.claude` 重新打包同步）。
- **tools/statusline/README**（原根 README 改写）：保留功能展示、安装、
  工作原理、自定义、卸载全部章节；「claude-config/ 一节删除，改为
  一行指向仓库根 README。

## 重命名步骤（三处，按序执行）

1. **内容重组**：全部 git mv + README 重写，commit 并 push（在旧目录名
   下完成，目录名不影响 git 内容）。
2. **GitHub 改名**：`gh repo rename claude-dotfiles`（旧 URL 自动重定向）。
3. **remote 更新**：`git remote set-url origin
   https://github.com/FUXUDONG1999/claude-dotfiles.git`。
4. **本地目录改名**（最后执行）：`mv claude-statuesline claude-dotfiles`。
   注意：执行时当前 Claude Code 会话工作目录位于旧路径，改名后本会话
   仅使用绝对路径操作。

## 验证清单

- [ ] `git status` clean，`git log --follow` 可追到 statusline 初始提交
- [ ] `bash -n tools/statusline/install.sh` 语法通过
- [ ] `python3 -m py_compile` 两个 .py 文件通过
- [ ] 根 README 与 tools/statusline/README 内相对链接有效
- [ ] `gh repo view` 确认新仓库名生效
- [ ] `git ls-remote origin` 确认 remote 可达

## 风险与对策

| 风险 | 对策 |
|---|---|
| gh CLI 未认证，无法改名 | 回退为输出 GitHub 网页改名指引，其余步骤不受影响 |
| 本地 mv 后当前会话 cwd 失效 | mv 排在最后一步；此后仅用绝对路径验证 |
| `~/.claude` 侧无任何引用指向本仓库路径 | 已确认无风险（仓库仅被读取/推送，不被运行时引用） |
| 密钥脱敏性质被破坏 | 仅做位置迁移，文件内容（含占位符）逐字节不变 |

## 备注

本设计文档位于 `docs/superpowers/specs/`。若不希望备份仓库长期保留
流程文档，实施完成后可将 `docs/` 目录删除（单独 commit）。
