import { test, expect } from "bun:test"
import { DEFAULT_CONFIG, loadConfig } from "./index.ts"

test("default config has expected structure", () => {
  expect(DEFAULT_CONFIG.general.default_cycle).toBe("pflk")
  expect(DEFAULT_CONFIG.resources.max_parallel_sandboxes).toBe(20)
  expect(DEFAULT_CONFIG.resources.max_cost_per_hour).toBe(5)
  expect(DEFAULT_CONFIG.resources.max_cloud_sandboxes).toBe(2)
})

test("loadConfig returns valid config with env var providers", () => {
  const config = loadConfig()
  expect(config.general).toBeTruthy()
  expect(config.resources).toBeTruthy()
  // If ANTHROPIC_API_KEY is set, anthropic provider should be configured
  if (process.env.ANTHROPIC_API_KEY) {
    expect(config.providers.anthropic).toBeTruthy()
    expect(config.providers.anthropic!.api_key).toBe(process.env.ANTHROPIC_API_KEY)
  }
})

test("default config has all resource limits", () => {
  expect(DEFAULT_CONFIG.resources.max_parallel_sandboxes).toBeGreaterThan(0)
  expect(DEFAULT_CONFIG.resources.max_parallel_per_workspace).toBeGreaterThan(0)
  expect(DEFAULT_CONFIG.resources.max_cost_per_hour).toBeGreaterThan(0)
  expect(DEFAULT_CONFIG.resources.max_container_sandboxes).toBeGreaterThan(0)
  expect(DEFAULT_CONFIG.resources.max_cloud_sandboxes).toBeGreaterThan(0)
})
