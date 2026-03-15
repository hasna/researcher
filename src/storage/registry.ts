/**
 * Global project registry — tracks all known .researcher/ projects across the filesystem.
 * Stored at ~/.researcher/registry.db
 */

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"
import { getRegistryDbPath, ensureGlobalDir, isGitRepo, getGitRemote, getLocalDir } from "./paths.ts"

const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL DEFAULT 'general',
  metric_name TEXT NOT NULL DEFAULT 'score',
  metric_direction TEXT NOT NULL CHECK (metric_direction IN ('lower', 'higher')) DEFAULT 'higher',
  is_git_repo INTEGER NOT NULL DEFAULT 0,
  git_remote TEXT,
  last_run_at TEXT,
  total_cost REAL NOT NULL DEFAULT 0,
  total_experiments INTEGER NOT NULL DEFAULT 0,
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'stale', 'failing', 'unknown')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

let _registryDb: Database | null = null

export function getRegistryDb(): Database {
  if (_registryDb) return _registryDb
  ensureGlobalDir()
  const dbPath = getRegistryDbPath()
  _registryDb = new Database(dbPath, { create: true })
  _registryDb.run("PRAGMA journal_mode = WAL")
  _registryDb.run("PRAGMA foreign_keys = ON")
  _registryDb.exec(REGISTRY_SCHEMA)
  return _registryDb
}

export function closeRegistryDb(): void {
  if (_registryDb) {
    _registryDb.close()
    _registryDb = null
  }
}

export interface RegisteredProject {
  id: string
  name: string
  path: string
  domain: string
  metric_name: string
  metric_direction: string
  is_git_repo: boolean
  git_remote: string | null
  last_run_at: string | null
  total_cost: number
  total_experiments: number
  health_status: string
  created_at: string
  updated_at: string
}

/**
 * Register a project in the global registry.
 */
export function registerProject(data: {
  name: string
  path: string
  domain?: string
  metric_name?: string
  metric_direction?: string
}): string {
  const db = getRegistryDb()
  const absPath = resolve(data.path)
  const gitRepo = isGitRepo(absPath)
  const gitRemote = gitRepo ? getGitRemote(absPath) : null

  // Upsert — update if path already exists
  const existing = db.query("SELECT id FROM projects WHERE path = ?").get(absPath) as { id: string } | null
  if (existing) {
    db.run(
      `UPDATE projects SET name = ?, domain = ?, metric_name = ?, metric_direction = ?, is_git_repo = ?, git_remote = ?, updated_at = datetime('now') WHERE id = ?`,
      [data.name, data.domain ?? "general", data.metric_name ?? "score", data.metric_direction ?? "higher", gitRepo ? 1 : 0, gitRemote, existing.id],
    )
    return existing.id
  }

  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO projects (id, name, path, domain, metric_name, metric_direction, is_git_repo, git_remote)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.name, absPath, data.domain ?? "general", data.metric_name ?? "score", data.metric_direction ?? "higher", gitRepo ? 1 : 0, gitRemote],
  )
  return id
}

/**
 * List all registered projects.
 */
export function listRegisteredProjects(): RegisteredProject[] {
  const db = getRegistryDb()
  const rows = db.query("SELECT * FROM projects ORDER BY updated_at DESC").all() as Record<string, unknown>[]
  return rows.map(mapProject)
}

/**
 * Get a registered project by name or path.
 */
export function getRegisteredProject(nameOrPath: string): RegisteredProject | null {
  const db = getRegistryDb()
  const absPath = resolve(nameOrPath)
  const row = (
    db.query("SELECT * FROM projects WHERE name = ? OR path = ?").get(nameOrPath, absPath)
  ) as Record<string, unknown> | null
  return row ? mapProject(row) : null
}

/**
 * Update project stats (called after experiments run).
 */
export function updateProjectStats(path: string, cost: number, experiments: number): void {
  const db = getRegistryDb()
  const absPath = resolve(path)
  db.run(
    `UPDATE projects SET
      total_cost = total_cost + ?,
      total_experiments = total_experiments + ?,
      last_run_at = datetime('now'),
      updated_at = datetime('now')
     WHERE path = ?`,
    [cost, experiments, absPath],
  )
}

/**
 * Update project health status.
 */
export function updateProjectHealth(path: string, status: "healthy" | "stale" | "failing" | "unknown"): void {
  const db = getRegistryDb()
  db.run("UPDATE projects SET health_status = ?, updated_at = datetime('now') WHERE path = ?", [status, resolve(path)])
}

/**
 * Remove a project from the registry.
 */
export function unregisterProject(nameOrPath: string): boolean {
  const db = getRegistryDb()
  const absPath = resolve(nameOrPath)
  const result = db.run("DELETE FROM projects WHERE name = ? OR path = ?", [nameOrPath, absPath])
  return result.changes > 0
}

/**
 * Scan filesystem for .researcher/ folders and register them.
 */
export function scanAndRegister(searchPaths: string[]): number {
  let found = 0
  for (const searchPath of searchPaths) {
    const absPath = resolve(searchPath)
    if (existsSync(getLocalDir(absPath))) {
      const name = basename(absPath)
      registerProject({ name, path: absPath })
      found++
    }
  }
  return found
}

function mapProject(row: Record<string, unknown>): RegisteredProject {
  return {
    id: row.id as string,
    name: row.name as string,
    path: row.path as string,
    domain: row.domain as string,
    metric_name: row.metric_name as string,
    metric_direction: row.metric_direction as string,
    is_git_repo: (row.is_git_repo as number) === 1,
    git_remote: row.git_remote as string | null,
    last_run_at: row.last_run_at as string | null,
    total_cost: row.total_cost as number,
    total_experiments: row.total_experiments as number,
    health_status: row.health_status as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
