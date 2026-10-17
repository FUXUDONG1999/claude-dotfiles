import re, html, sys

def measure(path, label):
    s = open(path, encoding='utf-8').read()
    prose = re.sub(r'<svg[\s\S]*?</svg>', '', s)
    prose = re.sub(r'<script[\s\S]*?</script>', '', prose)
    prose = re.sub(r'\$\$[\s\S]*?\$\$', ' MATH ', prose)
    prose = re.sub(r'\$[^$]+\$', ' MATH ', prose)
    txt = re.sub(r'<[^>]+>', ' ', prose)
    txt = html.unescape(txt)
    txt = re.sub(r'\s+', '', txt)
    han = len(re.findall(r'[一-鿿]', txt))
    total = len(txt)
    dash = txt.count('——')
    lparen = txt.count('（')
    bushi = len(re.findall(r'不是[^，。；]{1,12}[，、]而是', txt))
    quanbu = len(re.findall(r'的全部含义|三个字的全部', txt))
    print(f'--- {label} ---')
    print(f'汉字 {han} / 去空白总字符 {total}')
    print(f'破折号 {dash} 处 -> 每千字 {dash/total*1000:.2f}')
    print(f'圆括号 {lparen} 处 -> 每千字 {lparen/total*1000:.2f}')
    print(f'"不是A而是B" {bushi} 次; 总结宣言 {quanbu} 次')

measure(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else sys.argv[1])
