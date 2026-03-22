/**
 * Tests for the AI Cycle Discovery engine:
 *   - Cycle Analyzer (performance metrics, comparison, domain recommendations)
 *   - Cycle Generator (validate generated cycles)
 *   - Cycle Evolution (mutation, crossover, evolve)
 */

import { test, expect, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "../db/schema.ts"
import {
  analyzeCyclePerformance,
  compareCycles,
  getBestCycleForDomain,
  getDomainRecommendations,
  getPhaseTypeEffectiveness,
} from "./cycle-analyzer.ts"
import { validateGeneratedCycle, cycleToYaml } from "./cycle-generator.ts"
import {
  mutateCycle,
  crossover,
  evolve,
  type MutationOperator,
} from "./cycle-evolution.ts"
import type { CycleDefinition, PhaseDefinition } from "../types.ts"

// ─── Helpers ────────────────────────────────────────────────────────────────

function setupDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  db.run("INSERT INTO schema_version (version) VALUES (1)")
  return db
}

function makeCycle(
  overrides: Partial<CycleDefinition> & { id: string; name: string },
): CycleDefinition {
  return {
    description: "Test cycle",
    author: "ai",
    phases: [
      makePhase({ name: "think_phase", type: "think" }),
      makePhase({ name: "gather_phase", type: "gather", provider_hint: "cheap" }),
      makePhase({
        name: "experiment_phase",
        type: "parallel_experiment",
        max_parallel: 10,
      }),
      makePhase({ name: "synth_phase", type: "synthesize", provider_hint: "smart" }),
    ],
    meta: {},
    ...overrides,
  }
}

function makePhase(overrides: Partial<PhaseDefinition> = {}): PhaseDefinition {
  return {
    name: "default_phase",
    type: "think",
    provider_hint: "balanced",
    skills: [],
    max_parallel: 1,
    description: "A test phase",
    input: "test input",
    output: "test output",
    ...overrides,
  }
}

/**
 * Seed the DB with a project, workspace, some model_calls, results, and knowledge
 * for a given cycle_id and domain.
 */
function seedCycleData(
  db: Database,
  opts: {
    cycleId: string
    domain?: string
    projectName?: string
    resultDecisions?: string[]
    knowledgeConfidence?: number[]
    modelCallPhases?: Array<{ phase: string; cost: number; latency_ms: number }>
    workspaceCost?: number
    workspaceStatus?: string
  },
): { projectId: string; workspaceId: string } {
  const domain = opts.domain ?? "general"
  const projectName = opts.projectName ?? `project-${opts.cycleId}-${Math.random().toString(36).slice(2, 8)}`

  // Create project
  const projectId = `proj-${Math.random().toString(36).slice(2, 10)}`
  db.run(
    `INSERT INTO projects (id, name, type, domain) VALUES (?, ?, 'virtual', ?)`,
    [projectId, projectName, domain],
  )

  // Create workspace
  const workspaceId = `ws-${Math.random().toString(36).slice(2, 10)}`
  const status = opts.workspaceStatus ?? "completed"
  db.run(
    `INSERT INTO workspaces (id, project_id, cycle_id, status, cost_total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now'))`,
    [workspaceId, projectId, opts.cycleId, status, opts.workspaceCost ?? 0.5],
  )

  // Add model_calls
  if (opts.modelCallPhases) {
    for (const mc of opts.modelCallPhases) {
      db.run(
        `INSERT INTO model_calls (id, workspace_id, provider, model, cost, latency_ms, phase)
         VALUES (?, ?, 'anthropic', 'claude-sonnet', ?, ?, ?)`,
        [
          `mc-${Math.random().toString(36).slice(2, 10)}`,
          workspaceId,
          mc.cost,
          mc.latency_ms,
          mc.phase,
        ],
      )
    }
  }

  // Add results
  if (opts.resultDecisions) {
    for (const decision of opts.resultDecisions) {
      const sandboxId = `sb-${Math.random().toString(36).slice(2, 10)}`
      db.run(
        `INSERT INTO sandboxes (id, workspace_id, type, hypothesis)
         VALUES (?, ?, 'tempdir', 'test hypothesis')`,
        [sandboxId, workspaceId],
      )
      db.run(
        `INSERT INTO results (id, sandbox_id, workspace_id, decision, cost)
         VALUES (?, ?, ?, ?, 0.01)`,
        [
          `res-${Math.random().toString(36).slice(2, 10)}`,
          sandboxId,
          workspaceId,
          decision,
        ],
      )
    }
  }

  // Add knowledge
  if (opts.knowledgeConfidence) {
    for (const conf of opts.knowledgeConfidence) {
      db.run(
        `INSERT INTO knowledge (id, project_id, domain, insight, confidence)
         VALUES (?, ?, ?, ?, ?)`,
        [
          `k-${Math.random().toString(36).slice(2, 10)}`,
          projectId,
          domain,
          `Insight with confidence ${conf}`,
          conf,
        ],
      )
    }
  }

  return { projectId, workspaceId }
}

