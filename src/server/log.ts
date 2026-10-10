// Structured JSON logging + error monitoring hook.
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, proc: process.env.WORLDSTATE_PROCESS ?? 'web', msg, ...fields });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};

/** Error monitoring hook: logs, and forwards to ERROR_WEBHOOK_URL when configured. */
export function reportError(err: unknown, context: Record<string, unknown> = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  log.error(e.message, { ...context, stack: e.stack });
  const url = process.env.ERROR_WEBHOOK_URL;
  if (url) {
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: e.message, stack: e.stack, context, at: new Date().toISOString() }),
    }).catch(() => undefined);
  }
}
