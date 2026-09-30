import { format } from 'node:util';

export function createLogger(prefix) {
  const writeLogLine = (level, message, ...arguments_) => {
    const suffix = arguments_.length > 0 ? ` ${format(...arguments_)}` : '';
    const timestamp = new Date().toISOString();

    process.stdout.write(`[${timestamp}] [${prefix}] [${level}] ${message}${suffix}\n`);
  };

  return {
    debug: (message, ...arguments_) => writeLogLine('DEBUG', message, ...arguments_),
    info: (message, ...arguments_) => writeLogLine('INFO', message, ...arguments_),
    warn: (message, ...arguments_) => writeLogLine('WARN', message, ...arguments_),
    error: (message, ...arguments_) => writeLogLine('ERROR', message, ...arguments_),
  };
}
