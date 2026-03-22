import { test, expect, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "../db/schema.ts"
import { createProject, createWorkspace, getWorkspace } from "../db/index.ts"
import { runCycle, type CycleRunnerConfig } from "./cycle-runner.ts"
import type { CycleDefinition, GenerateResult } from "../types.ts"

// ─── Mock provider router ────────────────────────────────────────────────────

function createMockRouter() {
  const generateFn = mock(async (_prompt: string, _hint: string, _opts?: unknown): Promise<GenerateResult & { provider_name: string }> => ({
    content: "Mock LLM response: Analysis complete.",
    tokens_in: 100,
    tokens_out: 50,
    cost: 0.001,
    model: "mock-model",
    latency_ms: 100,
    provider_name: "mock",
  }))

  return {
    generate: generateFn,
    resolve: mock(() => ({
      name: "mock",
      generate: async () => ({ content: "mock", tokens_in: 0, tokens_out: 0, cost: 0, model: "mock", latency_ms: 0 }),
      estimateCost: () => 0,
    })),
    listProviders: () => ["mock"],
    hasProvider: () => true,
  }
}

// ─── Test helpers ────────────────────────────────────────────────────────────

function setupDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  db.run("INSERT INTO schema_version (version) VALUES (1)")
  return db
}

const simpleCycle: CycleDefinition = {
  id: "test-cycle",
  name: "Test Cycle",
  description: "A test cycle",
  author: "human",
  phases: [
    { name: "analyze", type: "think", provider_hint: "balanced", skills: [], max_parallel: 1, description: "Analyze the problem", input: "context", output: "analysis" },
    { name: "synthesize", type: "synthesize", provider_hint: "smart", skills: [], max_parallel: 1, description: "Synthesize findings", input: "analysis", output: "knowledge" },
  ],
  meta: {},
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("run a simple 2-phase cycle", async () => {
  const db = setupDb()
  const router = createMockRouter()
  const projId = createProject(db, { name: "test-proj", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "test-cycle" })

  const result = await runCycle({
    db,
    router: router as unknown as CycleRunnerConfig["router"],
    workspaceId: wsId,
    projectId: projId,
    cycle: simpleCycle,
    mode: "simple",
    context: {
      projectName: "test-proj",
      domain: "code",
      metricName: "val_bpb",
      metricDirection: "lower",
    },
  })

  expect(result.success).toBe(true)
  expect(result.phases).toHaveLength(2)
  expect(result.phases[0]!.phaseName).toBe("analyze")
  expect(result.phases[1]!.phaseName).toBe("synthesize")
  expect(result.totalCost).toBeGreaterThan(0)

  // Workspace should be marked completed
  const ws = getWorkspace(db, wsId) as Record<string, unknown>
  expect(ws.status).toBe("completed")

  // LLM should have been called twice (once per phase)
  expect(router.generate).toHaveBeenCalledTimes(2)

  db.close()
})

test("cycle updates workspace phase during execution", async () => {
  const db = setupDb()
  const router = createMockRouter()
  const projId = createProject(db, { name: "phase-track", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "test-cycle" })

  const phaseNames: string[] = []
  await runCycle({
    db,
    router: router as unknown as CycleRunnerConfig["router"],
    workspaceId: wsId,
    projectId: projId,
    cycle: simpleCycle,
    mode: "simple",
    context: {
      projectName: "phase-track",
      domain: "code",
      metricName: "score",
      metricDirection: "higher",
    },
    onPhaseStart: (phase) => phaseNames.push(phase.name),
  })

  expect(phaseNames).toEqual(["analyze", "synthesize"])
  db.close()
})

test("cycle handles phase failure gracefully", async () => {
  const db = setupDb()
  const failRouter = createMockRouter()
  failRouter.generate = mock(async () => {
    throw new Error("LLM API error")
  })

  const projId = createProject(db, { name: "fail-test", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "test-cycle" })

  const result = await runCycle({
    db,
    router: failRouter as unknown as CycleRunnerConfig["router"],
    workspaceId: wsId,
    projectId: projId,
    cycle: simpleCycle,
    mode: "simple",
    context: {
      projectName: "fail-test",
      domain: "code",
      metricName: "score",
      metricDirection: "higher",
    },
  })

  expect(result.success).toBe(false)
  expect(result.error).toContain("LLM API error")

  const ws = getWorkspace(db, wsId) as Record<string, unknown>
  expect(ws.status).toBe("failed")

  db.close()
})

test("cycle runs all 5 phase types", async () => {
  const db = setupDb()
  const router = createMockRouter()
  const projId = createProject(db, { name: "all-phases", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "full" })

  const fullCycle: CycleDefinition = {
    id: "full",
    name: "Full",
    description: "",
    author: "human",
    phases: [
      { name: "think", type: "think", provider_hint: "balanced", skills: [], max_parallel: 1, description: "", input: "", output: "" },
      { name: "gather", type: "gather", provider_hint: "cheap", skills: [], max_parallel: 1, description: "", input: "", output: "" },
      { name: "experiment", type: "parallel_experiment", provider_hint: "user_choice", skills: [], max_parallel: 5, description: "", input: "", output: "" },
      { name: "escalate", type: "escalate", provider_hint: "smart", skills: [], max_parallel: 1, description: "", input: "", output: "" },
      { name: "synth", type: "synthesize", provider_hint: "best", skills: [], max_parallel: 1, description: "", input: "", output: "" },
    ],
    meta: {},
  }

  const result = await runCycle({
    db,
    router: router as unknown as CycleRunnerConfig["router"],
    workspaceId: wsId,
    projectId: projId,
    cycle: fullCycle,
    mode: "simple",
    context: { projectName: "all", domain: "code", metricName: "score", metricDirection: "higher" },
  })

  expect(result.success).toBe(true)
  expect(result.phases).toHaveLength(5)
  expect(router.generate).toHaveBeenCalledTimes(5)
  db.close()
})
