import { test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "./schema.ts"
import {
  createProject,
  getProject,
  getProjectByName,
  listProjects,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspacePhase,
  updateWorkspaceStatus,
  createSandbox,
  getSandbox,
  listSandboxes,
  updateSandboxStatus,
  createResult,
  listResults,
  saveKnowledge,
  queryKnowledge,
  logModelCall,
  createPFLKCycle,
  updatePFLKPhase,
  listPFLKCycles,
  logGREEPhase,
  registerCycle,
  listCycles,
  registerSkill,
  listSkills,
  getCostSummary,
} from "./index.ts"

let db: Database

beforeEach(() => {
  db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  db.run("INSERT INTO schema_version (version) VALUES (1)")
})

afterEach(() => {
  db.close()
})

// ─── Projects ────────────────────────────────────────────────────────────────

test("create and get project", () => {
  const id = createProject(db, {
    name: "test-project",
    type: "git_repo",
    path: "/tmp/test",
    domain: "code",
    metric_name: "val_bpb",
    metric_direction: "lower",
  })
  expect(id).toBeTruthy()

  const project = getProject(db, id) as Record<string, unknown>
  expect(project).toBeTruthy()
  expect(project.name).toBe("test-project")
  expect(project.type).toBe("git_repo")
  expect(project.domain).toBe("code")
  expect(project.metric_direction).toBe("lower")
})

test("get project by name", () => {
  createProject(db, { name: "my-proj", type: "directory" })
  const project = getProjectByName(db, "my-proj") as Record<string, unknown>
  expect(project).toBeTruthy()
  expect(project.name).toBe("my-proj")
})

test("list projects", () => {
  createProject(db, { name: "proj-1", type: "git_repo" })
  createProject(db, { name: "proj-2", type: "virtual" })
  const projects = listProjects(db)
  expect(projects).toHaveLength(2)
})

// ─── Workspaces ──────────────────────────────────────────────────────────────

test("create and get workspace", () => {
  const projId = createProject(db, { name: "wp-test", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "pflk" })
  expect(wsId).toBeTruthy()

  const ws = getWorkspace(db, wsId) as Record<string, unknown>
  expect(ws).toBeTruthy()
  expect(ws.cycle_id).toBe("pflk")
  expect(ws.status).toBe("running")
})

test("update workspace phase and status", () => {
  const projId = createProject(db, { name: "ws-update", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "gree" })

  updateWorkspacePhase(db, wsId, "gather")
  let ws = getWorkspace(db, wsId) as Record<string, unknown>
  expect(ws.current_phase).toBe("gather")

  updateWorkspaceStatus(db, wsId, "completed")
  ws = getWorkspace(db, wsId) as Record<string, unknown>
  expect(ws.status).toBe("completed")
})

test("list workspaces by status", () => {
  const projId = createProject(db, { name: "ws-list", type: "git_repo" })
  createWorkspace(db, { project_id: projId, cycle_id: "pflk" })
  const wsId2 = createWorkspace(db, { project_id: projId, cycle_id: "gree" })
  updateWorkspaceStatus(db, wsId2, "completed")

  const running = listWorkspaces(db, "running")
  expect(running).toHaveLength(1)
  const completed = listWorkspaces(db, "completed")
  expect(completed).toHaveLength(1)
  const all = listWorkspaces(db)
  expect(all).toHaveLength(2)
})

// ─── Sandboxes ───────────────────────────────────────────────────────────────

test("create and list sandboxes", () => {
  const projId = createProject(db, { name: "sb-test", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "pflk" })

  const sb1 = createSandbox(db, { workspace_id: wsId, type: "worktree", hypothesis: "increase LR" })
  const sb2 = createSandbox(db, { workspace_id: wsId, type: "tempdir", hypothesis: "try GeLU" })

  const sandboxes = listSandboxes(db, wsId)
  expect(sandboxes).toHaveLength(2)

  const sb = getSandbox(db, sb1) as Record<string, unknown>
  expect(sb.hypothesis).toBe("increase LR")
  expect(sb.type).toBe("worktree")
})

test("update sandbox status", () => {
  const projId = createProject(db, { name: "sb-status", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "pflk" })
  const sbId = createSandbox(db, { workspace_id: wsId, type: "worktree", hypothesis: "test" })

  updateSandboxStatus(db, sbId, "running")
  let sb = getSandbox(db, sbId) as Record<string, unknown>
  expect(sb.status).toBe("running")

  updateSandboxStatus(db, sbId, "completed")
  sb = getSandbox(db, sbId) as Record<string, unknown>
  expect(sb.status).toBe("completed")
})

// ─── Results ─────────────────────────────────────────────────────────────────

test("create and list results", () => {
  const projId = createProject(db, { name: "res-test", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "pflk" })
  const sbId = createSandbox(db, { workspace_id: wsId, type: "worktree", hypothesis: "test" })

  createResult(db, {
    sandbox_id: sbId,
    workspace_id: wsId,
    metrics: { val_bpb: 0.991 },
    decision: "keep",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  })

  createResult(db, {
    sandbox_id: sbId,
    workspace_id: wsId,
    metrics: { val_bpb: 1.005 },
    decision: "discard",
    provider: "openai",
    model: "gpt-4.1",
  })

  const results = listResults(db, wsId)
  expect(results).toHaveLength(2)
})

// ─── Knowledge ───────────────────────────────────────────────────────────────

test("save and query knowledge", () => {
  const projId = createProject(db, { name: "know-test", type: "git_repo" })

  saveKnowledge(db, {
    project_id: projId,
    domain: "code",
    insight: "Deeper models beat wider models at same param count",
    confidence: 0.85,
    tags: ["architecture", "model-size"],
  })

  saveKnowledge(db, {
    domain: "marketing",
    insight: "Questions in subject lines increase open rates by 3x",
    confidence: 0.92,
    tags: ["email", "subject-lines"],
  })

  const codeKnowledge = queryKnowledge(db, { domain: "code" })
  expect(codeKnowledge).toHaveLength(1)

  const searchResults = queryKnowledge(db, { search: "subject lines" })
  expect(searchResults).toHaveLength(1)

  const allKnowledge = queryKnowledge(db)
  expect(allKnowledge).toHaveLength(2)
})

// ─── Model calls ─────────────────────────────────────────────────────────────

test("log model calls and get cost summary", () => {
  const projId = createProject(db, { name: "mc-test", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "pflk" })

  logModelCall(db, {
    workspace_id: wsId,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    tokens_in: 1000,
    tokens_out: 500,
    cost: 0.015,
    latency_ms: 1200,
    phase: "problem",
  })

  logModelCall(db, {
    workspace_id: wsId,
    provider: "cerebras",
    model: "llama-4-scout",
    tokens_in: 2000,
    tokens_out: 800,
    cost: 0.002,
    latency_ms: 300,
    phase: "gather",
  })

  const summary = getCostSummary(db, wsId) as Record<string, unknown>[]
  expect(summary).toHaveLength(2)

  // Check workspace cost was updated
  const ws = getWorkspace(db, wsId) as Record<string, unknown>
  expect(ws.cost_total).toBeCloseTo(0.017)
})

// ─── PFLK tracking ───────────────────────────────────────────────────────────

test("create and update PFLK cycle", () => {
  const projId = createProject(db, { name: "pflk-test", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "pflk" })

  const pflkId = createPFLKCycle(db, {
    project_id: projId,
    workspace_id: wsId,
    problem: "val_bpb is stuck at 0.997",
  })

  updatePFLKPhase(db, pflkId, "feedback", "Past experiments show LR changes plateau")
  updatePFLKPhase(db, pflkId, "loopholes", JSON.stringify(["sb-1", "sb-2", "sb-3"]))
  updatePFLKPhase(db, pflkId, "knowledge", "Depth > Width at same param budget")

  const cycles = listPFLKCycles(db, projId)
  expect(cycles).toHaveLength(1)
  const cycle = cycles[0] as Record<string, unknown>
  expect(cycle.problem).toBe("val_bpb is stuck at 0.997")
  expect(cycle.knowledge).toBe("Depth > Width at same param budget")
})

// ─── GREE tracking ──────────────────────────────────────────────────────────

test("log GREE phases", () => {
  const projId = createProject(db, { name: "gree-test", type: "git_repo" })
  const wsId = createWorkspace(db, { project_id: projId, cycle_id: "gree" })

  logGREEPhase(db, {
    workspace_id: wsId,
    phase: "gather",
    provider_used: "cerebras",
    model_used: "llama-4-scout",
    input_summary: "Research prompt optimization",
    output_summary: "Found 15 relevant papers",
    tokens_in: 5000,
    tokens_out: 2000,
    cost: 0.005,
  })

  logGREEPhase(db, {
    workspace_id: wsId,
    phase: "refine",
    provider_used: "anthropic",
    model_used: "claude-sonnet-4-6",
    input_summary: "15 papers raw data",
    output_summary: "3 key hypotheses identified",
    tokens_in: 3000,
    tokens_out: 1500,
    cost: 0.03,
  })

  const phases = db.query("SELECT * FROM gree_phases WHERE workspace_id = ?").all(wsId)
  expect(phases).toHaveLength(2)
})

// ─── Cycles and Skills ───────────────────────────────────────────────────────

test("register and list cycles", () => {
  registerCycle(db, {
    name: "pflk",
    author: "human",
    definition: { phases: ["problem", "feedback", "loophole", "knowledge"] },
  })
  registerCycle(db, {
    name: "gree",
    author: "human",
    definition: { phases: ["gather", "refine", "experiment", "evolve"] },
  })

  const cycles = listCycles(db)
  expect(cycles).toHaveLength(2)
})

test("register and list skills", () => {
  registerSkill(db, {
    name: "web-search",
    author: "builtin",
    domains: ["general"],
    phases: ["gather"],
    requires: ["internet"],
  })
  registerSkill(db, {
    name: "benchmark",
    author: "builtin",
    domains: ["code"],
    phases: ["parallel_experiment"],
  })

  const skills = listSkills(db)
  expect(skills).toHaveLength(2)
})
