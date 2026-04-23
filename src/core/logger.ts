/**
 * Structured logging via `pino`.
 *
 * All log entries emitted during a single tool invocation carry the same
 * `correlationId` (Property 17). Credentials are redacted via pino's path
 * redaction.
 *
 * @module core/logger
 */

import pino, { type Logger } from 'pino';

export type LogLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'fatal';

export interface LoggerOptions {
  level?: LogLevel;
  /** Destination (stdout by default). Useful for tests. */
  destination?: pino.DestinationStream;
  /** Additional keys whose values should be redacted. */
  extraRedactPaths?: string[];
}

const DEFAULT_REDACT = [
  // Config-shape tokens
  'config.agents[*].auth.token',
  'config.http.inboundAuth.token',
  // Ad-hoc keys commonly used in structured events
  '*.token',
  '*.apiKey',
  '*.authorization',
  '*.Authorization',
];

export function createLogger(options: LoggerOptions = {}): Logger {
  const redact = [...DEFAULT_REDACT, ...(options.extraRedactPaths ?? [])];
  return pino(
    {
      level: options.level ?? 'info',
      redact: {
        paths: redact,
        censor: '[REDACTED]',
      },
      base: undefined, // omit pid/hostname for compact logs
    },
    options.destination,
  );
}

/** Create a child logger bound to a correlation ID for a single invocation. */
export function withCorrelation(
  logger: Logger,
  correlationId: string,
): Logger {
  return logger.child({ correlationId });
}

export type { Logger } from 'pino';
