import { test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  findProjectRoot,
  isGitRepo,
  createLocalDir,
  getLocalDir,
  getLocalDbPath,
} from "./paths.ts"
import {
  getRegistryDb,
  closeRegistryDb,
  registerProject,
  listRegisteredProjects,
  getRegisteredProject,
  updateProjectStats,
  updateProjectHealth,
  unregisterProject,
} from "./registry.ts"

// ─── Path tests ──────────────────────────────────────────────────────────────

let tmpDir: string | null = null

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
  closeRegistryDb()
})

test("createLocalDir creates .researcher/ structure", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "researcher-test-"))
  createLocalDir(tmpDir)
  const { existsSync } = require("node:fs")
  expect(existsSync(join(tmpDir, ".researcher"))).toBe(true)
  expect(existsSync(join(tmpDir, ".researcher", "knowledge"))).toBe(true)
  expect(existsSync(join(tmpDir, ".researcher", "cycles"))).toBe(true)
  expect(existsSync(join(tmpDir, ".researcher", "sandboxes"))).toBe(true)
  expect(existsSync(join(tmpDir, ".researcher", "logs"))).toBe(true)
})

test("getLocalDir returns correct path", () => {
  expect(getLocalDir("/tmp/myproject")).toBe("/tmp/myproject/.researcher")
})

test("getLocalDbPath returns correct path", () => {
  expect(getLocalDbPath("/tmp/myproject")).toBe("/tmp/myproject/.researcher/experiments.db")
})

test("findProjectRoot finds .researcher/ folder", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "researcher-test-"))
  createLocalDir(tmpDir)
  const subDir = join(tmpDir, "src", "lib")
  mkdirSync(subDir, { recursive: true })
  const found = findProjectRoot(subDir)
  expect(found).toBe(tmpDir)
})

test("findProjectRoot returns null when not in a project", () => {
  const found = findProjectRoot("/tmp")
  expect(found).toBeNull()
})

test("isGitRepo detects git repos", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "researcher-test-"))
  expect(isGitRepo(tmpDir)).toBe(false)
  mkdirSync(join(tmpDir, ".git"))
  expect(isGitRepo(tmpDir)).toBe(true)
})

// ─── Registry tests ──────────────────────────────────────────────────────────

test("register and list projects", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "researcher-test-"))
  const id = registerProject({ name: "test-proj", path: tmpDir, domain: "code", metric_name: "score" })
  expect(id).toBeTruthy()

  const projects = listRegisteredProjects()
  const found = projects.find(p => p.name === "test-proj")
  expect(found).toBeTruthy()
  expect(found!.path).toBe(tmpDir)
  expect(found!.domain).toBe("code")
})

test("get registered project by name", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "researcher-test-"))
  registerProject({ name: "findme", path: tmpDir })
  const project = getRegisteredProject("findme")
  expect(project).toBeTruthy()
  expect(project!.name).toBe("findme")
})

test("update project stats", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "researcher-test-"))
  registerProject({ name: "stats-test", path: tmpDir })
  updateProjectStats(tmpDir, 0.05, 10)
  const project = getRegisteredProject("stats-test")!
  expect(project.total_cost).toBeCloseTo(0.05)
  expect(project.total_experiments).toBe(10)
  expect(project.last_run_at).toBeTruthy()
})

test("update project health", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "researcher-test-"))
  const name = `health-${Date.now()}`
  registerProject({ name, path: tmpDir })
  updateProjectHealth(tmpDir, "healthy")
  expect(getRegisteredProject(name)!.health_status).toBe("healthy")
  updateProjectHealth(tmpDir, "failing")
  expect(getRegisteredProject(name)!.health_status).toBe("failing")
})

test("unregister project", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "researcher-test-"))
  registerProject({ name: "removeme", path: tmpDir })
  expect(unregisterProject("removeme")).toBe(true)
  expect(getRegisteredProject("removeme")).toBeNull()
})

test("register same path updates instead of duplicating", () => {
  tmpDir = mkdtempSync(join(tmpdir(), "researcher-test-"))
  const id1 = registerProject({ name: "dup-test", path: tmpDir, domain: "code" })
  const id2 = registerProject({ name: "dup-test-updated", path: tmpDir, domain: "marketing" })
  expect(id1).toBe(id2) // Same ID, updated
  const project = getRegisteredProject(tmpDir)!
  expect(project.name).toBe("dup-test-updated")
  expect(project.domain).toBe("marketing")
})