// ─── Cycle Analyzer Tests ───────────────────────────────────────────────────

describe("analyzeCyclePerformance", () => {
  test("returns zero metrics for a cycle with no runs", () => {
    const db = setupDb()
    const metrics = analyzeCyclePerformance(db, "nonexistent-cycle")
    expect(metrics.cycleId).toBe("nonexistent-cycle")
    expect(metrics.runCount).toBe(0)
    expect(metrics.avgConfidence).toBe(0)
    expect(metrics.costEfficiency).toBe(0)
    expect(metrics.timeEfficiency).toBe(0)
    expect(metrics.experimentSuccessRate).toBe(0)
    expect(metrics.totalCost).toBe(0)
    expect(metrics.totalKnowledge).toBe(0)
    db.close()
  })

  test("computes metrics from seeded data", () => {
    const db = setupDb()
    seedCycleData(db, {
      cycleId: "pflk",
      domain: "code",
      workspaceCost: 1.0,
      resultDecisions: ["keep", "keep", "discard", "crash"],
      knowledgeConfidence: [0.8, 0.6],
      modelCallPhases: [
        { phase: "think", cost: 0.1, latency_ms: 500 },
        { phase: "gather", cost: 0.05, latency_ms: 200 },
        { phase: "experiment", cost: 0.3, latency_ms: 1000 },
        { phase: "synthesize", cost: 0.2, latency_ms: 800 },
      ],
    })

    const metrics = analyzeCyclePerformance(db, "pflk")
    expect(metrics.cycleId).toBe("pflk")
    expect(metrics.runCount).toBe(1)
    expect(metrics.totalCost).toBe(1.0)
    expect(metrics.totalKnowledge).toBe(2)
    expect(metrics.avgConfidence).toBeCloseTo(0.7, 1)
    expect(metrics.experimentSuccessRate).toBe(0.5) // 2 keep out of 4
    expect(metrics.costEfficiency).toBe(2.0) // 2 knowledge / $1.0
    expect(Object.keys(metrics.avgPhaseDuration)).toContain("think")
    expect(Object.keys(metrics.avgPhaseDuration)).toContain("gather")
    db.close()
  })

  test("handles multiple workspaces for same cycle", () => {
    const db = setupDb()
    seedCycleData(db, {
      cycleId: "pflk",
      domain: "code",
      projectName: "proj-a",
      workspaceCost: 0.5,
      resultDecisions: ["keep"],
      knowledgeConfidence: [0.9],
    })
    seedCycleData(db, {
      cycleId: "pflk",
      domain: "code",
      projectName: "proj-b",
      workspaceCost: 0.3,
      resultDecisions: ["keep", "discard"],
      knowledgeConfidence: [0.7],
    })

    const metrics = analyzeCyclePerformance(db, "pflk")
    expect(metrics.runCount).toBe(2)
    expect(metrics.totalCost).toBeCloseTo(0.8, 1)
    expect(metrics.totalKnowledge).toBe(2)
    db.close()
  })
})

