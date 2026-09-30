import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_ENVIRONMENT_KEYS = ['BOT_ID', 'BOT_SECRET', 'ALLOWED_USER_IDS', 'DEFAULT_WORKING_DIRECTORY'];

// 加载并校验配置：.env 文件（不覆盖已有环境变量）→ 必填校验 → 目录校验 → 类型归一。
// 前置：无。后置：返回的目录字段均为绝对路径且已创建；任一校验失败抛 Error。
export function loadConfiguration(environment = process.env) {
  const mergedEnvironment = { ...readDotEnvFile(), ...environment };
  const missingKeys = REQUIRED_ENVIRONMENT_KEYS.filter((requiredKey) => !mergedEnvironment[requiredKey]);

  if (missingKeys.length > 0) {
    throw new Error(`缺少必填配置：${missingKeys.join('、')}。请在项目根目录创建 .env 文件，模板见 README.md。`);
  }

  const defaultWorkingDirectory = resolve(mergedEnvironment.DEFAULT_WORKING_DIRECTORY);

  if (!existsSync(defaultWorkingDirectory) || !statSync(defaultWorkingDirectory).isDirectory()) {
    throw new Error(`DEFAULT_WORKING_DIRECTORY 不是已存在的目录：${defaultWorkingDirectory}`);
  }

  const stateDirectory = resolve(mergedEnvironment.STATE_DIRECTORY ?? './state');
  const logDirectory = resolve(mergedEnvironment.LOG_DIRECTORY ?? './logs');

  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(logDirectory, { recursive: true });

  return {
    botId: mergedEnvironment.BOT_ID,
    botSecret: mergedEnvironment.BOT_SECRET,
    allowedUserIds: new Set(splitCommaSeparated(mergedEnvironment.ALLOWED_USER_IDS)),
    defaultWorkingDirectory,
    claudeBinaryPath: mergedEnvironment.CLAUDE_BINARY_PATH ?? 'claude',
    permissionMode: mergedEnvironment.PERMISSION_MODE ?? 'acceptEdits',
    allowedTools: splitCommaSeparated(mergedEnvironment.ALLOWED_TOOLS ?? ''),
    taskTimeoutMilliseconds: readPositiveNumber(mergedEnvironment.TASK_TIMEOUT_MINUTES, 30) * 60_000,
    streamIntervalMilliseconds: readPositiveNumber(mergedEnvironment.STREAM_INTERVAL_MILLISECONDS, 2000),
    streamHardDeadlineMilliseconds: readPositiveNumber(mergedEnvironment.STREAM_HARD_DEADLINE_MILLISECONDS, 300_000),
    maxConcurrentTasks: readPositiveNumber(mergedEnvironment.MAX_CONCURRENT_TASKS, 3),
    chatSessionContinuationEnabled: mergedEnvironment.CONTINUE_SESSION_PER_CHAT === 'true',
    stateDirectory,
    logDirectory,
    hardDeadlineNoticeText: '任务仍在运行（超过企微流式时间限制）',
  };
}

function readDotEnvFile(dotEnvFilePath = resolve('./.env')) {
  if (!existsSync(dotEnvFilePath)) {
    return {};
  }

  const dotEnvEntries = {};

  for (const rawLine of readFileSync(dotEnvFilePath, 'utf8').split('\n')) {
    const trimmedLine = rawLine.trim();

    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = stripQuotationMarks(trimmedLine.slice(separatorIndex + 1).trim());

    dotEnvEntries[key] = value;
  }

  return dotEnvEntries;
}

function stripQuotationMarks(value) {
  const quotationMatch = value.match(/^['"](.*)['"]$/);

  return quotationMatch ? quotationMatch[1] : value;
}

function splitCommaSeparated(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readPositiveNumber(value, fallbackValue) {
  const parsedNumber = Number(value);

  if (!Number.isFinite(parsedNumber) || parsedNumber <= 0) {
    return fallbackValue;
  }

  return parsedNumber;
}
