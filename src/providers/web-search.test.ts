import { test, expect, mock } from "bun:test"
import { searchWeb, searchWithExa, type WebSearchResponse } from "./web-search.ts"

test("searchWeb returns empty results when no API keys are set", async () => {
  // Save and clear env vars
  const exa = process.env.EXA_API_KEY
  const openai = process.env.OPENAI_API_KEY
  const anthropic = process.env.ANTHROPIC_API_KEY
  delete process.env.EXA_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY

  try {
    const result = await searchWeb("test query")
    expect(result.results).toHaveLength(0)
    expect(result.provider).toBe("none")
    expect(result.cost).toBe(0)
    expect(result.query).toBe("test query")
  } finally {
    // Restore env vars
    if (exa) process.env.EXA_API_KEY = exa
    if (openai) process.env.OPENAI_API_KEY = openai
    if (anthropic) process.env.ANTHROPIC_API_KEY = anthropic
  }
})

test("searchWithExa throws when no API key", async () => {
  const saved = process.env.EXA_API_KEY
  delete process.env.EXA_API_KEY
  try {
    await expect(searchWithExa("test")).rejects.toThrow("EXA_API_KEY not set")
  } finally {
    if (saved) process.env.EXA_API_KEY = saved
  }
})

test("searchWeb response has correct structure", async () => {
  // Mock a provider by temporarily setting an env var and mocking fetch
  const origFetch = globalThis.fetch
  const saved = process.env.EXA_API_KEY
  process.env.EXA_API_KEY = "test-key"

  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    results: [
      { title: "Test Result", url: "https://example.com", text: "A test result snippet", highlights: ["highlighted text"], score: 0.9, published_date: "2025-01-01" },
      { title: "Second Result", url: "https://example.org", highlights: ["more text"], score: 0.8 },
    ],
  }), { status: 200 })) as unknown as typeof fetch

  try {
    const result = await searchWeb("machine learning optimization")
    expect(result.provider).toBe("exa")
    expect(result.results).toHaveLength(2)
    expect(result.results[0]!.title).toBe("Test Result")
    expect(result.results[0]!.url).toBe("https://example.com")
    expect(result.results[0]!.snippet).toContain("highlighted")
    expect(result.results[0]!.score).toBe(0.9)
    expect(result.cost).toBeGreaterThan(0)
    expect(result.query).toBe("machine learning optimization")
  } finally {
    globalThis.fetch = origFetch
    if (saved) process.env.EXA_API_KEY = saved
    else delete process.env.EXA_API_KEY
  }
})

test("searchWeb handles domain filtering", async () => {
  const origFetch = globalThis.fetch
  const saved = process.env.EXA_API_KEY
  process.env.EXA_API_KEY = "test-key"

  let capturedBody: Record<string, unknown> | null = null
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  }) as unknown as typeof fetch

  try {
    await searchWeb("test", { includeDomains: ["arxiv.org", "github.com"], maxResults: 3 })
    expect(capturedBody).not.toBeNull()
    expect(capturedBody!.include_domains).toEqual(["arxiv.org", "github.com"])
    expect(capturedBody!.num_results).toBe(3)
  } finally {
    globalThis.fetch = origFetch
    if (saved) process.env.EXA_API_KEY = saved
    else delete process.env.EXA_API_KEY
  }
})

test("searchWeb falls back on provider error", async () => {
  const origFetch = globalThis.fetch
  const savedExa = process.env.EXA_API_KEY
  const savedOpenai = process.env.OPENAI_API_KEY
  process.env.EXA_API_KEY = "test-key"
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY

  // Exa returns error
  globalThis.fetch = mock(async () => new Response("Rate limited", { status: 429 })) as unknown as typeof fetch

  try {
    // Should fall back gracefully to empty results (only exa is configured and it fails)
    const result = await searchWeb("test query")
    expect(result.results).toHaveLength(0)
    expect(result.provider).toBe("none")
  } finally {
    globalThis.fetch = origFetch
    if (savedExa) process.env.EXA_API_KEY = savedExa
    else delete process.env.EXA_API_KEY
    if (savedOpenai) process.env.OPENAI_API_KEY = savedOpenai
  }
})
