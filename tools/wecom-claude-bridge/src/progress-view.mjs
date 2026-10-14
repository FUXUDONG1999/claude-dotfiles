import { basename } from 'node:path';

// 进度帧渲染：把任务时间线快照渲染成企微流式回复用的 markdown 文档。
// <think> 标签是企微客户端原生支持的思考过程展示格式（见官方「被动回复消息」文档）。

const THINKING_TAIL_CHAR_LIMIT = 1200;
const TOOL_DIGEST_CHAR_LIMIT = 60;
const TOOL_TIMELINE_ENTRY_LIMIT = 5;

const TOOL_STATUS_ICONS = { pending: '⏳', ok: '✅', error: '❌' };

export function renderProgressMarkdown(snapshot, elapsedSeconds) {
  const sections = [];
  const toolEntries = snapshot.toolEntries ?? [];

  if (snapshot.thinkingText) {
    sections.push(`<think>\n${keepTail(snapshot.thinkingText, THINKING_TAIL_CHAR_LIMIT)}\n</think>`);
  }

  const headerParts = [`⏳ 进行中 · ${elapsedSeconds}s`];

  if (toolEntries.length > 0) {
    const completedCount = toolEntries.filter((entry) => entry.status !== 'pending').length;
    headerParts.push(`工具 ${completedCount}/${toolEntries.length}`);
  }

  sections.push(headerParts.join(' · '));

  if (toolEntries.length > 0) {
    const timelineLines = toolEntries
      .slice(-TOOL_TIMELINE_ENTRY_LIMIT)
      .map((entry) => `- 🔧 **${entry.name}** \`${entry.digest}\` ${TOOL_STATUS_ICONS[entry.status] ?? TOOL_STATUS_ICONS.pending}`);

    sections.push(timelineLines.join('\n'));
  }

  if (snapshot.text) {
    sections.push(`---\n${snapshot.text}`);
  }

  return sections.join('\n\n');
}

// 从工具入参提取一行可读摘要，字段优先级：命令首行 > 文件名 > pattern > query > url > JSON 兜底。
export function extractToolDigest(toolName, input) {
  const source = input ?? {};
  const candidate =
    firstLine(source.command) ??
    (source.file_path ? basename(source.file_path) : null) ??
    source.pattern ??
    source.query ??
    source.url ??
    (Object.keys(source).length > 0 ? JSON.stringify(source) : '（无参数）');

  return truncateCharacters(candidate, TOOL_DIGEST_CHAR_LIMIT);
}

function keepTail(text, charLimit) {
  if (text.length <= charLimit) {
    return text;
  }

  return `…${text.slice(-charLimit)}`;
}

function truncateCharacters(text, charLimit) {
  if (text.length <= charLimit) {
    return text;
  }

  return `${text.slice(0, charLimit - 1)}…`;
}

function firstLine(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const line = text.split('\n')[0].trim();

  return line || null;
}
