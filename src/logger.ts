import { getRequestContext } from '@hivemagnus/hive-common/context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = Record<LogLevel, (message: string, fields?: Record<string, unknown>) => void>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** JSON lines on stderr, with the request ID inside a request. Callers never pass secrets, tokens or file contents. */
export function createLogger(level: LogLevel = 'info', write: (line: string) => void = line => process.stderr.write(`${line}\n`)): Logger {
  const log = (at: LogLevel) => (message: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[at] < ORDER[level]) return;
    const requestId = getRequestContext()?.requestId;
    write(JSON.stringify({ at: new Date().toISOString(), level: at, message, ...(requestId ? { requestId } : {}), ...fields }));
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
