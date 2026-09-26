#!/usr/bin/env python3
"""Claude Code status line（Python 版）。

布局:  [模型 | ctx进度条 | 目录 | git分支]  <----右侧填充---->  [⚡5h进度条 | 周进度条]
stdin: Claude Code 传入的会话 JSON（原始报文转存 /tmp/sl_stdin.json 便于排查字段）
"""
import json
import os
import re
import subprocess
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glm_quota import get_limits, reset_str

C = {
    'model':  '\033[36m',
    'dir':    '\033[35m',
    'branch': '\033[33m',
    'sep':    '\033[90m',
    'green':  '\033[32m',
    'yellow': '\033[33m',
    'red':    '\033[31m',
    'rst':    '\033[0m',
}
SEP = C['sep'] + ' | ' + C['rst']
ANSI_RE = re.compile(r'\033\[[0-9;]*m')


def color_by(pct, lo=50, hi=80):
    if pct >= hi:
        return C['red']
    if pct >= lo:
        return C['yellow']
    return C['green']


def bar(pct, width=10):
    filled = max(0, min(width, round(pct / 100.0 * width)))
    return '█' * filled + '░' * (width - filled)


def vis_len(s):
    """终端可见宽度：去掉 ANSI，CJK/emoji 记 2，块字符记 1（kitty 默认窄）。"""
    w = 0
    for ch in ANSI_RE.sub('', s):
        cp = ord(ch)
        if unicodedata.east_asian_width(ch) in 'WF' or 0x1F300 <= cp <= 0x1FAFF:
            w += 2
        else:
            w += 1
    return w


def git_branch(d):
    try:
        r = subprocess.run(['git', '--no-optional-locks', '-C', d, 'branch', '--show-current'],
                           capture_output=True, text=True, timeout=2)
        if r.stdout.strip():
            return r.stdout.strip()
        r = subprocess.run(['git', '--no-optional-locks', '-C', d, 'rev-parse', '--short', 'HEAD'],
                           capture_output=True, text=True, timeout=2)
        sha = r.stdout.strip()
        return 'detached@%s' % sha if sha else None
    except Exception:
        return None


def find_width(j):
    """尽量从 stdin JSON 里找终端宽度字段（不同版本字段名不一）。"""
    for path in (('terminal_width',), ('width',), ('terminal', 'width'),
                 ('terminal', 'columns'), ('viewport', 'width')):
        v = j
        try:
            for k in path:
                v = v[k]
            if isinstance(v, int) and v > 20:
                return v
        except (KeyError, TypeError):
            pass
    return None


def pty_width():
    """沿 /proc 向上找父进程的 pty，ioctl TIOCGWINSZ 取真实终端宽度。

    statusline 自身 stdin 是管道，但祖先进程(claude)的 fd 0 是终端的
    pty，打开 /proc/<pid>/fd/0 后 ioctl 即可拿到宽度（每次刷新都重查，
    窗口缩放实时生效）。仅 Linux 可用（macOS/Windows 无 /proc，返回
    None，布局退化为左块+间隔+右块）。找不到就返回 None。
    """
    import fcntl
    import struct
    import termios
    pid = os.getpid()
    for _ in range(5):
        try:
            fd = os.open('/proc/%d/fd/0' % pid, os.O_RDONLY)
        except OSError:
            return None
        try:
            data = fcntl.ioctl(fd, termios.TIOCGWINSZ, struct.pack('HHHH', 0, 0, 0, 0))
            cols = struct.unpack('HHHH', data)[1]
            if cols > 20:
                return cols
        except OSError:
            pass
        finally:
            os.close(fd)
        try:
            with open('/proc/%d/status' % pid) as f:
                m = re.search(r'^PPid:\s+(\d+)', f.read(), re.M)
            if not m:
                break
            pid = int(m.group(1))
        except Exception:
            break
    return None


def main():
    raw = sys.stdin.read()
    try:
        with open('/tmp/sl_stdin.json', 'w') as f:
            f.write(raw)
    except Exception:
        pass
    try:
        j = json.loads(raw) if raw else {}
    except Exception:
        j = {}

    model = (j.get('model') or {}).get('display_name') or '?'
    model = re.sub(r'\[(1m|256k)\]$', '', model)  # 去掉上下文窗口后缀
    cwd = (j.get('workspace') or {}).get('current_dir') or j.get('cwd') or os.getcwd()
    base = os.path.basename(cwd.rstrip('/')) or cwd
    ctx_pct = (j.get('context_window') or {}).get('used_percentage')

    # ---- 左半部分: 模型 | ctx | 目录 | git分支
    left = [C['model'] + model + C['rst']]
    if ctx_pct is not None:
        p = int(round(ctx_pct))
        left.append(color_by(p) + 'ctx %s %d%%' % (bar(p), p) + C['rst'])
    left.append(C['dir'] + base + C['rst'])
    br = git_branch(cwd)
    if br:
        left.append(C['branch'] + br + C['rst'])
    left_s = SEP.join(left)

    # ---- 右半部分: ⚡5h | 周 额度进度条（精确重置时间）
    right = []
    for lim in get_limits():
        cc = color_by(lim['pct'])
        label = '⚡' if lim['kind'] == '5h' else '周'
        right.append(cc + '%s %s %d%%(%s)' % (
            label, bar(lim['pct']), lim['pct'],
            reset_str(lim['kind'], lim['reset_ms'])) + C['rst'])
    right_s = SEP.join(right)

    if not right_s:
        sys.stdout.write(left_s)
        return

    # ---- 右对齐: pty ioctl / stdin 字段拿宽度, 纯空格填充(渲染器不会吞空格)
    width = pty_width() or find_width(j)
    pad = 3
    if width:
        pad = max(2, width - vis_len(left_s) - vis_len(right_s) - 2)
    sys.stdout.write(left_s + ' ' * pad + right_s)


if __name__ == '__main__':
    main()