describe("compareCycles", () => {
  test("ranks cycles by composite score", () => {
    const db = setupDb()

    // pflk: good results
    seedCycleData(db, {
      cycleId: "pflk",
      domain: "code",
      projectName: "proj-pflk",
      workspaceCost: 0.5,
      resultDecisions: ["keep", "keep", "keep"],
      knowledgeConfidence: [0.9, 0.8, 0.7],
    })

    // gree: worse results
    seedCycleData(db, {
      cycleId: "gree",
      domain: "code",
      projectName: "proj-gree",
      workspaceCost: 2.0,
      resultDecisions: ["discard", "discard", "keep"],
      knowledgeConfidence: [0.4],
    })

    const comparison = compareCycles(db, ["pflk", "gree"])
    expect(comparison.rankings).toHaveLength(2)
    expect(comparison.best).toBe("pflk")
    expect(comparison.worst).toBe("gree")
    expect(comparison.rankings[0]!.rank).toBe(1)
    expect(comparison.rankings[0]!.cycleId).toBe("pflk")
    expect(comparison.rankings[1]!.rank).toBe(2)
    db.close()
  })

  test("handles single cycle comparison", () => {
    const db = setupDb()
    seedCycleData(db, {
      cycleId: "only-one",
      domain: "code",
      projectName: "proj-only",
      workspaceCost: 0.1,
      resultDecisions: ["keep"],
      knowledgeConfidence: [0.5],
    })

    const comparison = compareCycles(db, ["only-one"])
    expect(comparison.rankings).toHaveLength(1)
    expect(comparison.best).toBe("only-one")
    expect(comparison.worst).toBe("only-one")
    db.close()
  })
})

describe("getBestCycleForDomain", () => {
  test("returns null for unknown domain", () => {
    const db = setupDb()
    const result = getBestCycleForDomain(db, "unknown-domain")
    expect(result).toBeNull()
    db.close()
  })

  test("returns the only cycle for a domain", () => {
    const db = setupDb()
    seedCycleData(db, {
      cycleId: "pflk",
      domain: "math",
      projectName: "proj-math",
      workspaceCost: 0.5,
      resultDecisions: ["keep"],
      knowledgeConfidence: [0.8],
    })

    const result = getBestCycleForDomain(db, "math")
    expect(result).toBe("pflk")
    db.close()
  })

  test("returns the best cycle among multiple for a domain", () => {
    const db = setupDb()

    seedCycleData(db, {
      cycleId: "cycle-a",
      domain: "science",
      projectName: "proj-sci-a",
      workspaceCost: 0.3,
      resultDecisions: ["keep", "keep"],
      knowledgeConfidence: [0.9, 0.85],
    })

    seedCycleData(db, {
      cycleId: "cycle-b",
      domain: "science",
      projectName: "proj-sci-b",
      workspaceCost: 3.0,
      resultDecisions: ["discard", "crash"],
      knowledgeConfidence: [0.2],
    })

    const result = getBestCycleForDomain(db, "science")
    expect(result).toBe("cycle-a")
    db.close()
  })
})

describe("getDomainRecommendations", () => {
  test("returns empty for no projects", () => {
    const db = setupDb()
    const recs = getDomainRecommendations(db)
    expect(Object.keys(recs)).toHaveLength(0)
    db.close()
  })

  test("returns recommendation per domain", () => {
    const db = setupDb()

    seedCycleData(db, {
      cycleId: "pflk",
      domain: "code",
      projectName: "proj-code",
      workspaceCost: 0.5,
      resultDecisions: ["keep"],
      knowledgeConfidence: [0.8],
    })

    seedCycleData(db, {
      cycleId: "gree",
      domain: "marketing",
      projectName: "proj-marketing",
      workspaceCost: 0.3,
      resultDecisions: ["keep"],
      knowledgeConfidence: [0.7],
    })

    const recs = getDomainRecommendations(db)
    expect(recs.code).toBe("pflk")
    expect(recs.marketing).toBe("gree")
    db.close()
  })
})

