export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}
const levels: readonly LogLevel[] = ["debug", "info", "warn", "error"];
/** Caller owns the sink; the library never writes to stdout. */
export function createLogger(
  minimum: LogLevel,
  sink: (entry: LogEntry) => void,
) {
  const write = (
    level: LogLevel,
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ) => {
    if (levels.indexOf(level) >= levels.indexOf(minimum))
      sink({ level, message, ...(context ? { context } : {}) });
  };
  return Object.fromEntries(
    levels.map((level) => [
      level,
      (message: string, context?: Readonly<Record<string, unknown>>) =>
        write(level, message, context),
    ]),
  ) as Record<
    LogLevel,
    (message: string, context?: Readonly<Record<string, unknown>>) => void
  >;
}
