/**
 * Typed event emitter for research cycle progress.
 *
 * All engine components emit events through this system. Consumers
 * (CLI terminal UI, SSE endpoints, dashboards) subscribe for real-time updates.
 */

export type ResearchEventType =
  | "cycle:start"
  | "cycle:complete"
  | "cycle:error"
  | "phase:start"
  | "phase:complete"
  | "phase:error"
  | "experiment:start"
  | "experiment:result"
  | "experiment:ranked"
  | "agent:iteration"
  | "knowledge:saved"
  | "knowledge:linked"
  | "cost:update"
  | "sandbox:created"
  | "sandbox:released"

export interface ResearchEvent {
  type: ResearchEventType
  timestamp: number
  workspaceId: string
  data: Record<string, unknown>
}

export interface CycleStartEvent extends ResearchEvent {
  type: "cycle:start"
  data: { cycleId: string; cycleName: string; phaseCount: number; mode: string }
}

export interface CycleCompleteEvent extends ResearchEvent {
  type: "cycle:complete"
  data: { cycleId: string; success: boolean; totalCost: number; phasesCompleted: number }
}

export interface CycleErrorEvent extends ResearchEvent {
  type: "cycle:error"
  data: { cycleId: string; phase: string; error: string }
}

export interface PhaseStartEvent extends ResearchEvent {
  type: "phase:start"
  data: { phaseName: string; phaseType: string; phaseIndex: number; totalPhases: number; providerHint: string }
}

export interface PhaseCompleteEvent extends ResearchEvent {
  type: "phase:complete"
  data: { phaseName: string; phaseType: string; success: boolean; cost: number; durationMs: number; summary: string }
}

export interface PhaseErrorEvent extends ResearchEvent {
  type: "phase:error"
  data: { phaseName: string; error: string }
}

export interface ExperimentStartEvent extends ResearchEvent {
  type: "experiment:start"
  data: { experimentIndex: number; totalExperiments: number; hypothesis: string; sandboxId?: string }
}

export interface ExperimentResultEvent extends ResearchEvent {
  type: "experiment:result"
  data: { experimentIndex: number; hypothesis: string; success: boolean; metrics: Record<string, number>; decision: string }
}

export interface ExperimentRankedEvent extends ResearchEvent {
  type: "experiment:ranked"
  data: { total: number; completed: number; crashed: number; winner?: { hypothesis: string; metrics: Record<string, number> } }
}

export interface AgentIterationEvent extends ResearchEvent {
  type: "agent:iteration"
  data: { agentName: string; iteration: number; maxIterations: number; thought: string; toolCall?: string }
}

export interface KnowledgeSavedEvent extends ResearchEvent {
  type: "knowledge:saved"
  data: { knowledgeId: string; insight: string; confidence: number; domain: string }
}

export interface KnowledgeLinkedEvent extends ResearchEvent {
  type: "knowledge:linked"
  data: { sourceId: string; targetId: string; relationship: string; weight: number }
}

export interface CostUpdateEvent extends ResearchEvent {
  type: "cost:update"
  data: { phaseCost: number; totalCost: number; provider: string; model: string; tokensIn: number; tokensOut: number }
}

export interface SandboxCreatedEvent extends ResearchEvent {
  type: "sandbox:created"
  data: { sandboxId: string; type: string; hypothesis?: string }
}

export interface SandboxReleasedEvent extends ResearchEvent {
  type: "sandbox:released"
  data: { sandboxId: string; type: string }
}

export type TypedResearchEvent =
  | CycleStartEvent
  | CycleCompleteEvent
  | CycleErrorEvent
  | PhaseStartEvent
  | PhaseCompleteEvent
  | PhaseErrorEvent
  | ExperimentStartEvent
  | ExperimentResultEvent
  | ExperimentRankedEvent
  | AgentIterationEvent
  | KnowledgeSavedEvent
  | KnowledgeLinkedEvent
  | CostUpdateEvent
  | SandboxCreatedEvent
  | SandboxReleasedEvent

type EventHandler<T extends ResearchEventType = ResearchEventType> = (
  event: Extract<TypedResearchEvent, { type: T }>
) => void

type WildcardHandler = (event: TypedResearchEvent) => void

/**
 * Typed event emitter for research cycle events.
 *
 * Usage:
 *   const emitter = new ResearchEventEmitter()
 *   emitter.on("phase:start", (e) => console.log(e.data.phaseName))
 *   emitter.on("*", (e) => log(e))  // wildcard — all events
 */
export class ResearchEventEmitter {
  private handlers = new Map<string, Set<EventHandler<any>>>()
  private wildcardHandlers = new Set<WildcardHandler>()
  private _eventLog: TypedResearchEvent[] = []
  private _maxLogSize: number

  constructor(opts?: { maxLogSize?: number }) {
    this._maxLogSize = opts?.maxLogSize ?? 1000
  }

