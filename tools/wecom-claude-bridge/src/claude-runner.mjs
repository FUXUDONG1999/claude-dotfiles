import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { extractToolDigest, renderProgressMarkdown } from './progress-view.mjs';

// 解析 claude -p --output-format stream-json 的逐行 NDJSON 输出。
// 每个任务实例化一个，执行状态隔离在实例上，不设全局可变状态。
// 除累计文本外，还维护「当前思考 + 工具调用时间线」快照，供渲染进度帧。
export class StreamJsonAccumulator {
  constructor() {
    this.sessionId = null;
    this.accumulatedText = '';
    this.currentThinkingText = '';
    this.toolEntries = [];
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

    if (parsedFrame.type === 'user') {
      return this.consumeToolResults(parsedFrame.message);
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
    let stateChanged = false;

    for (const block of contentBlocks) {
      if (block.type === 'thinking' && block.thinking) {
        this.currentThinkingText = block.thinking;
        stateChanged = true;
      } else if (block.type === 'tool_use') {
        this.toolEntries.push({
          toolUseId: block.id ?? null,
          name: block.name,
          digest: extractToolDigest(block.name, block.input),
          status: 'pending',
        });
        stateChanged = true;
      }
    }

    const textBlocks = contentBlocks.filter((block) => block.type === 'text').map((block) => block.text);

    if (textBlocks.length > 0) {
      if (this.accumulatedText) {
        this.accumulatedText += '\n\n';
      }
      this.accumulatedText += textBlocks.join('\n\n');
      stateChanged = true;
    }

    return stateChanged ? { type: 'progress', snapshot: this.buildSnapshot() } : null;
  }

  consumeToolResults(userMessage) {
    const toolResultBlocks = (userMessage?.content ?? []).filter((block) => block.type === 'tool_result');

    if (toolResultBlocks.length === 0) {
      return null;
    }

    let matchedAnyTool = false;

    for (const block of toolResultBlocks) {
      const matchingEntry = block.tool_use_id != null
        ? this.toolEntries.find((entry) => entry.toolUseId === block.tool_use_id)
        : null;

      if (!matchingEntry) {
        continue;
      }

      matchingEntry.status = block.is_error === true ? 'error' : 'ok';
      matchedAnyTool = true;
    }

    return matchedAnyTool ? { type: 'progress', snapshot: this.buildSnapshot() } : null;
  }

  buildSnapshot() {
    return {
      thinkingText: this.currentThinkingText,
      toolEntries: this.toolEntries.map((entry) => ({ ...entry })),
      text: this.accumulatedText,
    };
  }
}

export function buildClaudeArguments({ prompt, resumeSessionId, permissionMode, allowedTools, mcpServersFile, disableAllHooks }) {
  const arguments_ = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (mcpServersFile) {
    arguments_.push('--strict-mcp-config', '--mcp-config', mcpServersFile);
  }

  if (disableAllHooks) {
    arguments_.push('--settings', '{"disableAllHooks":true}');
  }

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
// onStopReady 在子进程 spawn 后同步回调，交出手动终止句柄（SIGTERM）；调用方可借此实现 /stop 类命令。
export async function runClaudeTask(taskOptions) {
  const { prompt, resumeSessionId, workingDirectory, configuration, onProgressText, onEvent, onStopReady } = taskOptions;
  const accumulator = new StreamJsonAccumulator();
  const startedAtMilliseconds = Date.now();
  let stderrText = '';
  let timedOut = false;
  let stopped = false;

  const childProcess = spawn(
    configuration.claudeBinaryPath,
    buildClaudeArguments({
      prompt,
      resumeSessionId,
      permissionMode: configuration.permissionMode,
      allowedTools: configuration.allowedTools,
      mcpServersFile: configuration.mcpServersFile,
      disableAllHooks: configuration.disableAllHooks,
    }),
    { cwd: workingDirectory },
  );

  onStopReady?.(() => {
    // 进程已退出（含自然完成）时句柄失效，避免竞态下把正常结果改写成「手动终止」。
    if (childProcess.exitCode !== null || childProcess.signalCode !== null || childProcess.killed) {
      return;
    }

    stopped = true;
    childProcess.kill('SIGTERM');
  });

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
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAtMilliseconds) / 1000));
      onProgressText?.(renderProgressMarkdown(event.snapshot, elapsedSeconds));
    }

    onEvent?.(event);
  });

  childProcess.stderr.on('data', (chunk) => {
    stderrText += chunk.toString();
  });

  const exitCode = await closePromise;
  clearTimeout(timeoutHandle);

  return buildTaskResult({ accumulator, exitCode, timedOut, stopped, stderrText, resumeSessionId, startedAtMilliseconds });
}

function buildTaskResult({ accumulator, exitCode, timedOut, stopped, stderrText, resumeSessionId, startedAtMilliseconds }) {
  const completedEvent = accumulator.completedEvent;
  const durationMilliseconds = Date.now() - startedAtMilliseconds;
  const sessionId = completedEvent?.sessionId ?? accumulator.sessionId ?? resumeSessionId ?? null;

  let resultText;
  let success;

  if (stopped) {
    const producedText = accumulator.accumulatedText || '（无中间产出）';

    resultText = `任务已被手动终止（运行 ${Math.round(durationMilliseconds / 1000)} 秒）。终止前的产出：\n\n${producedText}`;
    success = false;
  } else if (timedOut) {
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
    stopped,
    costUsd: completedEvent?.costUsd ?? null,
    durationMilliseconds: completedEvent?.durationMilliseconds ?? durationMilliseconds,
  };
}
