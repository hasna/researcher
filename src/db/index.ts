/**
 * SQLite database layer for researcher.
 * Uses bun:sqlite native API.
 */

import { SqliteAdapter as Database } from "@hasna/cloud"
import { existsSync, mkdirSync, cpSync } from "fs"
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts"

let _db: Database | null = null

export function getDb(dbPath?: string): Database {
  if (_db) return _db
  const path = dbPath ?? getDefaultDbPath()
  _db = new Database(path, { create: true })
  _db.run("PRAGMA journal_mode = WAL")
  _db.run("PRAGMA foreign_keys = ON")
  _db.run("PRAGMA busy_timeout = 5000")
  return _db
}

export function getDefaultDbPath(): string {
  // Support env var overrides
  const envPath = process.env.HASNA_RESEARCHER_DB_PATH ?? process.env.RESEARCHER_DB_PATH
  if (envPath) return envPath

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
  const newDir = `${home}/.hasna/researcher`
  const oldDir = `${home}/.researcher`

  // Auto-migrate from old location if new dir doesn't exist yet
  if (!existsSync(newDir) && existsSync(oldDir)) {
    try {
      mkdirSync(`${home}/.hasna`, { recursive: true })
      cpSync(oldDir, newDir, { recursive: true })
    } catch {
      // Fall through to create new dir
    }
  }

  // Ensure directory exists
  try {
    mkdirSync(newDir, { recursive: true })
  } catch {
    // already exists
  }
  return `${newDir}/researcher.db`
}

