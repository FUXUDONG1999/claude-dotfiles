#!/usr/bin/env bash
# Claude Code statusline 一键安装：拷贝文件 + 合并 settings.json（幂等，可重复运行）
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude"

# 前置检查：需要 python3（或 python）
PY=python3
command -v python3 >/dev/null 2>&1 || PY=python
command -v "$PY" >/dev/null 2>&1 || { echo "错误: 未找到 python3/python，请先安装"; exit 1; }

mkdir -p "$DEST"
cp "$SRC/statusline.py" "$SRC/glm_quota.py" "$SRC/statusline.sh" "$DEST/"
chmod +x "$DEST/statusline.sh" 2>/dev/null || true

# 备份并合并 settings.json（只动 statusLine 一个键，其余配置原样保留）
if [ -f "$DEST/settings.json" ]; then
  cp "$DEST/settings.json" "$DEST/settings.json.bak"
fi
"$PY" - "$DEST/settings.json" <<'EOF'
import json, sys
p = sys.argv[1]
try:
    cfg = json.load(open(p))
except Exception:
    cfg = {}
cfg['statusLine'] = {"type": "command", "command": "bash ~/.claude/statusline.sh"}
with open(p, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print('  已写入 statusLine 配置 ->', p)
EOF

echo "安装完成！"
echo "  - 额度显示需要 ANTHROPIC_AUTH_TOKEN（GLM Coding Plan 的 key），"
echo "    通常已在 settings.json 的 env 里；单独机器请把它加进 env。"
echo "  - 在 Claude Code 里随便发一条消息，底部即可看到新状态栏。"
