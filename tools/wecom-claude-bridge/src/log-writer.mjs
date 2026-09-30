import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 任务结果全文归档：企微里只发截断版，全文落盘备查。
export class TaskLogWriter {
  constructor(logDirectory) {
    this.logDirectory = logDirectory;

    mkdirSync(logDirectory, { recursive: true });
  }

  async appendTaskRecord(record) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeMessageId = (record.messageId ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${timestamp}-${safeMessageId}.md`;
    const fileContent = [
      `# 任务记录 ${record.messageId ?? ''}`,
      '',
      `- 会话：${record.chatIdentifier}`,
      `- 成功：${record.taskResult.success}`,
      `- 耗时：${record.taskResult.durationMilliseconds}ms`,
      `- Claude 会话：${record.taskResult.sessionId ?? '（无）'}`,
      '',
      '## 提示词',
      '',
      '```',
      record.prompt,
      '```',
      '',
      '## 结果',
      '',
      record.taskResult.resultText,
      '',
    ].join('\n');

    writeFileSync(join(this.logDirectory, fileName), fileContent);
  }
}