export function initDb(dbPath?: string): Database {
  const db = getDb(dbPath)

  // Check if schema is already applied
  const hasVersionTable = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get()

  if (hasVersionTable) {
    const row = db.query("SELECT MAX(version) as version FROM schema_version").get() as {
      version: number | null
    } | null
    if (row?.version && row.version >= SCHEMA_VERSION) {
      return db
    }
  }

  // Apply schema
  db.exec(SCHEMA_SQL)

  // Record version
  db.run("INSERT INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION])

  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ─── Project queries ─────────────────────────────────────────────────────────

export function createProject(
  db: Database,
  data: {
    name: string
    type: string
    path?: string
    remote_url?: string
    domain?: string
    metric_name?: string
    metric_direction?: string
    config?: Record<string, unknown>
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO projects (id, name, type, path, remote_url, domain, metric_name, metric_direction, config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.type,
      data.path ?? null,
      data.remote_url ?? null,
      data.domain ?? "general",
      data.metric_name ?? "score",
      data.metric_direction ?? "higher",
      JSON.stringify(data.config ?? {}),
    ],
  )
  return id
}

export function getProject(db: Database, id: string) {
  return db.query("SELECT * FROM projects WHERE id = ?").get(id)
}

export function getProjectByName(db: Database, name: string) {
  return db.query("SELECT * FROM projects WHERE name = ?").get(name)
}

export function listProjects(db: Database) {
  return db.query("SELECT * FROM projects ORDER BY created_at DESC").all()
}

export function deleteProject(db: Database, id: string): boolean {
  // CASCADE handles workspaces, sandboxes, results, pflk_cycles, gree_phases
  const result = db.run("DELETE FROM projects WHERE id = ?", [id])
  return result.changes > 0
}

// ─── Workspace queries ───────────────────────────────────────────────────────

export function createWorkspace(
  db: Database,
  data: {
    project_id: string
    cycle_id: string
    config?: Record<string, unknown>
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO workspaces (id, project_id, cycle_id, config)
     VALUES (?, ?, ?, ?)`,
    [id, data.project_id, data.cycle_id, JSON.stringify(data.config ?? {})],
  )
  return id
}

export function getWorkspace(db: Database, id: string) {
  return db.query("SELECT * FROM workspaces WHERE id = ?").get(id)
}

export function listWorkspaces(db: Database, status?: string) {
  if (status) {
    return db.query("SELECT * FROM workspaces WHERE status = ? ORDER BY created_at DESC").all(status)
  }
  return db.query("SELECT * FROM workspaces ORDER BY created_at DESC").all()
}

export function updateWorkspacePhase(db: Database, id: string, phase: string) {
  db.run("UPDATE workspaces SET current_phase = ?, updated_at = datetime('now') WHERE id = ?", [
    phase,
    id,
  ])
}

export function updateWorkspaceStatus(db: Database, id: string, status: string) {
  db.run("UPDATE workspaces SET status = ?, updated_at = datetime('now') WHERE id = ?", [
    status,
    id,
  ])
}

export function deleteWorkspace(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM workspaces WHERE id = ?", [id])
  return result.changes > 0
}

export function addWorkspaceCost(db: Database, id: string, cost: number) {
  db.run(
    "UPDATE workspaces SET cost_total = cost_total + ?, updated_at = datetime('now') WHERE id = ?",
    [cost, id],
  )
}

// ─── Sandbox queries ─────────────────────────────────────────────────────────

export function createSandbox(
  db: Database,
  data: {
    workspace_id: string
    type: string
    hypothesis: string
    path?: string
    git_branch?: string
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO sandboxes (id, workspace_id, type, hypothesis, path, git_branch)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, data.workspace_id, data.type, data.hypothesis, data.path ?? null, data.git_branch ?? null],
  )
  return id
}

export function getSandbox(db: Database, id: string) {
  return db.query("SELECT * FROM sandboxes WHERE id = ?").get(id)
}

export function listSandboxes(db: Database, workspaceId: string) {
  return db
    .query("SELECT * FROM sandboxes WHERE workspace_id = ? ORDER BY started_at DESC")
    .all(workspaceId)
}

export function updateSandboxStatus(db: Database, id: string, status: string) {
  const completedAt = status === "completed" || status === "failed" ? "datetime('now')" : "NULL"
  db.run(`UPDATE sandboxes SET status = ?, completed_at = ${completedAt} WHERE id = ?`, [
    status,
    id,
  ])
}

// ─── Result queries ──────────────────────────────────────────────────────────

export function createResult(
  db: Database,
  data: {
    sandbox_id: string
    workspace_id: string
    metrics: Record<string, number>
    decision: string
    diff?: string
    cost?: number
    provider?: string
    model?: string
    reasoning?: string
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO results (id, sandbox_id, workspace_id, metrics, decision, diff, cost, provider, model, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.sandbox_id,
      data.workspace_id,
      JSON.stringify(data.metrics),
      data.decision,
      data.diff ?? null,
      data.cost ?? 0,
      data.provider ?? "",
      data.model ?? "",
      data.reasoning ?? null,
    ],
  )
  return id
}

export function listResults(db: Database, workspaceId: string) {
  return db
    .query("SELECT * FROM results WHERE workspace_id = ? ORDER BY created_at DESC")
    .all(workspaceId)
}

export function getBestResult(db: Database, workspaceId: string, metricName: string, direction: string) {
  const order = direction === "lower" ? "ASC" : "DESC"
  return db
    .query(
      `SELECT * FROM results
       WHERE workspace_id = ? AND decision = 'keep'
       AND json_extract(metrics, '$.' || ?) IS NOT NULL
       ORDER BY CAST(json_extract(metrics, '$.' || ?) AS REAL) ${order}
       LIMIT 1`,
    )
    .get(workspaceId, metricName, metricName)
}

// ─── Knowledge queries ───────────────────────────────────────────────────────

export function saveKnowledge(
  db: Database,
  data: {
    project_id?: string
    domain: string
    insight: string
    evidence?: unknown[]
    confidence?: number
    tags?: string[]
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO knowledge (id, project_id, domain, insight, evidence, confidence, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.project_id ?? null,
      data.domain,
      data.insight,
      JSON.stringify(data.evidence ?? []),
      data.confidence ?? 0.5,
      JSON.stringify(data.tags ?? []),
    ],
  )
  return id
}

export function queryKnowledge(db: Database, opts?: { domain?: string; search?: string; project_id?: string }) {
  let sql = "SELECT * FROM knowledge WHERE 1=1"
  const params: string[] = []

  if (opts?.domain) {
    sql += " AND domain = ?"
    params.push(opts.domain)
  }
  if (opts?.project_id) {
    sql += " AND (project_id = ? OR project_id IS NULL)"
    params.push(opts.project_id)
  }
  if (opts?.search) {
    sql += " AND insight LIKE ?"
    params.push(`%${opts.search}%`)
  }

  sql += " ORDER BY confidence DESC, created_at DESC"
  return db.query(sql).all(...params)
}

// ─── Model call tracking ─────────────────────────────────────────────────────

export function logModelCall(
  db: Database,
  data: {
    workspace_id?: string
    sandbox_id?: string
    provider: string
    model: string
    tokens_in: number
    tokens_out: number
    cost: number
    latency_ms: number
    phase?: string
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO model_calls (id, workspace_id, sandbox_id, provider, model, tokens_in, tokens_out, cost, latency_ms, phase)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.workspace_id ?? null,
      data.sandbox_id ?? null,
      data.provider,
      data.model,
      data.tokens_in,
      data.tokens_out,
      data.cost,
      data.latency_ms,
      data.phase ?? null,
    ],
  )

  // Update workspace cost if applicable
  if (data.workspace_id && data.cost > 0) {
    addWorkspaceCost(db, data.workspace_id, data.cost)
  }

  return id
}

// ─── PFLK tracking ───────────────────────────────────────────────────────────

export function createPFLKCycle(
  db: Database,
  data: {
    project_id: string
    workspace_id: string
    problem?: string
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO pflk_cycles (id, project_id, workspace_id, problem)
     VALUES (?, ?, ?, ?)`,
    [id, data.project_id, data.workspace_id, data.problem ?? ""],
  )
  return id
}

export function updatePFLKPhase(
  db: Database,
  id: string,
  phase: "problem" | "feedback" | "loopholes" | "knowledge",
  value: string,
) {
  if (phase === "loopholes") {
    db.run("UPDATE pflk_cycles SET loopholes = ? WHERE id = ?", [value, id])
  } else {
    db.run(`UPDATE pflk_cycles SET ${phase} = ? WHERE id = ?`, [value, id])
  }
}

export function listPFLKCycles(db: Database, projectId: string) {
  return db
    .query("SELECT * FROM pflk_cycles WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId)
}

// ─── GREE tracking ──────────────────────────────────────────────────────────

export function logGREEPhase(
  db: Database,
  data: {
    workspace_id: string
    phase: string
    provider_used: string
    model_used: string
    input_summary: string
    output_summary: string
    tokens_in: number
    tokens_out: number
    cost: number
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO gree_phases (id, workspace_id, phase, provider_used, model_used, input_summary, output_summary, tokens_in, tokens_out, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.workspace_id,
      data.phase,
      data.provider_used,
      data.model_used,
      data.input_summary,
      data.output_summary,
      data.tokens_in,
      data.tokens_out,
      data.cost,
    ],
  )
  return id
}

// ─── Cycle registry ──────────────────────────────────────────────────────────

export function registerCycle(
  db: Database,
  data: {
    name: string
    author: string
    definition: unknown
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT OR REPLACE INTO cycles (id, name, author, definition)
     VALUES (?, ?, ?, ?)`,
    [id, data.name, data.author, JSON.stringify(data.definition)],
  )
  return id
}

export function listCycles(db: Database) {
  return db.query("SELECT * FROM cycles ORDER BY total_runs DESC").all()
}

// ─── Skill registry ──────────────────────────────────────────────────────────

export function registerSkill(
  db: Database,
  data: {
    name: string
    author: string
    file_path?: string
    domains?: string[]
    phases?: string[]
    requires?: string[]
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT OR REPLACE INTO skills (id, name, author, file_path, domains, phases, requires)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.author,
      data.file_path ?? null,
      JSON.stringify(data.domains ?? []),
      JSON.stringify(data.phases ?? []),
      JSON.stringify(data.requires ?? []),
    ],
  )
  return id
}

export function listSkills(db: Database) {
  return db.query("SELECT * FROM skills ORDER BY total_uses DESC").all()
}

// ─── Pipeline runs ──────────────────────────────────────────────────────

export function createPipelineRun(
  db: Database,
  data: {
    id: string
    project_id: string
    pipeline_id: string
    config?: Record<string, unknown>
  },
): string {
  db.run(
    `INSERT INTO pipeline_runs (id, project_id, pipeline_id, config)
     VALUES (?, ?, ?, ?)`,
    [data.id, data.project_id, data.pipeline_id, JSON.stringify(data.config ?? {})],
  )
  return data.id
}

export function updatePipelineRun(
  db: Database,
  id: string,
  updates: {
    status?: string
    current_step?: string
    steps_completed?: number
    cost_total?: number
  },
): void {
  const sets: string[] = ["updated_at = datetime('now')"]
  const params: (string | number | null)[] = []

  if (updates.status !== undefined) {
    sets.push("status = ?")
    params.push(updates.status)
  }
  if (updates.current_step !== undefined) {
    sets.push("current_step = ?")
    params.push(updates.current_step)
  }
  if (updates.steps_completed !== undefined) {
    sets.push("steps_completed = ?")
    params.push(updates.steps_completed)
  }
  if (updates.cost_total !== undefined) {
    sets.push("cost_total = ?")
    params.push(updates.cost_total)
  }

  params.push(id)
  db.run(`UPDATE pipeline_runs SET ${sets.join(", ")} WHERE id = ?`, params)
}

export function getPipelineRun(db: Database, id: string) {
  return db.query("SELECT * FROM pipeline_runs WHERE id = ?").get(id)
}

export function listPipelineRuns(db: Database, projectId?: string) {
  if (projectId) {
    return db
      .query("SELECT * FROM pipeline_runs WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId)
  }
  return db.query("SELECT * FROM pipeline_runs ORDER BY created_at DESC").all()
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export function getCostSummary(db: Database, workspaceId?: string) {
  if (workspaceId) {
    return db
      .query(
        `SELECT provider, model, SUM(cost) as total_cost, SUM(tokens_in) as total_tokens_in, SUM(tokens_out) as total_tokens_out, COUNT(*) as call_count
         FROM model_calls WHERE workspace_id = ? GROUP BY provider, model ORDER BY total_cost DESC`,
      )
      .all(workspaceId)
  }
  return db
    .query(
      `SELECT provider, model, SUM(cost) as total_cost, SUM(tokens_in) as total_tokens_in, SUM(tokens_out) as total_tokens_out, COUNT(*) as call_count
       FROM model_calls GROUP BY provider, model ORDER BY total_cost DESC`,
    )
    .all()
}
