#!/usr/bin/env python3
"""课件站点聚合器：扫描课件工作区，生成站点目录页与全文检索索引。

产出两个站点文件（幂等：只扫描、绝不改动任何课件）：
1. <工作区>/index.html       层次化目录页，按目录结构分组，含搜索框
2. <工作区>/search-index.json 浏览器端全文检索数据源（assets/site-search.js 消费）

用法：
    python3 aggregate.py <课件工作区绝对路径>
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

EXCLUDED_DIRECTORY_NAMES = {'assets', 'site', '.git', 'node_modules'}

PAGE_TITLE_PATTERN = re.compile(r'<title>(.*?)</title>', re.DOTALL)
SCRIPT_BLOCK_PATTERN = re.compile(r'<script[^>]*>.*?</script>', re.DOTALL)
HTML_TAG_PATTERN = re.compile(r'<[^>]+>')

INDEX_PAGE_TEMPLATE = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>知识课件库</title>
<link rel="stylesheet" href="assets/courseware.css">
</head>
<body>
<div class="index-page">
  <h1>📚 知识课件库</h1>
  <p class="index-meta">共 {page_count} 篇课件 · {group_count} 个分类 · 最近构建 {build_date}</p>
  <input id="site-search-input" class="site-search-input" placeholder="正在加载搜索索引…" autocomplete="off" disabled>
  <div id="search-result-container" hidden></div>
  <div id="group-container">
{group_sections}
  </div>
</div>
<script src="assets/site-search.js"></script>
</body>
</html>
'''

INDEX_GROUP_TEMPLATE = '''    <section class="index-group">
      <h2>📁 {group_name}</h2>
      <ul class="index-list">
{index_entries}
      </ul>
    </section>'''

INDEX_ENTRY_TEMPLATE = '        <li><a href="{path}">{title}</a><span class="index-date">{date}</span></li>'


def extract_plain_text(page_content: str) -> str:
    """提取课件正文纯文本（去脚本、去标签、压空白），作为检索语料。"""
    plain_content = SCRIPT_BLOCK_PATTERN.sub(' ', page_content)
    plain_content = HTML_TAG_PATTERN.sub(' ', plain_content)
    return re.sub(r'\s+', ' ', plain_content).strip()


def collect_catalog_entries(workspace_root: Path) -> list:
    """扫描工作区全部课件 HTML，收集标题、路径、分组、日期与正文语料。"""
    catalog_entries = []
    for page_file in sorted(workspace_root.rglob('*.html')):
        relative_path = page_file.relative_to(workspace_root)
        is_site_root_index = len(relative_path.parts) == 1 and relative_path.name == 'index.html'
        if relative_path.parts[0] in EXCLUDED_DIRECTORY_NAMES or is_site_root_index:
            continue

        page_content = page_file.read_text(encoding='utf-8')
        title_match = PAGE_TITLE_PATTERN.search(page_content)
        catalog_entries.append({
            'title': title_match.group(1).strip() if title_match else page_file.stem,
            'path': relative_path.as_posix(),
            'group': '/'.join(relative_path.parts[:-1]) or '顶层',
            'content': extract_plain_text(page_content),
            'date': datetime.fromtimestamp(page_file.stat().st_mtime).strftime('%Y-%m-%d'),
        })
    return catalog_entries


def render_group_sections(catalog_entries: list) -> str:
    """按目录分组渲染目录页的各分组区块。"""
    grouped_entries = {}
    for catalog_entry in catalog_entries:
        grouped_entries.setdefault(catalog_entry['group'], []).append(catalog_entry)

    group_sections = []
    for group_name in sorted(grouped_entries):
        index_entries = '\n'.join(
            INDEX_ENTRY_TEMPLATE.format(
                path=catalog_entry['path'],
                title=catalog_entry['title'],
                date=catalog_entry['date'],
            )
            for catalog_entry in grouped_entries[group_name]
        )
        group_sections.append(INDEX_GROUP_TEMPLATE.format(group_name=group_name, index_entries=index_entries))
    return '\n'.join(group_sections)


def write_site_files(workspace_root: Path, catalog_entries: list) -> None:
    """写出 index.html 与 search-index.json 到工作区根。"""
    group_count = len({catalog_entry['group'] for catalog_entry in catalog_entries})
    index_page = INDEX_PAGE_TEMPLATE.format(
        page_count=len(catalog_entries),
        group_count=group_count,
        build_date=datetime.now().strftime('%Y-%m-%d'),
        group_sections=render_group_sections(catalog_entries),
    )
    (workspace_root / 'index.html').write_text(index_page, encoding='utf-8')

    search_index = json.dumps({'pages': catalog_entries}, ensure_ascii=False)
    (workspace_root / 'search-index.json').write_text(search_index, encoding='utf-8')
    print(f'聚合完成：{len(catalog_entries)} 篇课件 · {group_count} 个分组 → index.html + search-index.json')


def main() -> None:
    """解析课件工作区参数并执行聚合。"""
    if len(sys.argv) != 2:
        raise SystemExit(f'用法：python3 {sys.argv[0]} <课件工作区绝对路径>')

    workspace_root = Path(sys.argv[1]).resolve()
    if not workspace_root.is_dir():
        raise SystemExit(f'课件工作区不存在：{workspace_root}')

    catalog_entries = collect_catalog_entries(workspace_root)
    if not catalog_entries:
        raise SystemExit(f'未在 {workspace_root} 找到课件 HTML')

    write_site_files(workspace_root, catalog_entries)


if __name__ == '__main__':
    main()
