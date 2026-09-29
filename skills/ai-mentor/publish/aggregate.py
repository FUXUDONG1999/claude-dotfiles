#!/usr/bin/env python3
"""课件站点聚合部署器：增量累积模式，云端 search-index.json 是站点清单权威。

流程（幂等，绝不改动工作区课件）：
1. 扫描工作区课件 HTML，得到本地条目（仅 title/path）；
2. 拉取云端 search-index.json（带 cache-busting；404 视为空索引，网络异常则中止以免冲掉远端清单），
   与本地条目按 path 合并，同名路径以本地为准（覆盖更新场景）；
3. 组装站点到 <工作区>/.site-build/：拷贝课件与共享 assets、按合并清单生成 index.html 文档站首页
   （左目录树 + 右侧阅读区）与 search-index.json（瘦身：仅 title/path，分组从路径派生）；
4. --deploy：调用 tcb hosting deploy 上传组装目录（只上传覆盖同名，不删除远端文件），
   完成后删除组装目录。换机器部署无需同步工作区全集：远端文件只增不删，孤儿文件不进清单即不可见。

用法：
    python3 aggregate.py <课件工作区>              # 仅组装（仍拉取远端索引合并），保留 .site-build/ 供本地检查
    python3 aggregate.py <课件工作区> --deploy     # 组装 + 部署 + 清理（SKILL.md 标准流程）
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PUBLISH_ROOT = Path(__file__).resolve().parent
SHARED_ASSETS_SOURCE = PUBLISH_ROOT / 'assets'
DEFAULT_ENV_ID = 'ai-mentor-d3g171es499a57dd1'
TENCENT_CLOUD_APP_ID = '1259453558'
REMOTE_INDEX_URL_TEMPLATE = 'https://{environment_id}-{app_id}.tcloudbaseapp.com/search-index.json?t={timestamp}'
BUILD_DIRECTORY_NAME = '.site-build'

EXCLUDED_DIRECTORY_NAMES = {'assets', BUILD_DIRECTORY_NAME, 'site', '.git', 'node_modules'}
EXCLUDED_FILE_NAMES = {'.DS_Store', 'search-index.json'}

PAGE_TITLE_PATTERN = re.compile(r'<title>(.*?)</title>', re.DOTALL)

INDEX_PAGE_TEMPLATE = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>知识课件库</title>
<link rel="stylesheet" href="assets/courseware.css">
</head>
<body>
<div class="docs-layout">
  <nav class="docs-nav">
    <h1>📚 知识课件库</h1>
    <input id="site-search-input" class="site-search-input" placeholder="正在加载搜索索引…" autocomplete="off" disabled>
    <div id="search-result-container" hidden></div>
    <div id="docs-tree">
{group_sections}
    </div>
  </nav>
  <iframe id="content-frame" class="docs-frame" title="课件内容"></iframe>
</div>
<script src="assets/site.js"></script>
</body>
</html>
'''

INDEX_GROUP_TEMPLATE = '''      <section class="docs-group">
        <h2>📁 {group_name} <span class="docs-path">{group_path_label}</span></h2>
        <ul class="docs-list">
{index_entries}
        </ul>
      </section>'''

TOP_LEVEL_GROUP_TEMPLATE = '''      <section class="docs-group">
        <ul class="docs-list">
{index_entries}
        </ul>
      </section>'''

TOP_LEVEL_GROUP_NAME = '顶层'

INDEX_ENTRY_TEMPLATE = '          <li><a href="{path}" data-path="{path}">{title}</a></li>'


def collect_local_catalog_entries(workspace_root: Path) -> list:
    """扫描工作区全部课件 HTML，收集本地条目（索引仅存 title/path，分组从路径派生）。"""
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
        })
    return catalog_entries


def fetch_remote_catalog_entries(environment_id: str) -> list:
    """拉取云端检索索引（时间戳参数防 CDN 缓存）；404 视为空索引，其余异常中止部署以免冲掉远端清单。"""
    remote_index_url = REMOTE_INDEX_URL_TEMPLATE.format(
        environment_id=environment_id,
        app_id=TENCENT_CLOUD_APP_ID,
        timestamp=int(time.time()),
    )

    try:
        with urllib.request.urlopen(remote_index_url, timeout=15) as remote_response:
            remote_payload = json.loads(remote_response.read().decode('utf-8'))
    except urllib.error.HTTPError as http_error:
        if http_error.code == 404:
            print('云端索引不存在（首次部署），从空清单起步。')
            return []
        raise SystemExit(f'✗ 拉取云端索引失败：HTTP {http_error.code}（{remote_index_url}），已中止以免冲掉远端清单。')
    except (urllib.error.URLError, TimeoutError) as fetch_error:
        raise SystemExit(f'✗ 拉取云端索引失败：{fetch_error}（{remote_index_url}），已中止以免冲掉远端清单。')
    except json.JSONDecodeError as decode_error:
        raise SystemExit(f'✗ 云端索引不是合法 JSON：{decode_error}（{remote_index_url}），已中止以免冲掉远端清单。')

    if not isinstance(remote_payload, dict) or not isinstance(remote_payload.get('pages'), list):
        raise SystemExit(f'✗ 云端索引结构异常（缺少 pages 列表）：{remote_index_url}，已中止以免冲掉远端清单。')

    remote_entries = [
        {'title': remote_page['title'], 'path': remote_page['path']}
        for remote_page in remote_payload['pages']
        if isinstance(remote_page, dict) and 'title' in remote_page and 'path' in remote_page
    ]
    print(f'拉取云端索引：{len(remote_entries)} 条现有条目（{remote_index_url}）。')
    return remote_entries


def merge_catalog_entries(remote_entries: list, local_entries: list) -> list:
    """合并云端与本地条目：以 path 为唯一键，同名路径本地覆盖云端（更新场景），按 path 排序保证输出确定。"""
    merged_entries = {catalog_entry['path']: catalog_entry for catalog_entry in remote_entries}
    for catalog_entry in local_entries:
        merged_entries[catalog_entry['path']] = catalog_entry
    return [merged_entries[path] for path in sorted(merged_entries)]


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


def derive_group_name(page_path: str) -> str:
    """从课件路径派生分组名：根目录平铺的课件归入顶层，子目录课件按目录段分组。"""
    directory_path = page_path.rsplit('/', 1)[0] if '/' in page_path else ''
    return directory_path or TOP_LEVEL_GROUP_NAME


def render_group_sections(catalog_entries: list) -> str:
    """按目录分组渲染目录树：顶层课件不显示分组标题，其余分组按路径排序、组间横线分隔。"""
    grouped_entries = {}
    for catalog_entry in catalog_entries:
        grouped_entries.setdefault(derive_group_name(catalog_entry['path']), []).append(catalog_entry)

    ordered_group_names = sorted(grouped_entries)
    if TOP_LEVEL_GROUP_NAME in grouped_entries:
        ordered_group_names.remove(TOP_LEVEL_GROUP_NAME)
        ordered_group_names.insert(0, TOP_LEVEL_GROUP_NAME)

    group_sections = []
    for group_name in ordered_group_names:
        index_entries = '\n'.join(
            INDEX_ENTRY_TEMPLATE.format(
                path=catalog_entry['path'],
                title=catalog_entry['title'],
            )
            for catalog_entry in grouped_entries[group_name]
        )

        if group_name == TOP_LEVEL_GROUP_NAME:
            group_sections.append(TOP_LEVEL_GROUP_TEMPLATE.format(index_entries=index_entries))
            continue

        group_path_parts = group_name.split('/')
        group_sections.append(INDEX_GROUP_TEMPLATE.format(
            group_name=group_path_parts[-1],
            group_path_label=' / '.join(group_path_parts),
            index_entries=index_entries))
    return '\n'.join(group_sections)


def assemble_site(workspace_root: Path, catalog_entries: list) -> Path:
    """组装完整站点到 <工作区>/.site-build/，返回组装目录。"""
    build_root = workspace_root / BUILD_DIRECTORY_NAME
    if build_root.exists():
        shutil.rmtree(build_root)
    build_root.mkdir(parents=True)

    copy_courseware_sources(workspace_root, build_root)
    shutil.copytree(SHARED_ASSETS_SOURCE, build_root / 'assets')

    group_count = len({derive_group_name(catalog_entry['path']) for catalog_entry in catalog_entries})
    index_page = INDEX_PAGE_TEMPLATE.format(group_sections=render_group_sections(catalog_entries))
    (build_root / 'index.html').write_text(index_page, encoding='utf-8')
    (build_root / 'search-index.json').write_text(
        json.dumps({'pages': catalog_entries}, ensure_ascii=False), encoding='utf-8')
    print(f'组装完成：{len(catalog_entries)} 篇课件 · {group_count} 个分组 → {build_root}')
    return build_root


def deploy_site(build_root: Path, environment_id: str) -> None:
    """部署组装目录到 CloudBase 静态托管：只上传覆盖同名文件，不删除远端既有文件（增量累积）。"""
    deploy_command = ['tcb', 'hosting', 'deploy', str(build_root), '-e', environment_id, '-y']
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

    local_entries = collect_local_catalog_entries(workspace_root)
    if not local_entries:
        raise SystemExit(f'未在 {workspace_root} 找到课件 HTML')

    remote_entries = fetch_remote_catalog_entries(parsed_arguments.env_id)
    catalog_entries = merge_catalog_entries(remote_entries, local_entries)
    print(f'清单合并：云端 {len(remote_entries)} 条 + 本地 {len(local_entries)} 条 → {len(catalog_entries)} 条（同名路径本地覆盖）。')

    build_root = assemble_site(workspace_root, catalog_entries)

    if parsed_arguments.deploy:
        deploy_site(build_root, parsed_arguments.env_id)
        shutil.rmtree(build_root)
        print(f'部署完成并已清理组装目录。访问入口：https://{parsed_arguments.env_id}-1259453558.tcloudbaseapp.com/')
    else:
        print('未指定 --deploy，组装目录已保留供本地检查；确认无误后可手动删除或重跑加 --deploy。')


if __name__ == '__main__':
    main()
