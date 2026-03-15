import { test, expect } from "bun:test"
import { parseCycleYaml, loadCycleFromFile, validateCycleDefinition } from "./parser.ts"
import { CycleRegistry } from "./registry.ts"
import { join } from "node:path"

// ─── Parser tests ────────────────────────────────────────────────────────────

test("parse valid PFLK cycle YAML", () => {
  const yaml = `
name: PFLK
description: Problem, Feedback, Loophole, Knowledge
author: human
phases:
  - name: problem
    type: think
    provider_hint: balanced
    skills: []
    max_parallel: 1
    description: Understand the problem
    input: context
    output: problem statement
  - name: feedback
    type: gather
    provider_hint: cheap
    skills: [web-search, db-query]
    max_parallel: 1
    description: Gather feedback
    input: problem
    output: context bundle
  - name: loophole
    type: parallel_experiment
    provider_hint: user_choice
    skills: [file-edit, benchmark]
    max_parallel: 20
    description: Parallel experiments
    input: problem + feedback
    output: ranked results
  - name: knowledge
    type: synthesize
    provider_hint: smart
    skills: []
    max_parallel: 1
    description: Codify knowledge
    input: results
    output: knowledge entry
`
  const cycle = parseCycleYaml(yaml)
  expect(cycle.name).toBe("PFLK")
  expect(cycle.id).toBe("pflk")
  expect(cycle.author).toBe("human")
  expect(cycle.phases).toHaveLength(4)
  expect(cycle.phases[0]!.name).toBe("problem")
  expect(cycle.phases[0]!.type).toBe("think")
  expect(cycle.phases[2]!.max_parallel).toBe(20)
  expect(cycle.phases[2]!.skills).toContain("file-edit")
})

test("parse minimal cycle YAML with defaults", () => {
  const yaml = `
name: Simple
phases:
  - name: do-it
    type: think
    provider_hint: balanced
`
  const cycle = parseCycleYaml(yaml)
  expect(cycle.name).toBe("Simple")
  expect(cycle.author).toBe("human")
  expect(cycle.description).toBe("")
  expect(cycle.phases[0]!.skills).toEqual([])
  expect(cycle.phases[0]!.max_parallel).toBe(1)
})

test("reject cycle with no phases", () => {
  const yaml = `
name: Empty
phases: []
`
  expect(() => parseCycleYaml(yaml)).toThrow()
})

test("reject cycle with invalid phase type", () => {
  const yaml = `
name: Bad
phases:
  - name: test
    type: invalid_type
    provider_hint: cheap
`
  expect(() => parseCycleYaml(yaml)).toThrow()
})

test("reject cycle with missing name", () => {
  const yaml = `
phases:
  - name: test
    type: think
    provider_hint: cheap
`
  expect(() => parseCycleYaml(yaml)).toThrow()
})

test("reject cycle with invalid provider hint", () => {
  const yaml = `
name: Bad
phases:
  - name: test
    type: think
    provider_hint: super_expensive
`
  expect(() => parseCycleYaml(yaml)).toThrow()
})

// ─── Validation tests ────────────────────────────────────────────────────────

test("validate valid cycle definition", () => {
  const result = validateCycleDefinition({
    name: "Test",
    phases: [{ name: "step1", type: "think", provider_hint: "cheap" }],
  })
  expect(result.valid).toBe(true)
  expect(result.errors).toHaveLength(0)
})

test("validate invalid cycle returns errors", () => {
  const result = validateCycleDefinition({
    name: "",
    phases: [],
  })
  expect(result.valid).toBe(false)
  expect(result.errors.length).toBeGreaterThan(0)
})

// ─── File loading tests ──────────────────────────────────────────────────────

test("load PFLK cycle from file", async () => {
  const cycle = await loadCycleFromFile(join(import.meta.dir, "definitions/pflk.yaml"))
  expect(cycle.name).toBe("PFLK")
  expect(cycle.phases).toHaveLength(4)
  expect(cycle.phases[0]!.name).toBe("problem")
  expect(cycle.phases[1]!.name).toBe("feedback")
  expect(cycle.phases[2]!.name).toBe("loophole")
  expect(cycle.phases[3]!.name).toBe("knowledge")
})

test("load GREE cycle from file", async () => {
  const cycle = await loadCycleFromFile(join(import.meta.dir, "definitions/gree.yaml"))
  expect(cycle.name).toBe("GREE")
  expect(cycle.phases).toHaveLength(4)
  expect(cycle.phases[0]!.name).toBe("gather")
  expect(cycle.phases[1]!.name).toBe("refine")
  expect(cycle.phases[2]!.name).toBe("experiment")
  expect(cycle.phases[3]!.name).toBe("evolve")
})

// ─── Registry tests ──────────────────────────────────────────────────────────

test("registry loads built-in cycles", async () => {
  const registry = new CycleRegistry()
  await registry.loadBuiltIn()
  expect(registry.has("pflk")).toBe(true)
  expect(registry.has("gree")).toBe(true)
  expect(registry.list()).toHaveLength(2)
})

test("registry get returns cycle definition", async () => {
  const registry = new CycleRegistry()
  await registry.loadBuiltIn()
  const pflk = registry.get("pflk")
  expect(pflk).toBeTruthy()
  expect(pflk!.name).toBe("PFLK")
  expect(pflk!.phases[2]!.type).toBe("parallel_experiment")
})

test("registry register adds custom cycle", () => {
  const registry = new CycleRegistry()
  registry.register({
    id: "custom",
    name: "Custom",
    description: "A custom cycle",
    author: "ai",
    phases: [{ name: "do", type: "think", provider_hint: "cheap", skills: [], max_parallel: 1, description: "", input: "", output: "" }],
    meta: { discovered_at: "2026-03-15" },
  })
  expect(registry.has("custom")).toBe(true)
  expect(registry.get("custom")!.author).toBe("ai")
})