describe("getPhaseTypeEffectiveness", () => {
  test("returns empty for unknown domain", () => {
    const db = setupDb()
    const result = getPhaseTypeEffectiveness(db, "nonexistent")
    expect(result).toHaveLength(0)
    db.close()
  })

  test("returns phase stats for a domain", () => {
    const db = setupDb()
    seedCycleData(db, {
      cycleId: "pflk",
      domain: "code",
      projectName: "proj-phase-test",
      workspaceCost: 1.0,
      modelCallPhases: [
        { phase: "think", cost: 0.1, latency_ms: 500 },
        { phase: "gather", cost: 0.05, latency_ms: 200 },
        { phase: "synthesize", cost: 0.2, latency_ms: 800 },
      ],
    })

    const effectiveness = getPhaseTypeEffectiveness(db, "code")
    expect(effectiveness.length).toBeGreaterThan(0)

    const thinkPhase = effectiveness.find((e) => e.phaseType === "think")
    expect(thinkPhase).toBeDefined()
    expect(thinkPhase!.avgDuration).toBe(500)
    expect(thinkPhase!.avgCost).toBe(0.1)
    db.close()
  })
})

// ─── Cycle Generator Tests ──────────────────────────────────────────────────

describe("validateGeneratedCycle", () => {
  test("accepts a valid AI-generated cycle", () => {
    const cycle = makeCycle({ id: "test-cycle", name: "Test Cycle" })
    expect(validateGeneratedCycle(cycle)).toBe(true)
  })

  test("rejects cycle with no name", () => {
    const cycle = makeCycle({ id: "test", name: "" })
    expect(validateGeneratedCycle(cycle)).toBe(false)
  })

  test("rejects cycle with fewer than 2 phases", () => {
    const cycle: CycleDefinition = {
      id: "short",
      name: "Short",
      description: "Too short",
      author: "ai",
      phases: [makePhase()],
      meta: {},
    }
    expect(validateGeneratedCycle(cycle)).toBe(false)
  })

  test("rejects cycle with invalid phase type", () => {
    const cycle = makeCycle({ id: "bad-type", name: "Bad Type" })
    ;(cycle.phases[0] as unknown as Record<string, unknown>).type = "invalid_type"
    expect(validateGeneratedCycle(cycle)).toBe(false)
  })

  test("rejects cycle with invalid provider hint", () => {
    const cycle = makeCycle({ id: "bad-hint", name: "Bad Hint" })
    ;(cycle.phases[0] as unknown as Record<string, unknown>).provider_hint = "super_duper"
    expect(validateGeneratedCycle(cycle)).toBe(false)
  })

  test("rejects cycle with author != ai", () => {
    const cycle = makeCycle({ id: "human", name: "Human Cycle" })
    ;(cycle as unknown as Record<string, unknown>).author = "human"
    expect(validateGeneratedCycle(cycle)).toBe(false)
  })

  test("rejects cycle with max_parallel < 1", () => {
    const cycle = makeCycle({ id: "zero-par", name: "Zero Parallel" })
    cycle.phases[2]!.max_parallel = 0
    expect(validateGeneratedCycle(cycle)).toBe(false)
  })

  test("rejects cycle with no id", () => {
    const cycle = makeCycle({ id: "", name: "No Id" })
    expect(validateGeneratedCycle(cycle)).toBe(false)
  })
})

describe("cycleToYaml", () => {
  test("serializes a cycle to valid YAML", () => {
    const cycle = makeCycle({ id: "yaml-test", name: "YAML Test" })
    const yaml = cycleToYaml(cycle)
    expect(yaml).toContain("name: YAML Test")
    expect(yaml).toContain("author: ai")
    expect(yaml).toContain("type: think")
    expect(yaml).toContain("type: gather")
    expect(yaml).toContain("type: parallel_experiment")
    expect(yaml).toContain("type: synthesize")
  })
})

// ─── Cycle Evolution Tests ──────────────────────────────────────────────────

