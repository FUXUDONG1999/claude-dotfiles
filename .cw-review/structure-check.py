import re, sys

def check(p, name):
    s = open(p, encoding='utf-8').read()
    sec = (len(re.findall(r'<section', s)), s.count('</section>'))
    div = (len(re.findall(r'<div\b', s)), s.count('</div>'))
    dollar = s.count('$')
    more = s.count('<!--MORE-->')
    theater = s.count('生活剧场') + s.count('剧场')
    head = ('courseware.css' in s and 'mathjax-config.js' in s and 'tex-chtml.js' in s)
    print(f'{name}: sec{sec} div{div} $偶{dollar%2==0} MORE{more} 剧场残留{theater} head完整{head}')

for p, name in [
    (r'E:\workspace\ai-mentor-courseware\04-深度学习\目标检测.html', '目标检测'),
    (r'E:\workspace\ai-mentor-courseware\04-深度学习\语言模型训练范式.html', '语言模型训练范式'),
    (r'E:\workspace\ai-mentor-courseware\05-训练与优化\FP8混合精度训练.html', 'FP8(应未动)'),
    (r'E:\workspace\ai-mentor-courseware\05-训练与优化\DualPipe双向流水线.html', 'DualPipe(在跑)'),
    (r'E:\workspace\ai-mentor-courseware\05-训练与优化\Muon优化器.html', 'Muon(在跑)'),
]:
    try:
        check(p, name)
    except Exception as e:
        print(name, 'ERROR', e)
