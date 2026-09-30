// 解析桥接内置斜杠命令；非命令消息返回 null，交由 Claude 处理。
export function interpretCommand(messageContent) {
  const trimmedContent = messageContent.trim();

  if (trimmedContent === '/new' || trimmedContent === '/reset') {
    return { name: 'resetSession' };
  }

  if (trimmedContent === '/status') {
    return { name: 'queryStatus' };
  }

  const workingDirectoryMatch = trimmedContent.match(/^\/cwd\s+(.+)$/);

  if (workingDirectoryMatch) {
    return { name: 'setWorkingDirectory', workingDirectory: workingDirectoryMatch[1].trim() };
  }

  return null;
}
