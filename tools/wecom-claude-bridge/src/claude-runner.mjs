import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// 解析 claude -p --output-format stream-json 的逐行 NDJSON 输出。
// 每个任务实例化一个，执行状态隔离在实例上，不设全局可变状态。
export class StreamJsonAccumulator {
  constructor() {
    this.sessionId = null;
    this.accumulatedText = '';
    this.completedEvent = null;
  }

  consumeLine(rawLine) {
    const trimmedLine = rawLine.trim();

    if (!trimmedLine) {
      return null;
    }

    let parsedFrame;

    try {
      parsedFrame = JSON.parse(trimmedLine);
    } catch (parseError) {
      return null;
    }

    if (parsedFrame.type === 'system' && parsedFrame.subtype === 'init') {
      this.sessionId = parsedFrame.session_id;

      return { type: 'session_started', sessionId: parsedFrame.session_id };
    }

    if (parsedFrame.type === 'assistant') {
      return this.consumeAssistantMessage(parsedFrame.message);
    }

    if (parsedFrame.type === 'result') {
      this.completedEvent = {
        type: 'completed',
        resultText: parsedFrame.result ?? '',
        sessionId: parsedFrame.session_id ?? null,
        costUsd: parsedFrame.total_cost_usd ?? null,
        durationMilliseconds: parsedFrame.duration_ms ?? null,
        isErrorMessage: parsedFrame.is_error === true,
      };

      return this.completedEvent;
    }

    return null;
  }

  consumeAssistantMessage(assistantMessage) {
    const contentBlocks = assistantMessage?.content ?? [];
    const textBlocks = contentBlocks.filter((block) => block.type === 'text').map((block) => block.text);

    if (textBlocks.length === 0) {
      const toolUseBlock = contentBlocks.find((block) => block.type === 'tool_use');

      return toolUseBlock
        ? { type: 'assistant_activity', description: toolUseBlock.name }
        : null;
    }

    if (this.accumulatedText) {
      this.accumulatedText += '\n\n';
    }
    this.accumulatedText += textBlocks.join('\n\n');

    return { type: 'progress', text: this.accumulatedText };
  }
}

export function buildClaudeArguments({ prompt, resumeSessionId, permissionMode, allowedTools }) {
  const arguments_ = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (resumeSessionId) {
    arguments_.push('--resume', resumeSessionId);
  }

  if (permissionMode) {
    arguments_.push('--permission-mode', permissionMode);
  }

  if (allowedTools && allowedTools.length > 0) {
    arguments_.push('--allowedTools', allowedTools.join(','));
  }

  return arguments_;
}

// 运行一次无头 Claude 任务。
// 前置：configuration 已校验；工作目录存在。后置：resolve 出的任务结果总带有 resultText 与 success 标记，永不 reject。
export async function runClaudeTask(taskOptions) {
  const { prompt, resumeSessionId, workingDirectory, configuration, onProgressText, onEvent } = taskOptions;
  const accumulator = new StreamJsonAccumulator();
  const startedAtMilliseconds = Date.now();
  let stderrText = '';
  let timedOut = false;

  const childProcess = spawn(
    configuration.claudeBinaryPath,
    buildClaudeArguments({ prompt, resumeSessionId, permissionMode: configuration.permissionMode, allowedTools: configuration.allowedTools }),
    { cwd: workingDirectory },
  );

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    childProcess.kill('SIGTERM');
  }, configuration.taskTimeoutMilliseconds);
  timeoutHandle.unref();

  const closePromise = new Promise((resolveClose) => {
    childProcess.on('close', (exitCode) => resolveClose(exitCode));
  });

  const stdoutInterface = createInterface({ input: childProcess.stdout });

  stdoutInterface.on('line', (line) => {
    const event = accumulator.consumeLine(line);

    if (!event) {
      return;
    }

    if (event.type === 'progress') {
      onProgressText?.(event.text);
    }

    onEvent?.(event);
  });

  childProcess.stderr.on('data', (chunk) => {
    stderrText += chunk.toString();
  });

  const exitCode = await closePromise;
  clearTimeout(timeoutHandle);

  return buildTaskResult({ accumulator, exitCode, timedOut, stderrText, resumeSessionId, startedAtMilliseconds });
}

function buildTaskResult({ accumulator, exitCode, timedOut, stderrText, resumeSessionId, startedAtMilliseconds }) {
  const completedEvent = accumulator.completedEvent;
  const durationMilliseconds = Date.now() - startedAtMilliseconds;
  const sessionId = completedEvent?.sessionId ?? accumulator.sessionId ?? resumeSessionId ?? null;

  let resultText;
  let success;

  if (timedOut) {
    const producedText = accumulator.accumulatedText || '（无中间产出）';

    resultText = `任务超时（${Math.round(durationMilliseconds / 1000)} 秒），已被终止。终止前的产出：\n\n${producedText}`;
    success = false;
  } else if (completedEvent && !completedEvent.isErrorMessage) {
    resultText = completedEvent.resultText || accumulator.accumulatedText || '（无文本输出）';
    success = true;
  } else if (completedEvent && completedEvent.isErrorMessage) {
    resultText = completedEvent.resultText || accumulator.accumulatedText || '（无文本输出）';
    success = false;
  } else if (exitCode !== 0) {
    resultText = `claude 进程异常退出（退出码 ${exitCode}）：\n\n${stderrText.trim() || '（无 stderr 输出）'}`;
    success = false;
  } else {
    resultText = accumulator.accumulatedText || '（无文本输出）';
    success = true;
  }

  return {
    success,
    sessionId,
    resultText,
    exitCode,
    timedOut,
    costUsd: completedEvent?.costUsd ?? null,
    durationMilliseconds: completedEvent?.durationMilliseconds ?? durationMilliseconds,
  };
}
