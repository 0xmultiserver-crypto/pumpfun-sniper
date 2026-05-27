import pino from 'pino';
import type { LogLevel } from '../../core/types/telemetry.js';
import { DEFAULT_LOG_LEVEL } from '../../core/constants/defaults.js';

/**
 * Structured JSON logger built on pino.
 * Observability only — no side effects on business logic.
 */

/** Resolve the effective log level from environment or fallback to default. */
const resolveLogLevel = (): LogLevel => {
  const envLevel = process.env['LOG_LEVEL'];
  if (envLevel !== undefined) {
    const valid: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    if ((valid as readonly string[]).includes(envLevel)) {
      return envLevel as LogLevel;
    }
  }
  return DEFAULT_LOG_LEVEL;
};

/** Method signature shared by all log-level helpers. */
type LogMethod = (message: string, context?: Readonly<Record<string, unknown>>) => void;

/** Structured logger interface exposed to consumers. */
export interface Logger {
  readonly trace: LogMethod;
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
  readonly fatal: LogMethod;
}

/**
 * Create a child structured logger scoped to the given module name.
 *
 * @param module  Logical module identifier (e.g. "signal-engine").
 * @param level   Optional override; falls back to LOG_LEVEL env / DEFAULT_LOG_LEVEL.
 * @returns       A {@link Logger} that emits structured JSON via pino.
 */
export const createLogger = (module: string, level?: LogLevel): Logger => {
  const effectiveLevel = level ?? resolveLogLevel();

  const pinoInstance = pino({
    level: effectiveLevel,
    base: { module },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  });

  const makeMethod = (lvl: LogLevel): LogMethod => {
    return (message: string, context?: Readonly<Record<string, unknown>>): void => {
      if (context !== undefined) {
        pinoInstance[lvl]({ ...context, module }, message);
      } else {
        pinoInstance[lvl]({ module }, message);
      }
    };
  };

  return Object.freeze<Logger>({
    trace: makeMethod('trace'),
    debug: makeMethod('debug'),
    info: makeMethod('info'),
    warn: makeMethod('warn'),
    error: makeMethod('error'),
    fatal: makeMethod('fatal'),
  });
};

/** Default root logger instance for convenience imports. */
export const rootLogger: Logger = createLogger('root');
