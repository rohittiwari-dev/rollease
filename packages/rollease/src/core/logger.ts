// ============================================================================
// Rollease SDK — Internal Logger
// Respects RolleaseConfig.logging.{level, sink}. Falls back to console.
// ============================================================================

import type { LogLevel, LoggingConfig } from "./types";

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export type RolleaseLogger = {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
};

const NOOP_LOGGER: RolleaseLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

/**
 * Build a logger from a LoggingConfig. Levels below the threshold are dropped.
 * When `sink` is omitted, falls back to `console.error|warn|info|debug`.
 */
export function createLogger(config: LoggingConfig = {}): RolleaseLogger {
  const level = config.level ?? "warn";
  if (level === "silent") return NOOP_LOGGER;

  const threshold = LEVELS[level];
  const sink =
    config.sink ??
    ((lvl, message, meta) => {
      const fn =
        lvl === "error"
          ? console.error
          : lvl === "warn"
            ? console.warn
            : lvl === "info"
              ? console.info
              : console.debug;
      if (meta !== undefined) {
        fn(`[Rollease] ${message}`, meta);
      } else {
        fn(`[Rollease] ${message}`);
      }
    });

  const make = (lvl: Exclude<LogLevel, "silent">) => {
    if (LEVELS[lvl] > threshold) return () => {};
    return (message: string, meta?: Record<string, unknown>) => {
      try {
        sink(lvl, message, meta);
      } catch {
        // Never let logging failures propagate.
      }
    };
  };

  return {
    error: make("error"),
    warn: make("warn"),
    info: make("info"),
    debug: make("debug"),
  };
}

/** Singleton noop logger for code paths where no config is available yet. */
export const noopLogger: RolleaseLogger = NOOP_LOGGER;
