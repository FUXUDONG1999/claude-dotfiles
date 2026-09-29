# Claude Code Statusline（GLM Coding Plan 额度版）

一行状态栏，同时显示模型 / 上下文进度条 / 目录 / git 分支，右侧贴边显示
GLM Coding Plan 的 5 小时与周额度进度条：

```
glm-5.3 | ctx ████░░░░░░ 43% | 项目目录 ⣿ git分支        ⚡ ██░░░░░░░░ 8%(13:56) | 周 █████░░░░░ 50%(09-28 19:28)
```

- 三条进度条统一配色：绿 <50%、黄 50–79%、红 ≥80%
- ⚡ 为 5 小时滚动窗口额度，括号内是重置时刻（HH:MM）
- 周额度括号内是精确重置时间（MM-DD HH:MM）
- ctx 右侧的目录在 git 仓库内时追加分支名（detached 显示短 SHA）

## 安装

把整个文件夹拷到目标机器，然后：

```bash
bash install.sh
```

脚本做三件事（幂等，可重复执行）：

1. 拷贝 `statusline.py` / `glm_quota.py` / `statusline.sh` 到 `~/.claude/`
2. 备份 `settings.json` 为 `settings.json.bak`
3. 往 `settings.json` 合并写入 `statusLine` 键（其余配置不动）

唯一依赖：**python3**（零第三方包）。额度数据需要
`ANTHROPIC_AUTH_TOKEN`（GLM Coding Plan 的 key）——接 GLM 的机器一般已在
`settings.json` 的 `env` 里，脚本和环境变量里任取其一。

## 文件说明

| 文件 | 作用 |
|---|---|
| `statusline.py` | 主逻辑：解析 stdin JSON、进度条、配色、右对齐、git 分支 |
| `glm_quota.py` | GLM 额度查询模块，可单独运行调试：`python3 glm_quota.py` |
| `statusline.sh` | 入口薄包装（python3 缺失时回退 python），settings.json 指向它 |
| `install.sh` | 一键安装 |

## 工作原理

- **数据来源**：Claude Code 每次刷新把会话 JSON 写入 stdin（模型名、目录、
  `context_window.used_percentage` 等；原始报文转存在 `/tmp/sl_stdin.json`
  便于排查）。额度来自
  `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`，
  header 用 `ANTHROPIC_AUTH_TOKEN` 原文（**不带** Bearer 前缀），一次返回
  5 小时窗（unit=3）与周窗（unit=6）。GET 查询不消耗 Coding Plan 额度。
- **缓存**：额度结果缓存 60 秒（系统临时目录 `glm_quota_cache.json`），
  状态栏刷新再频繁，每分钟最多一次真实请求；接口失败时沿用旧缓存，
  状态栏不会闪空。
- **右对齐**：Claude Code 传入的 JSON 里没有终端宽度字段，`ESC[999C` 之类
  光标序列也会被渲染器吞掉。实际方案是沿 `/proc/<pid>/fd/0` 找到祖先进程
  （claude）持有的 pty，用 `TIOCGWINSZ` ioctl 取真实列数后纯空格填充，
  窗口缩放实时跟随。**仅 Linux 生效**；macOS / Windows 无 `/proc`，
  自动退化为「左块 + 3 空格 + 右块」布局，其余功能不受影响。

## 自定义

改 `statusline.py` 顶部与 `main()`：

- 进度条格数：`bar(pct, width=10)`
- 配色阈值：`color_by(pct, lo=50, hi=80)`
- 各段颜色表：`C = {...}`
- 额度刷新频率：`glm_quota.py` 的 `TTL = 60`（秒）

## 卸载

删除 `settings.json` 里的 `statusLine` 键（或用安装前的
`settings.json.bak` 恢复），再删掉 `~/.claude/` 下三个脚本即可。

## 相关

skills、MCP 配置等其他 `~/.claude` 配置备份见[仓库根 README](../../README.md)。
