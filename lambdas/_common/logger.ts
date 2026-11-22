/**
 * Minimal structured logger: one JSON line per event with level and function
 * name. CloudWatch (Lambda) or the pod log collector (Kubernetes) adds the
 * timestamp and the request correlation.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = LEVELS.indexOf(configured) === -1 ? 1 : LEVELS.indexOf(configured);

const fn = () => process.env.FUNCTION_NAME ?? 'hg';

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS.indexOf(level) < threshold) return;
  const line = { level, fn: fn(), message, ...(fields ?? {}) };
  const text = JSON.stringify(line, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