  /** Subscribe to a specific event type */
  on<T extends ResearchEventType>(type: T, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler as EventHandler<any>)
    return () => this.off(type, handler)
  }

  /** Subscribe to ALL events */
  onAny(handler: WildcardHandler): () => void {
    this.wildcardHandlers.add(handler)
    return () => this.wildcardHandlers.delete(handler)
  }

  /** Unsubscribe from a specific event type */
  off<T extends ResearchEventType>(type: T, handler: EventHandler<T>): void {
    this.handlers.get(type)?.delete(handler as EventHandler<any>)
  }

  /** Emit an event to all matching subscribers */
  emit(event: TypedResearchEvent): void {
    // Log the event
    this._eventLog.push(event)
    if (this._eventLog.length > this._maxLogSize) {
      this._eventLog.shift()
    }

    // Notify type-specific handlers
    const typeHandlers = this.handlers.get(event.type)
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          handler(event)
        } catch {
          // Don't let handler errors break the emitter
        }
      }
    }

    // Notify wildcard handlers
    for (const handler of this.wildcardHandlers) {
      try {
        handler(event)
      } catch {
        // Don't let handler errors break the emitter
      }
    }
  }

  /** Get the event log (most recent events) */
  get eventLog(): readonly TypedResearchEvent[] {
    return this._eventLog
  }

  /** Clear all handlers */
  clear(): void {
    this.handlers.clear()
    this.wildcardHandlers.clear()
  }

  /** Clear the event log */
  clearLog(): void {
    this._eventLog = []
  }

  /** Create a helper that emits events bound to a workspace ID */
  forWorkspace(workspaceId: string) {
    return {
      emit: (type: ResearchEventType, data: Record<string, unknown>) => {
        this.emit({
          type,
          timestamp: Date.now(),
          workspaceId,
          data,
        } as TypedResearchEvent)
      },
      cycleStart: (cycleId: string, cycleName: string, phaseCount: number, mode: string) => {
        this.emit({ type: "cycle:start", timestamp: Date.now(), workspaceId, data: { cycleId, cycleName, phaseCount, mode } })
      },
      cycleComplete: (cycleId: string, success: boolean, totalCost: number, phasesCompleted: number) => {
        this.emit({ type: "cycle:complete", timestamp: Date.now(), workspaceId, data: { cycleId, success, totalCost, phasesCompleted } })
      },
      cycleError: (cycleId: string, phase: string, error: string) => {
        this.emit({ type: "cycle:error", timestamp: Date.now(), workspaceId, data: { cycleId, phase, error } })
      },
      phaseStart: (phaseName: string, phaseType: string, phaseIndex: number, totalPhases: number, providerHint: string) => {
        this.emit({ type: "phase:start", timestamp: Date.now(), workspaceId, data: { phaseName, phaseType, phaseIndex, totalPhases, providerHint } })
      },
      phaseComplete: (phaseName: string, phaseType: string, success: boolean, cost: number, durationMs: number, summary: string) => {
        this.emit({ type: "phase:complete", timestamp: Date.now(), workspaceId, data: { phaseName, phaseType, success, cost, durationMs, summary } })
      },
      phaseError: (phaseName: string, error: string) => {
        this.emit({ type: "phase:error", timestamp: Date.now(), workspaceId, data: { phaseName, error } })
      },
      experimentStart: (experimentIndex: number, totalExperiments: number, hypothesis: string, sandboxId?: string) => {
        this.emit({ type: "experiment:start", timestamp: Date.now(), workspaceId, data: { experimentIndex, totalExperiments, hypothesis, sandboxId } })
      },
      experimentResult: (experimentIndex: number, hypothesis: string, success: boolean, metrics: Record<string, number>, decision: string) => {
        this.emit({ type: "experiment:result", timestamp: Date.now(), workspaceId, data: { experimentIndex, hypothesis, success, metrics, decision } })
      },
      experimentRanked: (total: number, completed: number, crashed: number, winner?: { hypothesis: string; metrics: Record<string, number> }) => {
        this.emit({ type: "experiment:ranked", timestamp: Date.now(), workspaceId, data: { total, completed, crashed, winner } })
      },
      agentIteration: (agentName: string, iteration: number, maxIterations: number, thought: string, toolCall?: string) => {
        this.emit({ type: "agent:iteration", timestamp: Date.now(), workspaceId, data: { agentName, iteration, maxIterations, thought, toolCall } })
      },
      knowledgeSaved: (knowledgeId: string, insight: string, confidence: number, domain: string) => {
        this.emit({ type: "knowledge:saved", timestamp: Date.now(), workspaceId, data: { knowledgeId, insight, confidence, domain } })
      },
      knowledgeLinked: (sourceId: string, targetId: string, relationship: string, weight: number) => {
        this.emit({ type: "knowledge:linked", timestamp: Date.now(), workspaceId, data: { sourceId, targetId, relationship, weight } })
      },
      costUpdate: (phaseCost: number, totalCost: number, provider: string, model: string, tokensIn: number, tokensOut: number) => {
        this.emit({ type: "cost:update", timestamp: Date.now(), workspaceId, data: { phaseCost, totalCost, provider, model, tokensIn, tokensOut } })
      },
      sandboxCreated: (sandboxId: string, type: string, hypothesis?: string) => {
        this.emit({ type: "sandbox:created", timestamp: Date.now(), workspaceId, data: { sandboxId, type, hypothesis } })
      },
      sandboxReleased: (sandboxId: string, type: string) => {
        this.emit({ type: "sandbox:released", timestamp: Date.now(), workspaceId, data: { sandboxId, type } })
      },
    }
  }
}

/** Global singleton emitter — used by default if no emitter is passed to cycle runner */
let _globalEmitter: ResearchEventEmitter | null = null

export function getGlobalEmitter(): ResearchEventEmitter {
  if (!_globalEmitter) {
    _globalEmitter = new ResearchEventEmitter()
  }
  return _globalEmitter
}

export function setGlobalEmitter(emitter: ResearchEventEmitter): void {
  _globalEmitter = emitter
}