describe("mutateCycle", () => {
  test("swap_phases reorders phases", () => {
    const original = makeCycle({ id: "orig", name: "Original" })
    const mutated = mutateCycle(original, "swap_phases")
    // Should have the same number of phases
    expect(mutated.phases).toHaveLength(original.phases.length)
    // The mutated cycle should have a different name
    expect(mutated.name).toContain("-mut-")
    // Author should be "ai"
    expect(mutated.author).toBe("ai")
  })

  test("change_provider_hint changes a hint", () => {
    const original = makeCycle({ id: "orig", name: "Original" })
    const mutated = mutateCycle(original, "change_provider_hint")
    expect(mutated.phases).toHaveLength(original.phases.length)

    // At least one phase should have a different hint (very likely with 4 phases)
    const originalHints = original.phases.map((p) => p.provider_hint)
    const mutatedHints = mutated.phases.map((p) => p.provider_hint)
    // The arrays should differ in at least one position
    const hasDifference = originalHints.some((h, i) => h !== mutatedHints[i])
    expect(hasDifference).toBe(true)
  })

  test("adjust_parallelism changes max_parallel", () => {
    // Use a cycle with a high-parallelism experiment phase so the mutation
    // is very likely to produce a visible change (random factor 0.5-2x on 10
    // almost always yields a different integer).
    const original = makeCycle({ id: "orig", name: "Original" })
    // Run multiple attempts — the mutation is random, so allow a few tries
    let foundDifference = false
    for (let attempt = 0; attempt < 10; attempt++) {
      const mutated = mutateCycle(original, "adjust_parallelism")
      expect(mutated.phases).toHaveLength(original.phases.length)
      const originalPar = original.phases.map((p) => p.max_parallel)
      const mutatedPar = mutated.phases.map((p) => p.max_parallel)
      if (originalPar.some((p, i) => p !== mutatedPar[i])) {
        foundDifference = true
        break
      }
    }
    expect(foundDifference).toBe(true)
  })

  test("add_phase increases phase count", () => {
    const original = makeCycle({ id: "orig", name: "Original" })
    const mutated = mutateCycle(original, "add_phase")
    expect(mutated.phases.length).toBe(original.phases.length + 1)
  })

  test("remove_phase decreases phase count", () => {
    const original = makeCycle({ id: "orig", name: "Original" })
    expect(original.phases.length).toBe(4) // our default has 4
    const mutated = mutateCycle(original, "remove_phase")
    expect(mutated.phases.length).toBe(3)
  })

  test("remove_phase does not go below 2 phases", () => {
    const twoPhase: CycleDefinition = {
      id: "two",
      name: "Two Phase",
      description: "Minimal",
      author: "ai",
      phases: [
        makePhase({ name: "a", type: "think" }),
        makePhase({ name: "b", type: "synthesize" }),
      ],
      meta: {},
    }
    const mutated = mutateCycle(twoPhase, "remove_phase")
    // Should fallback to a different mutation rather than removing below 2
    expect(mutated.phases.length).toBeGreaterThanOrEqual(2)
  })

  test("duplicate_phase clones with different hint", () => {
    const original = makeCycle({ id: "orig", name: "Original" })
    const mutated = mutateCycle(original, "duplicate_phase")
    expect(mutated.phases.length).toBe(original.phases.length + 1)
    // The cloned phase should have _v2 suffix
    const v2Phases = mutated.phases.filter((p) => p.name.includes("_v2"))
    expect(v2Phases.length).toBeGreaterThanOrEqual(1)
  })

  test("random mutation produces a valid cycle", () => {
    const original = makeCycle({ id: "orig", name: "Original" })
    // Run 20 random mutations — all should produce valid cycles
    for (let i = 0; i < 20; i++) {
      const mutated = mutateCycle(original)
      expect(mutated.phases.length).toBeGreaterThanOrEqual(2)
      expect(mutated.author).toBe("ai")
      expect(mutated.id).toBeTruthy()
      expect(mutated.name).toBeTruthy()
      for (const phase of mutated.phases) {
        expect(["think", "gather", "parallel_experiment", "synthesize", "escalate"]).toContain(
          phase.type,
        )
        expect(["cheap", "balanced", "smart", "best", "user_choice"]).toContain(
          phase.provider_hint,
        )
        expect(phase.max_parallel).toBeGreaterThanOrEqual(1)
      }
    }
  })
})

