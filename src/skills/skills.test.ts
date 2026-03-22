import { test, expect } from "bun:test"
import { createDefaultRegistry } from "./index.ts"

test("default registry has all built-in skills", () => {
  const registry = createDefaultRegistry()
  expect(registry.has("run-command")).toBe(true)
  expect(registry.has("file-edit")).toBe(true)
  expect(registry.has("benchmark")).toBe(true)
  expect(registry.has("web-search")).toBe(true)
  expect(registry.has("db-query")).toBe(true)
  expect(registry.has("git-ops")).toBe(true)
  expect(registry.has("pdf-parse")).toBe(true)
  expect(registry.has("paper-search")).toBe(true)
  expect(registry.list()).toHaveLength(8)
})

test("forPhase returns relevant skills", () => {
  const registry = createDefaultRegistry()
  const gatherSkills = registry.forPhase("gather")
  expect(gatherSkills.length).toBeGreaterThan(0)
  expect(gatherSkills.some((s) => s.name === "web-search")).toBe(true)
  expect(gatherSkills.some((s) => s.name === "db-query")).toBe(true)
})

test("forDomain returns relevant skills", () => {
  const registry = createDefaultRegistry()
  const codeSkills = registry.forDomain("code")
  expect(codeSkills.some((s) => s.name === "git-ops")).toBe(true)
  expect(codeSkills.some((s) => s.name === "benchmark")).toBe(true)
})

test("skill execute without sandbox returns error", async () => {
  const registry = createDefaultRegistry()
  const skill = registry.get("run-command")!
  const result = await skill.execute({ context: "", parameters: { command: "echo hi" } })
  expect(result.success).toBe(false)
  expect(result.summary).toContain("No sandbox")
})

test("file-edit skill requires sandbox", async () => {
  const registry = createDefaultRegistry()
  const skill = registry.get("file-edit")!
  const result = await skill.execute({ context: "", parameters: { action: "read", path: "test.txt" } })
  expect(result.success).toBe(false)
})

test("web-search skill requires query", async () => {
  const registry = createDefaultRegistry()
  const skill = registry.get("web-search")!
  const result = await skill.execute({ context: "", parameters: {} })
  expect(result.success).toBe(false)
  expect(result.summary).toContain("No search query")
})

test("web-search skill with query returns success", async () => {
  const registry = createDefaultRegistry()
  const skill = registry.get("web-search")!
  const result = await skill.execute({ context: "", parameters: { query: "PFLK algorithm" } })
  expect(result.success).toBe(true)
})
