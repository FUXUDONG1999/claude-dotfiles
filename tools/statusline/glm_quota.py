#!/usr/bin/env python3
"""GLM Coding Plan 额度查询模块（供 statusline.py 调用，也可单独运行调试）。

接口: GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
认证: ANTHROPIC_AUTH_TOKEN 直传 Authorization 头（不带 Bearer）
缓存: 系统临时目录/glm_quota_cache.json，60 秒 TTL，接口失败时回退旧缓存
"""
import datetime
import json
import os
import tempfile
import time
import urllib.request

CACHE = os.path.join(tempfile.gettempdir(), 'glm_quota_cache.json')
TTL = 60
API = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'

GREEN, YELLOW, RED, RST = '\033[32m', '\033[33m', '\033[31m', '\033[0m'


def _token():
    tok = os.environ.get('ANTHROPIC_AUTH_TOKEN', '')
    if tok:
        return tok
    try:
        cfg = json.load(open(os.path.expanduser('~/.claude/settings.json')))
        return cfg['env']['ANTHROPIC_AUTH_TOKEN']
    except Exception:
        return ''


def _load_cache():
    try:
        return json.load(open(CACHE))
    except Exception:
        return None


def _fetch(tok):
    now = time.time()
    c = _load_cache()
    if c and now - c['ts'] < TTL:
        return c['data']
    if not tok:
        return None
    try:
        req = urllib.request.Request(API, headers={
            'Authorization': tok, 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=3) as r:
            d = json.load(r)
        if d.get('code') == 200 and d.get('data'):
            data = d['data']
            tmp = CACHE + '.%d' % os.getpid()
            with open(tmp, 'w') as f:
                json.dump({'ts': now, 'data': data}, f)
            os.replace(tmp, CACHE)
            return data
    except Exception:
        pass
    # 接口失败：回退到旧缓存（哪怕过期），保证状态栏不闪空
    return c['data'] if c else None


def get_limits():
    """返回 [{'kind': '5h'|'week', 'pct', 'used', 'total', 'reset_ms'}]，失败返回 []"""
    data = _fetch(_token())
    out = []
    if not data:
        return out
    for lim in data.get('limits', []):
        if lim.get('type') != 'CREDIT_LIMIT':
            continue
        if lim.get('unit') == 3:
            out.append({'kind': '5h', 'pct': lim.get('percentage', 0),
                        'used': lim.get('currentValue', 0),
                        'total': lim.get('usage', 0),
                        'reset_ms': lim.get('nextResetTime')})
        elif lim.get('unit') == 6:
            out.append({'kind': 'week', 'pct': lim.get('percentage', 0),
                        'used': lim.get('currentValue', 0),
                        'total': lim.get('usage', 0),
                        'reset_ms': lim.get('nextResetTime')})
    return out


def reset_str(kind, ms):
    if not ms:
        return ''
    t = datetime.datetime.fromtimestamp(ms / 1000)
    return t.strftime('%H:%M') if kind == '5h' else t.strftime('%m-%d %H:%M')


if __name__ == '__main__':
    for lim in get_limits():
        print('%-4s %5d%%  %6s/%-6s  reset %s' % (
            lim['kind'], lim['pct'], lim['used'], lim['total'],
            reset_str(lim['kind'], lim['reset_ms'])))
