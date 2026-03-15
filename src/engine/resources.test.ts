import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "../db/schema.ts"
import { createProject, createWorkspace, logModelCall } from "../db/index.ts"
import { ResourceManager } from "./resources.ts"

function setupDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  db.run("INSERT INTO schema_version (version) VALUES (1)")
  return db
}

test("resource manager: initial state", () => {
  const db = setupDb()
  const rm = new ResourceManager()
  const status = rm.getStatus(db)
  expect(status.activeSandboxes).toBe(0)
  expect(status.hourlyCost).toBe(0)
  expect(status.dailyCost).toBe(0)
  expect(status.withinBudget).toBe(true)
  db.close()
})

test("resource manager: tracks hourly cost", () => {
  const db = setupDb()
  const rm = new ResourceManager({ max_cost_per_hour: 1 })
  const projId = createProject(db, { name: "cost-test", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "pflk" })

  logModelCall(db, { workspace_id: wsId, provider: "anthropic", model: "sonnet", tokens_in: 1000, tokens_out: 500, cost: 0.5, latency_ms: 100 })
  expect(rm.isWithinBudget(db)).toBe(true)

  logModelCall(db, { workspace_id: wsId, provider: "anthropic", model: "opus", tokens_in: 2000, tokens_out: 1000, cost: 0.6, latency_ms: 200 })
  expect(rm.isWithinBudget(db)).toBe(false)
  db.close()
})

test("resource manager: canCreateSandbox checks budget", () => {
  const db = setupDb()
  const rm = new ResourceManager({ max_cost_per_hour: 0.01 })
  const projId = createProject(db, { name: "budget-test", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "pflk" })

  logModelCall(db, { workspace_id: wsId, provider: "anthropic", model: "sonnet", tokens_in: 1000, tokens_out: 500, cost: 0.5, latency_ms: 100 })

  const check = rm.canCreateSandbox(db)
  expect(check.allowed).toBe(false)
  expect(check.reason).toContain("budget")
  db.close()
})
