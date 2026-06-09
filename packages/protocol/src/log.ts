/**
 * Minimal structured logger shared by the server and the daemon: one JSON line
 * per event on stderr (stdout stays clean for command output), filtered by
 * SYNAPSE_LOG_LEVEL (debug | info | warn | error; default info).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  component: string,
  level: string | undefined = process.env.SYNAPSE_LOG_LEVEL
): Logger {
  const threshold = LEVEL_ORDER[(level as LogLevel) ?? "info"] ?? LEVEL_ORDER.info;

  const write = (logLevel: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[logLevel] < threshold) {
      return;
    }
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: logLevel,
        component,
        event,
        ...fields
      })}\n`
    );
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}
