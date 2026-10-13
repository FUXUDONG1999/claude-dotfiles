// 解析桥接内置斜杠命令；非命令消息返回 null，交由 Claude 处理。
export function interpretCommand(messageContent) {
  const trimmedContent = messageContent.trim();

  if (trimmedContent === '/new' || trimmedContent === '/reset') {
    return { name: 'resetSession' };
  }

  if (trimmedContent === '/status') {
    return { name: 'queryStatus' };
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
