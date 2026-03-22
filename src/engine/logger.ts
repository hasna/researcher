/**
 * Structured logger for research engine.
 *
 * JSON-lines format with context (phase, cycle, workspace, cost).
 * Configurable verbosity. Hooks into the event emitter for automatic logging.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LogEntry {
  level: LogLevel
  timestamp: string
  message: string
  context?: Record<string, unknown>
}

export interface LoggerConfig {
  /** Minimum log level to output (default: "info") */
  level?: LogLevel
  /** Output format: "json" for JSON lines, "pretty" for human-readable (default: "pretty") */
  format?: "json" | "pretty"
  /** Custom output function (default: console.error for structured, console.log for pretty) */
  output?: (entry: LogEntry) => void
  /** Include timestamps (default: true) */
  timestamps?: boolean
}

export class ResearchLogger {
  private minLevel: number
  private format: "json" | "pretty"
  private outputFn: (entry: LogEntry) => void
  private timestamps: boolean
  private _context: Record<string, unknown> = {}

  constructor(config: LoggerConfig = {}) {
    this.minLevel = LOG_LEVELS[config.level ?? "info"]
    this.format = config.format ?? "pretty"
    this.timestamps = config.timestamps ?? true
    this.outputFn = config.output ?? ((entry) => {
      if (this.format === "json") {
        console.error(JSON.stringify(entry))
      } else {
        const ts = this.timestamps ? `\x1b[2m${entry.timestamp}\x1b[0m ` : ""
        const levelColors: Record<LogLevel, string> = {
          debug: "\x1b[2m",
          info: "\x1b[36m",
          warn: "\x1b[33m",
          error: "\x1b[31m",
        }
        const color = levelColors[entry.level]
        const ctx = entry.context && Object.keys(entry.context).length > 0
          ? ` \x1b[2m${JSON.stringify(entry.context)}\x1b[0m`
          : ""
        console.error(`${ts}${color}[${entry.level.toUpperCase()}]\x1b[0m ${entry.message}${ctx}`)
      }
    })
  }

  /** Set persistent context fields (e.g., workspaceId, cycleId) */
  setContext(ctx: Record<string, unknown>): void {
    this._context = { ...this._context, ...ctx }
  }

  /** Clear context */
  clearContext(): void {
    this._context = {}
  }

  /** Create a child logger with additional context */
  child(ctx: Record<string, unknown>): ResearchLogger {
    const child = new ResearchLogger({
      level: Object.entries(LOG_LEVELS).find(([, v]) => v === this.minLevel)?.[0] as LogLevel,
      format: this.format,
      output: this.outputFn,
      timestamps: this.timestamps,
    })
    child._context = { ...this._context, ...ctx }
    return child
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.minLevel) return
    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      message,
      context: { ...this._context, ...context },
    }
    this.outputFn(entry)
  }

  debug(message: string, context?: Record<string, unknown>): void { this.log("debug", message, context) }
  info(message: string, context?: Record<string, unknown>): void { this.log("info", message, context) }
  warn(message: string, context?: Record<string, unknown>): void { this.log("warn", message, context) }
  error(message: string, context?: Record<string, unknown>): void { this.log("error", message, context) }
}

/** Global logger singleton */
let _globalLogger: ResearchLogger | null = null

export function getLogger(): ResearchLogger {
  if (!_globalLogger) {
    _globalLogger = new ResearchLogger()
  }
  return _globalLogger
}

export function setLogger(logger: ResearchLogger): void {
  _globalLogger = logger
}

/**
 * Connect logger to event emitter for automatic structured logging.
 */
export function connectLoggerToEmitter(
  logger: ResearchLogger,
  emitter: import("./events.ts").ResearchEventEmitter,
): () => void {
  return emitter.onAny((event) => {
    const ctx = { workspaceId: event.workspaceId, ...event.data }
    switch (event.type) {
      case "cycle:start":
        logger.info(`Cycle started: ${(event.data as Record<string, unknown>).cycleName}`, ctx)
        break
      case "cycle:complete":
        logger.info(`Cycle completed (cost: $${((event.data as Record<string, unknown>).totalCost as number)?.toFixed(4)})`, ctx)
        break
      case "cycle:error":
        logger.error(`Cycle error in phase ${(event.data as Record<string, unknown>).phase}: ${(event.data as Record<string, unknown>).error}`, ctx)
        break
      case "phase:start":
        logger.info(`Phase: ${(event.data as Record<string, unknown>).phaseName} (${(event.data as Record<string, unknown>).phaseType})`, ctx)
        break
      case "phase:complete":
        logger.info(`Phase complete: ${(event.data as Record<string, unknown>).phaseName} ($${((event.data as Record<string, unknown>).cost as number)?.toFixed(4)}, ${(event.data as Record<string, unknown>).durationMs}ms)`, ctx)
        break
      case "phase:error":
        logger.error(`Phase error: ${(event.data as Record<string, unknown>).phaseName}`, ctx)
        break
      case "experiment:ranked":
        logger.info(`Experiments ranked: ${(event.data as Record<string, unknown>).completed}/${(event.data as Record<string, unknown>).total} completed`, ctx)
        break
      case "knowledge:saved":
        logger.info(`Knowledge saved: ${((event.data as Record<string, unknown>).insight as string)?.slice(0, 100)}`, ctx)
        break
      case "cost:update":
        logger.debug(`Cost: +$${((event.data as Record<string, unknown>).phaseCost as number)?.toFixed(4)} (total: $${((event.data as Record<string, unknown>).totalCost as number)?.toFixed(4)})`, ctx)
        break
      default:
        logger.debug(`Event: ${event.type}`, ctx)
    }
  })
}
