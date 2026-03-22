import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "../db/schema.ts"
import { createProject, createWorkspace } from "../db/index.ts"
import {
  ensureLineageTable,
  recordLineage,
  getLineageDescendants,
  getLineageAncestors,
  computeNormalizedVariance,
  planResourceSchedule,
  type ExperimentLineageEntry,
} from "./adaptive.ts"

function setupDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  db.run("INSERT INTO schema_version (version) VALUES (1)")
  ensureLineageTable(db)
  return db
}

// ─── Lineage Tests ──────────────────────────────────────────────────────────

test("recordLineage creates experiment entry", () => {
  const db = setupDb()
  recordLineage(db, {
    id: "exp-1",
    workspaceId: "ws-1",
    hypothesis: "double the learning rate",
    metrics: { loss: 0.5 },
    generation: 0,
    decision: "keep",
  })

  const row = db.query("SELECT * FROM experiment_lineage WHERE id = ?").get("exp-1") as Record<string, unknown>
  expect(row).toBeTruthy()
  expect(row.hypothesis).toBe("double the learning rate")
  expect(row.generation).toBe(0)
  expect(row.decision).toBe("keep")
  expect(JSON.parse(row.metrics as string)).toEqual({ loss: 0.5 })
  db.close()
})

test("recordLineage tracks parent-child relationships", () => {
  const db = setupDb()
  recordLineage(db, { id: "parent-1", workspaceId: "ws-1", hypothesis: "base approach", metrics: { score: 0.7 }, generation: 0, decision: "keep" })
  recordLineage(db, { id: "child-1", parentId: "parent-1", workspaceId: "ws-1", hypothesis: "variant A", metrics: { score: 0.8 }, generation: 1, decision: "keep" })
  recordLineage(db, { id: "child-2", parentId: "parent-1", workspaceId: "ws-1", hypothesis: "variant B", metrics: { score: 0.6 }, generation: 1, decision: "discard" })

  const children = db.query("SELECT * FROM experiment_lineage WHERE parent_id = ?").all("parent-1")
  expect(children).toHaveLength(2)
  db.close()
})

test("getLineageDescendants returns full tree", () => {
  const db = setupDb()
  recordLineage(db, { id: "root", workspaceId: "ws-1", hypothesis: "root", metrics: {}, generation: 0, decision: "keep" })
  recordLineage(db, { id: "gen1-a", parentId: "root", workspaceId: "ws-1", hypothesis: "gen1-a", metrics: {}, generation: 1, decision: "keep" })
  recordLineage(db, { id: "gen1-b", parentId: "root", workspaceId: "ws-1", hypothesis: "gen1-b", metrics: {}, generation: 1, decision: "discard" })
  recordLineage(db, { id: "gen2-a", parentId: "gen1-a", workspaceId: "ws-1", hypothesis: "gen2-a", metrics: {}, generation: 2, decision: "keep" })

  const descendants = getLineageDescendants(db, "root")
  expect(descendants).toHaveLength(3)
  expect(descendants.map(d => d.id).sort()).toEqual(["gen1-a", "gen1-b", "gen2-a"])
  db.close()
})

test("getLineageAncestors returns ancestry chain", () => {
  const db = setupDb()
  recordLineage(db, { id: "root", workspaceId: "ws-1", hypothesis: "root", metrics: {}, generation: 0, decision: "keep" })
  recordLineage(db, { id: "gen1", parentId: "root", workspaceId: "ws-1", hypothesis: "gen1", metrics: {}, generation: 1, decision: "keep" })
  recordLineage(db, { id: "gen2", parentId: "gen1", workspaceId: "ws-1", hypothesis: "gen2", metrics: {}, generation: 2, decision: "keep" })

  const ancestors = getLineageAncestors(db, "gen2")
  expect(ancestors).toHaveLength(2)
  expect(ancestors[0]!.id).toBe("root")
  expect(ancestors[1]!.id).toBe("gen1")
  db.close()
})

// ─── Variance Tests ─────────────────────────────────────────────────────────

test("computeNormalizedVariance handles basic cases", () => {
  // All same values → 0 variance
  expect(computeNormalizedVariance([5, 5, 5])).toBe(0)

  // Single value → 0
  expect(computeNormalizedVariance([5])).toBe(0)

  // Empty → 0
  expect(computeNormalizedVariance([])).toBe(0)

  // High variance
  const highVar = computeNormalizedVariance([1, 100, 50])
  expect(highVar).toBeGreaterThan(0.5)

  // Low variance
  const lowVar = computeNormalizedVariance([10, 10.1, 9.9])
  expect(lowVar).toBeLessThan(0.01)
})

test("computeNormalizedVariance is order-independent", () => {
  const v1 = computeNormalizedVariance([1, 2, 3, 4, 5])
  const v2 = computeNormalizedVariance([5, 3, 1, 4, 2])
  expect(Math.abs(v1 - v2)).toBeLessThan(0.0001)
})

// ─── Resource Scheduling Tests ──────────────────────────────────────────────

test("planResourceSchedule uses worktree for git repos", () => {
  const schedule = planResourceSchedule(10, {
    budgetRemaining: 1.0,
    hasGitRepo: true,
    needsGpu: false,
    untrustedCode: false,
  })
  expect(schedule.sandboxType).toBe("worktree")
  expect(schedule.estimatedCostPerExperiment).toBe(0)
  expect(schedule.maxParallel).toBe(10)
})

test("planResourceSchedule uses e2b for untrusted code", () => {
  const schedule = planResourceSchedule(10, {
    budgetRemaining: 1.0,
    hasGitRepo: true,
    needsGpu: false,
    untrustedCode: true,
  })
  expect(schedule.sandboxType).toBe("e2b")
  expect(schedule.maxParallel).toBeLessThanOrEqual(2)
  expect(schedule.estimatedCostPerExperiment).toBeGreaterThan(0)
})

test("planResourceSchedule uses e2b for GPU needs", () => {
  const schedule = planResourceSchedule(5, {
    budgetRemaining: 0.5,
    hasGitRepo: false,
    needsGpu: true,
    untrustedCode: false,
  })
  expect(schedule.sandboxType).toBe("e2b")
})

test("planResourceSchedule uses tempdir when no git repo", () => {
  const schedule = planResourceSchedule(8, {
    budgetRemaining: 1.0,
    hasGitRepo: false,
    needsGpu: false,
    untrustedCode: false,
  })
  expect(schedule.sandboxType).toBe("tempdir")
  expect(schedule.estimatedCostPerExperiment).toBe(0)
})

test("planResourceSchedule limits e2b parallel based on budget", () => {
  const schedule = planResourceSchedule(20, {
    budgetRemaining: 0.15,
    hasGitRepo: false,
    needsGpu: true,
    untrustedCode: false,
  })
  expect(schedule.sandboxType).toBe("e2b")
  expect(schedule.maxParallel).toBeLessThanOrEqual(2)
})
