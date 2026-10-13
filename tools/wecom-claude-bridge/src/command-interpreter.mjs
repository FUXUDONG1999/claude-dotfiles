// 解析桥接内置斜杠命令；非命令消息返回 null，交由 Claude 处理。
export function interpretCommand(messageContent) {
  const trimmedContent = messageContent.trim();

  if (trimmedContent === '/new' || trimmedContent === '/reset') {
    return { name: 'resetSession' };
  }

  if (trimmedContent === '/status') {
    return { name: 'queryStatus' };
  }

  // 「暂停/停止/终止任务」是用户催停时的自然说法，与 /stop 等价，避免被当成新任务执行。
  if (trimmedContent === '/stop' || ['停止任务', '终止任务', '暂停任务'].includes(trimmedContent)) {
    return { name: 'stopTask' };
  }

  if (trimmedContent === '/resume') {
    return { name: 'listResumableSessions' };
  }

  const resumeSelectionMatch = trimmedContent.match(/^\/resume\s+([1-9]\d*)$/);

  if (resumeSelectionMatch) {
    return { name: 'selectResumableSession', index: Number(resumeSelectionMatch[1]) };
  }

  const workingDirectoryMatch = trimmedContent.match(/^\/cwd\s+(.+)$/);

  if (workingDirectoryMatch) {
    return { name: 'setWorkingDirectory', workingDirectory: workingDirectoryMatch[1].trim() };
  }

  return null;
}
