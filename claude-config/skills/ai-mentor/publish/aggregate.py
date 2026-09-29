#!/usr/bin/env python3
"""课件站点聚合部署器：工作区只保留课件源文件，站点在临时目录组装、部署后即焚。

流程（幂等，绝不改动工作区课件）：
1. 扫描工作区课件 HTML；
2. 组装站点到 <工作区>/.site-build/：拷贝课件与共享 assets、生成 index.html 目录页与 search-index.json 检索索引；
3. --deploy：调用 tcb hosting deploy 部署组装目录（--prune 清理远端多余文件），完成后删除组装目录。

用法：
    python3 aggregate.py <课件工作区>              # 仅组装，保留 .site-build/ 供本地检查
    python3 aggregate.py <课件工作区> --deploy     # 组装 + 部署 + 清理（SKILL.md 标准流程）
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

PUBLISH_ROOT = Path(__file__).resolve().parent
SHARED_ASSETS_SOURCE = PUBLISH_ROOT / 'assets'
DEFAULT_ENV_ID = 'ai-mentor-d3g171es499a57dd1'
BUILD_DIRECTORY_NAME = '.site-build'

EXCLUDED_DIRECTORY_NAMES = {'assets', BUILD_DIRECTORY_NAME, 'site', '.git', 'node_modules'}
EXCLUDED_FILE_NAMES = {'.DS_Store', 'search-index.json'}

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


def copy_courseware_sources(workspace_root: Path, build_root: Path) -> None:
    """把工作区的课件源文件按相对结构拷贝到组装目录（排除站点产物与系统文件）。"""
    for source_file in workspace_root.rglob('*'):
        if not source_file.is_file():
            continue

        relative_path = source_file.relative_to(workspace_root)
        if relative_path.parts[0] in EXCLUDED_DIRECTORY_NAMES:
            continue
        if relative_path.parts[-1] in EXCLUDED_FILE_NAMES:
            continue

        destination_file = build_root / relative_path
        destination_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, destination_file)


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


def assemble_site(workspace_root: Path, catalog_entries: list) -> Path:
    """组装完整站点到 <工作区>/.site-build/，返回组装目录。"""
    build_root = workspace_root / BUILD_DIRECTORY_NAME
    if build_root.exists():
        shutil.rmtree(build_root)
    build_root.mkdir(parents=True)

    copy_courseware_sources(workspace_root, build_root)
    shutil.copytree(SHARED_ASSETS_SOURCE, build_root / 'assets')

    group_count = len({catalog_entry['group'] for catalog_entry in catalog_entries})
    index_page = INDEX_PAGE_TEMPLATE.format(
        page_count=len(catalog_entries),
        group_count=group_count,
        build_date=datetime.now().strftime('%Y-%m-%d'),
        group_sections=render_group_sections(catalog_entries),
    )
    (build_root / 'index.html').write_text(index_page, encoding='utf-8')
    (build_root / 'search-index.json').write_text(
        json.dumps({'pages': catalog_entries}, ensure_ascii=False), encoding='utf-8')
    print(f'组装完成：{len(catalog_entries)} 篇课件 · {group_count} 个分组 → {build_root}')
    return build_root


def deploy_site(build_root: Path, environment_id: str) -> None:
    """部署组装目录到 CloudBase 静态托管（--prune 清理远端多余文件）。"""
    deploy_command = ['tcb', 'hosting', 'deploy', str(build_root), '-e', environment_id, '--prune', '-y']
    completed_process = subprocess.run(deploy_command)
    if completed_process.returncode != 0:
        raise SystemExit(f'✗ tcb hosting deploy 失败（exit {completed_process.returncode}），组装目录已保留：{build_root}')


def main() -> None:
    """解析参数：组装站点，按需部署并清理组装目录。"""
    argument_parser = argparse.ArgumentParser(description='课件站点聚合部署器（临时组装、部署即焚）')
    argument_parser.add_argument('workspace', help='课件工作区目录（<主题>/ 文件夹所在目录）')
    argument_parser.add_argument('--deploy', action='store_true', help='部署到 CloudBase 并清理组装目录')
    argument_parser.add_argument('--env-id', default=DEFAULT_ENV_ID, help=f'CloudBase 环境 ID（默认 {DEFAULT_ENV_ID}）')
    parsed_arguments = argument_parser.parse_args()

    workspace_root = Path(parsed_arguments.workspace).resolve()
    if not workspace_root.is_dir():
        raise SystemExit(f'课件工作区不存在：{workspace_root}')

    catalog_entries = collect_catalog_entries(workspace_root)
    if not catalog_entries:
        raise SystemExit(f'未在 {workspace_root} 找到课件 HTML')

    build_root = assemble_site(workspace_root, catalog_entries)

    if parsed_arguments.deploy:
        deploy_site(build_root, parsed_arguments.env_id)
        shutil.rmtree(build_root)
        print(f'部署完成并已清理组装目录。访问入口：https://{parsed_arguments.env_id}-1259453558.tcloudbaseapp.com/')
    else:
        print('未指定 --deploy，组装目录已保留供本地检查；确认无误后可手动删除或重跑加 --deploy。')


if __name__ == '__main__':
    main()
