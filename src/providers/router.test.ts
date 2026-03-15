import { test, expect } from "bun:test"
import { ProviderRouter } from "./router.ts"

test("router initializes with local provider always available", () => {
  const router = new ProviderRouter()
  expect(router.hasProvider("local")).toBe(true)
  expect(router.listProviders()).toContain("local")
})

test("router initializes providers based on env vars", () => {
  // Local is always available regardless of env
  const router = new ProviderRouter()
  const providers = router.listProviders()
  expect(providers.length).toBeGreaterThanOrEqual(1)
})

test("router resolves cheap hint to available provider", () => {
  const router = new ProviderRouter()
  const provider = router.resolve("cheap")
  expect(provider).toBeTruthy()
  expect(provider.name).toBeTruthy()
})

test("router resolves balanced hint to available provider", () => {
  const router = new ProviderRouter()
  const provider = router.resolve("balanced")
  expect(provider).toBeTruthy()
})

test("router resolves smart hint to available provider", () => {
  const router = new ProviderRouter()
  const provider = router.resolve("smart")
  expect(provider).toBeTruthy()
})

test("router resolves best hint to available provider", () => {
  const router = new ProviderRouter()
  const provider = router.resolve("best")
  expect(provider).toBeTruthy()
})

test("router resolves user_choice to default hint", () => {
  const router = new ProviderRouter({ default_hint: "cheap" })
  const provider = router.resolve("user_choice")
  expect(provider).toBeTruthy()
})

test("router with explicit anthropic config", () => {
  const router = new ProviderRouter({
    anthropic: { apiKey: "test-key" },
  })
  expect(router.hasProvider("anthropic")).toBe(true)
  const provider = router.resolve("smart")
  expect(provider.name).toBe("anthropic")
})

test("router with explicit cerebras config", () => {
  const router = new ProviderRouter({
    cerebras: { apiKey: "test-key" },
  })
  expect(router.hasProvider("cerebras")).toBe(true)
  const provider = router.resolve("cheap")
  expect(provider.name).toBe("cerebras")
})

test("router with explicit openai config", () => {
  const router = new ProviderRouter({
    openai: { apiKey: "test-key" },
  })
  expect(router.hasProvider("openai")).toBe(true)
  const provider = router.resolve("balanced")
  expect(provider.name).toBe("openai")
})

test("provider estimateCost returns number", () => {
  const router = new ProviderRouter({ anthropic: { apiKey: "test" } })
  const provider = router.resolve("smart")
  const cost = provider.estimateCost(1000, 500)
  expect(typeof cost).toBe("number")
  expect(cost).toBeGreaterThanOrEqual(0)
})
