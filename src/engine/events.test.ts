import { test, expect, mock } from "bun:test"
import { ResearchEventEmitter, getGlobalEmitter, type TypedResearchEvent, type PhaseStartEvent } from "./events.ts"

test("emits typed events to subscribers", () => {
  const emitter = new ResearchEventEmitter()
  const events: TypedResearchEvent[] = []
  emitter.on("phase:start", (e) => events.push(e))

  const ev = emitter.forWorkspace("ws-1")
  ev.phaseStart("analyze", "think", 0, 4, "balanced")

  expect(events).toHaveLength(1)
  expect(events[0]!.type).toBe("phase:start")
  expect((events[0] as PhaseStartEvent).data.phaseName).toBe("analyze")
  expect((events[0] as PhaseStartEvent).data.phaseType).toBe("think")
})

test("wildcard handler receives all events", () => {
  const emitter = new ResearchEventEmitter()
  const all: TypedResearchEvent[] = []
  emitter.onAny((e) => all.push(e))

  const ev = emitter.forWorkspace("ws-2")
  ev.cycleStart("pflk", "PFLK", 4, "agentic")
  ev.phaseStart("gather", "gather", 1, 4, "cheap")
  ev.phaseComplete("gather", "gather", true, 0.01, 500, "Done")

  expect(all).toHaveLength(3)
  expect(all.map(e => e.type)).toEqual(["cycle:start", "phase:start", "phase:complete"])
})

test("unsubscribe works", () => {
  const emitter = new ResearchEventEmitter()
  const events: TypedResearchEvent[] = []
  const unsub = emitter.on("cost:update", (e) => events.push(e))

  const ev = emitter.forWorkspace("ws-3")
  ev.costUpdate(0.01, 0.01, "openai", "gpt-4", 100, 50)
  expect(events).toHaveLength(1)

  unsub()
  ev.costUpdate(0.02, 0.03, "openai", "gpt-4", 200, 100)
  expect(events).toHaveLength(1) // no new event after unsub
})

test("event log captures events", () => {
  const emitter = new ResearchEventEmitter({ maxLogSize: 5 })
  const ev = emitter.forWorkspace("ws-4")

  for (let i = 0; i < 7; i++) {
    ev.phaseStart(`phase-${i}`, "think", i, 7, "balanced")
  }

  // Only last 5 should be in log
  expect(emitter.eventLog).toHaveLength(5)
  expect((emitter.eventLog[0] as PhaseStartEvent).data.phaseName).toBe("phase-2")
})

test("handler errors don't break emitter", () => {
  const emitter = new ResearchEventEmitter()
  const goodEvents: TypedResearchEvent[] = []

  emitter.on("phase:start", () => { throw new Error("boom") })
  emitter.on("phase:start", (e) => goodEvents.push(e))

  const ev = emitter.forWorkspace("ws-5")
  ev.phaseStart("test", "think", 0, 1, "balanced")

  // Good handler still received the event despite bad handler throwing
  expect(goodEvents).toHaveLength(1)
})

test("forWorkspace binds workspace ID", () => {
  const emitter = new ResearchEventEmitter()
  const events: TypedResearchEvent[] = []
  emitter.onAny((e) => events.push(e))

  const ev = emitter.forWorkspace("my-workspace")
  ev.experimentStart(0, 5, "try doubling learning rate", "sb-1")

  expect(events[0]!.workspaceId).toBe("my-workspace")
  expect((events[0]!.data as Record<string, unknown>).sandboxId).toBe("sb-1")
})

test("global emitter singleton works", () => {
  const emitter = getGlobalEmitter()
  expect(emitter).toBeInstanceOf(ResearchEventEmitter)
  // Same instance on second call
  expect(getGlobalEmitter()).toBe(emitter)
})

test("clear removes all handlers", () => {
  const emitter = new ResearchEventEmitter()
  const events: TypedResearchEvent[] = []
  emitter.on("phase:start", (e) => events.push(e))
  emitter.onAny((e) => events.push(e))

  emitter.clear()

  const ev = emitter.forWorkspace("ws-6")
  ev.phaseStart("test", "think", 0, 1, "balanced")

  expect(events).toHaveLength(0)
})

test("all event convenience methods work", () => {
  const emitter = new ResearchEventEmitter()
  const types: string[] = []
  emitter.onAny((e) => types.push(e.type))

  const ev = emitter.forWorkspace("ws-7")
  ev.cycleStart("pflk", "PFLK", 4, "agentic")
  ev.cycleComplete("pflk", true, 0.05, 4)
  ev.cycleError("pflk", "synthesize", "timeout")
  ev.phaseStart("p1", "think", 0, 4, "balanced")
  ev.phaseComplete("p1", "think", true, 0.01, 100, "done")
  ev.phaseError("p1", "fail")
  ev.experimentStart(0, 3, "hyp1")
  ev.experimentResult(0, "hyp1", true, { score: 0.9 }, "keep")
  ev.experimentRanked(3, 2, 1, { hypothesis: "hyp1", metrics: { score: 0.9 } })
  ev.agentIteration("problem-agent", 1, 5, "thinking...", "query_knowledge")
  ev.knowledgeSaved("k1", "LR 0.01 works best", 0.8, "ml")
  ev.knowledgeLinked("k1", "k2", "supports", 0.9)
  ev.costUpdate(0.01, 0.05, "anthropic", "sonnet", 100, 50)
  ev.sandboxCreated("sb-1", "worktree", "hyp1")
  ev.sandboxReleased("sb-1", "worktree")

  expect(types).toEqual([
    "cycle:start", "cycle:complete", "cycle:error",
    "phase:start", "phase:complete", "phase:error",
    "experiment:start", "experiment:result", "experiment:ranked",
    "agent:iteration",
    "knowledge:saved", "knowledge:linked",
    "cost:update",
    "sandbox:created", "sandbox:released",
  ])
})
