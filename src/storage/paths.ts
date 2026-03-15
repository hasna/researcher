/**
 * Storage path resolution — finds the right .researcher/ folder.
 *
 * Two locations:
 * 1. Global: ~/.researcher/ — config, profiles, registry, cross-project knowledge
 * 2. Local: <project>/.researcher/ — project-specific experiments, results, sandboxes
 */

import { existsSync, mkdirSync } from "node:fs"
import { join, resolve, dirname } from "node:path"

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "."
const GLOBAL_DIR = join(HOME, ".researcher")
const LOCAL_DIR_NAME = ".researcher"

// ─── Global paths ────────────────────────────────────────────────────────────

export function getGlobalDir(): string {
  return GLOBAL_DIR
}

export function getGlobalConfigPath(): string {
  return join(GLOBAL_DIR, "config.toml")
}

export function getRegistryDbPath(): string {
  return join(GLOBAL_DIR, "registry.db")
}

export function getGlobalKnowledgeDbPath(): string {
  return join(GLOBAL_DIR, "knowledge.db")
}

export function getProfilesDir(): string {
  return join(GLOBAL_DIR, "profiles")
}

export function getProfilePath(name: string): string {
  return join(GLOBAL_DIR, "profiles", `${name}.toml`)
}

// ─── Local (per-project) paths ───────────────────────────────────────────────

export function getLocalDir(projectPath?: string): string {
  const base = projectPath ?? process.cwd()
  return join(base, LOCAL_DIR_NAME)
}

export function getLocalDbPath(projectPath?: string): string {
  return join(getLocalDir(projectPath), "experiments.db")
}

export function getLocalConfigPath(projectPath?: string): string {
  return join(getLocalDir(projectPath), "project.toml")
}

export function getLocalKnowledgeDir(projectPath?: string): string {
  return join(getLocalDir(projectPath), "knowledge")
}

export function getLocalCyclesDir(projectPath?: string): string {
  return join(getLocalDir(projectPath), "cycles")
}

export function getLocalSandboxesDir(projectPath?: string): string {
  return join(getLocalDir(projectPath), "sandboxes")
}

export function getLocalLogsDir(projectPath?: string): string {
  return join(getLocalDir(projectPath), "logs")
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Find the nearest .researcher/ folder by walking up from cwd.
 * Returns null if no project found.
 */
export function findProjectRoot(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd())
  const root = resolve("/")

  while (dir !== root) {
    if (existsSync(join(dir, LOCAL_DIR_NAME))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"))
}

/**
 * Get git remote URL if available.
 */
export function getGitRemote(dir: string): string | null {
  try {
    const result = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir })
    if (result.exitCode === 0) {
      return result.stdout.toString().trim()
    }
  } catch {}
  return null
}

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Ensure global ~/.researcher/ directory structure exists.
 */
export function ensureGlobalDir(): void {
  for (const dir of [GLOBAL_DIR, getProfilesDir()]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

/**
 * Create a local .researcher/ directory structure for a project.
 */
export function createLocalDir(projectPath?: string): string {
  const localDir = getLocalDir(projectPath)
  const dirs = [
    localDir,
    getLocalKnowledgeDir(projectPath),
    getLocalCyclesDir(projectPath),
    getLocalSandboxesDir(projectPath),
    getLocalLogsDir(projectPath),
  ]
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
  return localDir
}

/**
 * Resolve which DB to use — local if in a project, global otherwise.
 */
export function resolveDbPath(projectPath?: string): string {
  if (projectPath) {
    return getLocalDbPath(projectPath)
  }
  // Try to find a project root from cwd
  const projectRoot = findProjectRoot()
  if (projectRoot) {
    return getLocalDbPath(projectRoot)
  }
  // Fallback to global (for registry operations)
  ensureGlobalDir()
  return join(GLOBAL_DIR, "researcher.db")
}