describe("crossover", () => {
  test("creates a child from two parents", () => {
    const parentA = makeCycle({ id: "parent-a", name: "Parent A" })
    const parentB: CycleDefinition = {
      id: "parent-b",
      name: "Parent B",
      description: "Second parent",
      author: "ai",
      phases: [
        makePhase({ name: "alpha", type: "gather", provider_hint: "cheap" }),
        makePhase({ name: "beta", type: "escalate", provider_hint: "best" }),
        makePhase({ name: "gamma", type: "synthesize", provider_hint: "smart" }),
      ],
      meta: {},
    }

    const child = crossover(parentA, parentB)
    expect(child.phases.length).toBeGreaterThanOrEqual(2)
    expect(child.author).toBe("ai")
    expect(child.name).toContain("-x-")
    // Should have phases from both parents
    expect(child.id).toBeTruthy()
  })

  test("crossover handles single-phase parents gracefully", () => {
    const a: CycleDefinition = {
      id: "a",
      name: "A",
      description: "",
      author: "ai",
      phases: [makePhase({ name: "only_a", type: "think" })],
      meta: {},
    }
    const b: CycleDefinition = {
      id: "b",
      name: "B",
      description: "",
      author: "ai",
      phases: [makePhase({ name: "only_b", type: "synthesize" })],
      meta: {},
    }

    const child = crossover(a, b)
    expect(child.phases.length).toBeGreaterThanOrEqual(2)
  })

  test("crossover caps phases at 8", () => {
    const manyPhases = (prefix: string) =>
      Array.from({ length: 6 }, (_, i) =>
        makePhase({ name: `${prefix}_${i}`, type: "think" }),
      )
    const a: CycleDefinition = {
      id: "a",
      name: "A",
      description: "",
      author: "ai",
      phases: manyPhases("a"),
      meta: {},
    }
    const b: CycleDefinition = {
      id: "b",
      name: "B",
      description: "",
      author: "ai",
      phases: manyPhases("b"),
      meta: {},
    }

    const child = crossover(a, b)
    expect(child.phases.length).toBeLessThanOrEqual(8)
  })
})

describe("evolve", () => {
  test("returns empty for no seed cycles", () => {
    const db = setupDb()
    const result = evolve(db, null as unknown as any, [], 3, 5)
    expect(result.winners).toHaveLength(0)
    expect(result.generationsRun).toBe(0)
    db.close()
  })

  test("evolves a population over generations", () => {
    const db = setupDb()
    const seed = [makeCycle({ id: "pflk", name: "PFLK" })]

    const result = evolve(db, null as unknown as any, seed, 3, 6)
    expect(result.winners.length).toBe(6)
    expect(result.generationsRun).toBe(3)
    expect(result.scores.length).toBe(6)

    // All winners should be valid cycles
    for (const winner of result.winners) {
      expect(winner.phases.length).toBeGreaterThanOrEqual(2)
      expect(winner.author).toBe("ai")
    }

    // Scores should be sorted descending
    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i]!).toBeLessThanOrEqual(result.scores[i - 1]!)
    }
    db.close()
  })

  test("evolve with multiple seed cycles", () => {
    const db = setupDb()
    const seeds = [
      makeCycle({ id: "pflk", name: "PFLK" }),
      makeCycle({
        id: "gree",
        name: "GREE",
        phases: [
          makePhase({ name: "gather", type: "gather", provider_hint: "cheap" }),
          makePhase({ name: "refine", type: "escalate", provider_hint: "balanced" }),
          makePhase({ name: "experiment", type: "parallel_experiment", max_parallel: 20 }),
          makePhase({ name: "evolve", type: "synthesize", provider_hint: "best" }),
        ],
      }),
    ]

    const result = evolve(db, null as unknown as any, seeds, 5, 8)
    expect(result.winners.length).toBe(8)
    expect(result.generationsRun).toBe(5)
    db.close()
  })

  test("evolve uses real performance data when available", () => {
    const db = setupDb()

    // Seed real performance data for pflk
    seedCycleData(db, {
      cycleId: "pflk",
      domain: "code",
      projectName: "proj-evo-test",
      workspaceCost: 0.5,
      resultDecisions: ["keep", "keep"],
      knowledgeConfidence: [0.9, 0.8],
    })

    const seeds = [makeCycle({ id: "pflk", name: "PFLK" })]
    const result = evolve(db, null as unknown as any, seeds, 2, 4)

    // The original pflk should have a higher score (real data) than mutations
    // (which have no data and use heuristic scoring)
    expect(result.winners.length).toBe(4)
    expect(result.scores[0]!).toBeGreaterThan(0)
    db.close()
  })
})
