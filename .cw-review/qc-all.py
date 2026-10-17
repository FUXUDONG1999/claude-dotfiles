import re, html, sys, glob, os

ROOT = r'E:\workspace\ai-mentor-courseware'
fail = []
warn = []
ok = 0

files = sorted(glob.glob(os.path.join(ROOT, '*', '*.html')))
print(f'共 {len(files)} 篇')

for p in files:
    rel = os.path.relpath(p, ROOT)
    try:
        s = open(p, encoding='utf-8').read()
    except Exception as e:
        fail.append((rel, f'读取失败 {e}'))
        continue

    problems = []
    # 1. style metrics (prose only)
    prose = re.sub(r'<svg[\s\S]*?</svg>', '', s)
    prose = re.sub(r'<script[\s\S]*?</script>', '', prose)
    prose = re.sub(r'\$\$[\s\S]*?\$\$', ' M ', prose)
    prose = re.sub(r'\$[^$]+\$', ' M ', prose)
    t = re.sub(r'<[^>]+>', ' ', prose)
    t = html.unescape(t)
    t = re.sub(r'\s+', '', t)
    n = max(len(t), 1)
    dash = t.count('——')
    par = t.count('（')
    dash_k = dash / n * 1000
    par_k = par / n * 1000
    if dash_k > 2.0:
        problems.append(f'破折号{dash_k:.2f}/千字')
    if par_k > 4.0:
        problems.append(f'括号{par_k:.2f}/千字')

    # 2. structure
    sec_o = len(re.findall(r'<section', s))
    sec_c = s.count('</section>')
    if sec_o != sec_c:
        problems.append(f'section {sec_o}/{sec_c}')
    div_o = len(re.findall(r'<div\b', s))
    div_c = s.count('</div>')
    if div_o != div_c:
        problems.append(f'div {div_o}/{div_c}')
    if s.count('$') % 2 != 0:
        problems.append('$奇数')
    if '<!--MORE-->' in s:
        problems.append('MORE残留')
    if not ('courseware.css' in s and 'mathjax-config.js' in s and 'tex-chtml.js' in s):
        problems.append('head三行不全')
    if '生活剧场' in s:
        problems.append('生活剧场残留')
    if s.count('<strong') != s.count('</strong>'):
        problems.append(f'strong {s.count("<strong")}/{s.count("</strong>")}')

    if problems:
        fail.append((rel, '; '.join(problems)))
    else:
        ok += 1

print(f'通过 {ok} / {len(files)}')
if fail:
    print('--- 未通过 ---')
    for rel, why in fail:
        print(f'{rel}: {why}')
else:
    print('全部通过')
