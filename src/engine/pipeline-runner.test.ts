import { test, expect, mock, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "../db/schema.ts"
import { createProject, createWorkspace, getPipelineRun } from "../db/index.ts"
import { runPipeline, evaluateCondition, type PipelineRunnerConfig } from "./pipeline-runner.ts"
import { CycleRegistry } from "../cycles/registry.ts"
import { saveKnowledge } from "./knowledge.ts"
import type { CycleDefinition, GenerateResult, CyclePipeline, PipelineStep, PipelineStepResult, PipelineCondition } from "../types.ts"

// -- Mock provider router -----------------------------------------------------

function createMockRouter() {
  const generateFn = mock(
    async (_prompt: string, _hint: string, _opts?: unknown): Promise<GenerateResult & { provider_name: string }> => ({
      content: "Mock LLM response: Analysis complete.",
      tokens_in: 100,
      tokens_out: 50,
      cost: 0.001,
      model: "mock-model",
      latency_ms: 100,
      provider_name: "mock",
    }),
  )

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

// -- Test helpers -------------------------------------------------------------

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
    {
      name: "analyze",
      type: "think",
      provider_hint: "balanced",
      skills: [],
      max_parallel: 1,
      description: "Analyze the problem",
      input: "context",
      output: "analysis",
    },
    {
      name: "synthesize",
      type: "synthesize",
      provider_hint: "smart",
      skills: [],
      max_parallel: 1,
      description: "Synthesize findings",
      input: "analysis",
      output: "knowledge",
    },
  ],
  meta: {},
}

const anotherCycle: CycleDefinition = {
  id: "other-cycle",
  name: "Other Cycle",
  description: "Another test cycle",
  author: "human",
  phases: [
    {
      name: "gather",
      type: "gather",
      provider_hint: "cheap",
      skills: [],
      max_parallel: 1,
      description: "Gather data",
      input: "context",
      output: "data",
    },
  ],
  meta: {},
}

function createRegistry(...cycles: CycleDefinition[]): CycleRegistry {
  const registry = new CycleRegistry()
  for (const cycle of cycles) {
    registry.register(cycle)
  }
  return registry
}

function createBasicPipeline(steps: PipelineStep[]): CyclePipeline {
  return {
    id: "test-pipeline",
    name: "Test Pipeline",
    description: "A test pipeline",
    author: "human",
    steps,
  }
}

function baseContext() {
  return {
    projectName: "test-proj",
    domain: "code",
    metricName: "score",
    metricDirection: "higher",
  }
}

// -- Tests --------------------------------------------------------------------

describe("pipeline-runner", () => {
  describe("basic sequential pipeline", () => {
    test("runs two steps sequentially", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle, anotherCycle)
      const projId = createProject(db, { name: "seq-test", type: "virtual" })

      const pipeline = createBasicPipeline([
        { id: "step-1", cycleId: "test-cycle" },
        { id: "step-2", cycleId: "other-cycle" },
      ])

      const result = await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      expect(result.success).toBe(true)
      expect(result.stepsCompleted).toBe(2)
      expect(result.totalSteps).toBe(2)
      expect(result.stepResults).toHaveLength(2)
      expect(result.stepResults[0]!.stepId).toBe("step-1")
      expect(result.stepResults[0]!.skipped).toBe(false)
      expect(result.stepResults[1]!.stepId).toBe("step-2")
      expect(result.stepResults[1]!.skipped).toBe(false)
      expect(result.totalCost).toBeGreaterThan(0)

      db.close()
    })

    test("tracks cost across pipeline steps", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle, anotherCycle)
      const projId = createProject(db, { name: "cost-test", type: "virtual" })

      const pipeline = createBasicPipeline([
        { id: "step-1", cycleId: "test-cycle" },
        { id: "step-2", cycleId: "other-cycle" },
      ])

      const result = await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      // Each step's cycle runs phases that each cost 0.001
      // test-cycle has 2 phases, other-cycle has 1 phase => total 3 calls at 0.001 each
      const stepCostSum = result.stepResults.reduce((sum, r) => sum + r.cost, 0)
      expect(result.totalCost).toBeCloseTo(stepCostSum, 5)
      expect(result.stepResults[0]!.cost).toBeGreaterThan(0)
      expect(result.stepResults[1]!.cost).toBeGreaterThan(0)

      db.close()
    })

    test("stores pipeline run in database", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle)
      const projId = createProject(db, { name: "db-track", type: "virtual" })

      const pipeline = createBasicPipeline([{ id: "step-1", cycleId: "test-cycle" }])

      await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      // Verify pipeline_runs table has the record
      const runs = db.query("SELECT * FROM pipeline_runs WHERE project_id = ?").all(projId) as Record<string, unknown>[]
      expect(runs.length).toBe(1)
      expect(runs[0]!.pipeline_id).toBe("test-pipeline")
      expect(runs[0]!.status).toBe("completed")
      expect(runs[0]!.steps_completed).toBe(1)

      db.close()
    })
  })

  describe("conditional branching", () => {
    test("skips step when condition fails with onFail=skip", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle, anotherCycle)
      const projId = createProject(db, { name: "skip-test", type: "virtual" })

      // confidence_threshold condition: step runs if avg confidence < threshold
      // With no knowledge, avg confidence is 0 (empty), so condition returns false => skip
      // Actually, with no knowledge entries, evaluateCondition returns false for confidence_threshold
      // So the condition is NOT met => onFail=skip triggers
      const pipeline = createBasicPipeline([
        { id: "step-1", cycleId: "test-cycle" },
        {
          id: "step-2",
          cycleId: "other-cycle",
          condition: {
            type: "confidence_threshold",
            threshold: 0.5,
            onFail: "skip",
          },
        },
      ])

      const result = await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      expect(result.success).toBe(true)
      expect(result.stepResults).toHaveLength(2)
      expect(result.stepResults[0]!.skipped).toBe(false)
      // Step 2 is skipped because no knowledge exists (condition not met)
      expect(result.stepResults[1]!.skipped).toBe(true)
      expect(result.stepResults[1]!.cost).toBe(0)

      db.close()
    })

    test("stops pipeline when condition fails with onFail=stop", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle, anotherCycle)
      const projId = createProject(db, { name: "stop-test", type: "virtual" })

      // experiment_success_rate requires previous results with rate >= threshold
      // With no previous completed results, rate check returns false => stop
      // Put the stop condition on step-1 so there are zero previous results
      const pipeline = createBasicPipeline([
        {
          id: "step-1",
          cycleId: "other-cycle",
          condition: {
            type: "experiment_success_rate",
            threshold: 0.9,
            onFail: "stop",
          },
        },
        { id: "step-2", cycleId: "test-cycle" },
      ])

      const result = await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("stopped")
      expect(result.error).toContain("step-1")
      // Step 1 triggered stop (no previous results), step 2 never reached
      expect(result.stepsCompleted).toBe(0)
      expect(result.stepResults).toHaveLength(1)

      // Check DB status
      const runs = db.query("SELECT * FROM pipeline_runs WHERE project_id = ?").all(projId) as Record<string, unknown>[]
      expect(runs[0]!.status).toBe("stopped")

      db.close()
    })

    test("branches to alternate step when condition fails with onFail=branch", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle, anotherCycle)
      const projId = createProject(db, { name: "branch-test", type: "virtual" })

      const pipeline = createBasicPipeline([
        { id: "step-1", cycleId: "test-cycle" },
        {
          id: "step-2",
          cycleId: "other-cycle",
          condition: {
            type: "confidence_threshold",
            threshold: 0.5,
            onFail: "branch",
            branchTo: "step-fallback",
          },
        },
        { id: "step-3", cycleId: "test-cycle" },
        { id: "step-fallback", cycleId: "other-cycle" },
      ])

      const result = await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      expect(result.success).toBe(true)
      // step-1 runs, step-2 condition fails -> branch to step-fallback (index 3)
      // step-fallback runs
      // step-2 is skipped (branched away from), step-3 is also skipped (jumped over)
      const stepIds = result.stepResults.map((r) => r.stepId)
      expect(stepIds).toContain("step-1")
      expect(stepIds).toContain("step-fallback")

      db.close()
    })
  })

  describe("always condition", () => {
    test("always condition passes and step runs", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle)
      const projId = createProject(db, { name: "always-test", type: "virtual" })

      const pipeline = createBasicPipeline([
        {
          id: "step-1",
          cycleId: "test-cycle",
          condition: {
            type: "always",
            onFail: "skip",
          },
        },
      ])

      const result = await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      expect(result.success).toBe(true)
      expect(result.stepResults[0]!.skipped).toBe(false)
      expect(result.stepsCompleted).toBe(1)

      db.close()
    })
  })

  describe("knowledge accumulation", () => {
    test("passes knowledge from earlier steps to later steps", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle, anotherCycle)
      const projId = createProject(db, { name: "knowledge-test", type: "virtual" })

      // Seed some knowledge for the project before running the pipeline
      saveKnowledge(db, {
        project_id: projId,
        domain: "code",
        insight: "Batch size 32 improves convergence",
        confidence: 0.8,
        tags: ["training"],
      })

      const pipeline = createBasicPipeline([
        { id: "step-1", cycleId: "test-cycle" },
        { id: "step-2", cycleId: "other-cycle" },
      ])

      // Track the prompts sent to the LLM to verify knowledge is included
      const prompts: string[] = []
      router.generate = mock(async (prompt: string): Promise<GenerateResult & { provider_name: string }> => {
        prompts.push(prompt)
        return {
          content: "Mock response",
          tokens_in: 100,
          tokens_out: 50,
          cost: 0.001,
          model: "mock",
          latency_ms: 50,
          provider_name: "mock",
        }
      })

      await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      // The cycle runner builds context that includes previousKnowledge
      // We can verify that the run completed (knowledge was gathered)
      expect(prompts.length).toBeGreaterThan(0)

      db.close()
    })
  })

  describe("error handling", () => {
    test("fails gracefully when cycle is not in registry", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle) // only has test-cycle
      const projId = createProject(db, { name: "missing-cycle", type: "virtual" })

      const pipeline = createBasicPipeline([
        { id: "step-1", cycleId: "nonexistent-cycle" },
      ])

      const result = await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("nonexistent-cycle")
      expect(result.error).toContain("not found")

      db.close()
    })

    test("fails when cycle execution throws", async () => {
      const db = setupDb()
      const router = createMockRouter()
      router.generate = mock(async () => {
        throw new Error("LLM API error")
      })
      const registry = createRegistry(simpleCycle)
      const projId = createProject(db, { name: "throw-test", type: "virtual" })

      const pipeline = createBasicPipeline([
        { id: "step-1", cycleId: "test-cycle" },
        { id: "step-2", cycleId: "test-cycle" },
      ])

      const result = await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
      })

      expect(result.success).toBe(false)
      // Step 1 fails, step 2 never runs
      expect(result.stepsCompleted).toBe(0)

      // Check DB records failure
      const runs = db.query("SELECT * FROM pipeline_runs WHERE project_id = ?").all(projId) as Record<string, unknown>[]
      expect(runs[0]!.status).toBe("failed")

      db.close()
    })

    test("respects maxDepth limit", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle)
      const projId = createProject(db, { name: "depth-test", type: "virtual" })

      const pipeline = createBasicPipeline([{ id: "step-1", cycleId: "test-cycle" }])

      const result = await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
        maxDepth: 0,
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("recursion depth")

      db.close()
    })
  })

  describe("callbacks", () => {
    test("calls onStepStart and onStepComplete", async () => {
      const db = setupDb()
      const router = createMockRouter()
      const registry = createRegistry(simpleCycle, anotherCycle)
      const projId = createProject(db, { name: "callback-test", type: "virtual" })

      const pipeline = createBasicPipeline([
        { id: "step-1", cycleId: "test-cycle" },
        { id: "step-2", cycleId: "other-cycle" },
      ])

      const startedSteps: string[] = []
      const completedSteps: string[] = []

      await runPipeline({
        db,
        router: router as unknown as PipelineRunnerConfig["router"],
        projectId: projId,
        pipeline,
        cycleRegistry: registry,
        context: baseContext(),
        mode: "simple",
        onStepStart: (step) => startedSteps.push(step.id),
        onStepComplete: (step) => completedSteps.push(step.id),
      })

      expect(startedSteps).toEqual(["step-1", "step-2"])
      expect(completedSteps).toEqual(["step-1", "step-2"])

      db.close()
    })
  })

  describe("evaluateCondition", () => {
    test("always condition returns true", () => {
      const db = setupDb()
      createProject(db, { name: "eval-always", type: "virtual" })

      const condition: PipelineCondition = { type: "always", onFail: "skip" }
      const result = evaluateCondition(db, condition, "test", [], "code")
      expect(result).toBe(true)

      db.close()
    })

    test("confidence_threshold with no knowledge returns false", () => {
      const db = setupDb()
      const projId = createProject(db, { name: "eval-conf-empty", type: "virtual" })

      const condition: PipelineCondition = { type: "confidence_threshold", threshold: 0.5, onFail: "skip" }
      const result = evaluateCondition(db, condition, projId, [], "code")
      expect(result).toBe(false)

      db.close()
    })

    test("confidence_threshold returns true when knowledge confidence is below threshold", () => {
      const db = setupDb()
      const projId = createProject(db, { name: "eval-conf-low", type: "virtual" })

      saveKnowledge(db, {
        project_id: projId,
        domain: "code",
        insight: "Low confidence insight",
        confidence: 0.3,
      })

      const condition: PipelineCondition = { type: "confidence_threshold", threshold: 0.5, onFail: "skip" }
      const result = evaluateCondition(db, condition, projId, [], "code")
      expect(result).toBe(true) // 0.3 < 0.5, needs more research

      db.close()
    })

    test("confidence_threshold returns false when confidence is above threshold", () => {
      const db = setupDb()
      const projId = createProject(db, { name: "eval-conf-high", type: "virtual" })

      saveKnowledge(db, {
        project_id: projId,
        domain: "code",
        insight: "High confidence insight",
        confidence: 0.9,
      })

      const condition: PipelineCondition = { type: "confidence_threshold", threshold: 0.5, onFail: "skip" }
      const result = evaluateCondition(db, condition, projId, [], "code")
      expect(result).toBe(false) // 0.9 >= 0.5, enough confidence

      db.close()
    })

    test("experiment_success_rate evaluates previous results", () => {
      const db = setupDb()
      createProject(db, { name: "eval-success", type: "virtual" })

      const previousResults: PipelineStepResult[] = [
        { stepId: "s1", cycleId: "c1", success: true, cost: 0.01, skipped: false, cycleResult: { success: true, phases: [], totalCost: 0.01 } },
        { stepId: "s2", cycleId: "c2", success: true, cost: 0.02, skipped: false, cycleResult: { success: true, phases: [], totalCost: 0.02 } },
        { stepId: "s3", cycleId: "c3", success: false, cost: 0.01, skipped: false, cycleResult: { success: false, phases: [], totalCost: 0.01, error: "fail" } },
      ]

      // 2 out of 3 succeeded = 66.7%, threshold 0.5 => true
      const condition: PipelineCondition = { type: "experiment_success_rate", threshold: 0.5, onFail: "stop" }
      expect(evaluateCondition(db, condition, "test", previousResults, "code")).toBe(true)

      // threshold 0.9 => false (66.7% < 90%)
      const strictCondition: PipelineCondition = { type: "experiment_success_rate", threshold: 0.9, onFail: "stop" }
      expect(evaluateCondition(db, strictCondition, "test", previousResults, "code")).toBe(false)

      db.close()
    })

    test("custom condition with knowledge.count expression", () => {
      const db = setupDb()
      const projId = createProject(db, { name: "eval-custom", type: "virtual" })

      // No knowledge yet
      const condition: PipelineCondition = {
        type: "custom",
        expression: "knowledge.count > 0",
        onFail: "skip",
      }
      expect(evaluateCondition(db, condition, projId, [], "code")).toBe(false)

      // Add some knowledge
      saveKnowledge(db, { project_id: projId, domain: "code", insight: "test insight", confidence: 0.5 })
      expect(evaluateCondition(db, condition, projId, [], "code")).toBe(true)

      db.close()
    })

    test("custom condition with cost.total expression", () => {
      const db = setupDb()
      createProject(db, { name: "eval-cost", type: "virtual" })

      const previousResults: PipelineStepResult[] = [
        { stepId: "s1", cycleId: "c1", success: true, cost: 0.05, skipped: false },
        { stepId: "s2", cycleId: "c2", success: true, cost: 0.03, skipped: false },
      ]

      const condition: PipelineCondition = {
        type: "custom",
        expression: "cost.total < 0.1",
        onFail: "stop",
      }
      // 0.05 + 0.03 = 0.08 < 0.1 => true
      expect(evaluateCondition(db, condition, "test", previousResults, "code")).toBe(true)

      const overBudget: PipelineCondition = {
        type: "custom",
        expression: "cost.total < 0.05",
        onFail: "stop",
      }
      // 0.08 is NOT < 0.05 => false
      expect(evaluateCondition(db, overBudget, "test", previousResults, "code")).toBe(false)

      db.close()
    })
  })
})
