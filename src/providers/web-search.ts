/**
 * Web search — unified interface for Exa API and native LLM provider search.
 *
 * Search chain:
 *   1. Exa (if EXA_API_KEY available) — best structured results
 *   2. OpenAI native web search (Responses API with web_search_preview tool)
 *   3. Anthropic native web search (server-side tool)
 *   4. Graceful degradation — returns empty results
 */

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  score?: number
  publishedDate?: string
  author?: string
}

export interface WebSearchOptions {
  /** Max results to return (default: 10) */
  maxResults?: number
  /** Filter to specific domains (e.g., ["github.com", "arxiv.org"]) */
  includeDomains?: string[]
  /** Exclude domains */
  excludeDomains?: string[]
  /** Content type filter */
  type?: "keyword" | "neural" | "auto"
  /** Include full text content (more expensive, Exa only) */
  includeText?: boolean
}

export interface WebSearchResponse {
  results: WebSearchResult[]
  provider: string
  cost: number
  query: string
}

// ─── Exa Search ──────────────────────────────────────────────────────────────

export async function searchWithExa(
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) throw new Error("EXA_API_KEY not set")

  const body: Record<string, unknown> = {
    query,
    num_results: opts.maxResults ?? 10,
    type: opts.type ?? "auto",
    use_autoprompt: true,
    contents: {
      text: opts.includeText ? { max_characters: 3000 } : undefined,
      highlights: { num_sentences: 3 },
    },
  }

  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains

  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Exa search failed (${response.status}): ${text}`)
  }

  const data = (await response.json()) as {
    results: Array<{
      title: string
      url: string
      text?: string
      highlights?: string[]
      score: number
      published_date?: string
      author?: string
    }>
  }

  return {
    results: data.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.highlights?.join(" ") || r.text?.slice(0, 500) || "",
      score: r.score,
      publishedDate: r.published_date,
      author: r.author,
    })),
    provider: "exa",
    cost: 0.001 * (opts.maxResults ?? 10), // ~$0.001 per result
    query,
  }
}

// ─── OpenAI Native Web Search ────────────────────────────────────────────────

export async function searchWithOpenAI(
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY not set")

  // Use OpenAI Responses API with web_search_preview tool
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      tools: [{ type: "web_search_preview", search_context_size: opts.maxResults && opts.maxResults > 5 ? "high" : "medium" }],
      input: `Search the web for: ${query}${opts.includeDomains?.length ? `\nFocus on these sites: ${opts.includeDomains.join(", ")}` : ""}`,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OpenAI web search failed (${response.status}): ${text}`)
  }

  const data = (await response.json()) as {
    output: Array<{
      type: string
      content?: Array<{
        type: string
        text?: string
        annotations?: Array<{
          type: string
          url?: string
          title?: string
          start_index?: number
          end_index?: number
        }>
      }>
    }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  // Extract search results from the response annotations
  const results: WebSearchResult[] = []
  const seenUrls = new Set<string>()

  for (const output of data.output) {
    if (output.content) {
      for (const block of output.content) {
        if (block.annotations) {
          for (const ann of block.annotations) {
            if (ann.type === "url_citation" && ann.url && !seenUrls.has(ann.url)) {
              seenUrls.add(ann.url)
              results.push({
                title: ann.title || ann.url,
                url: ann.url,
                snippet: block.text?.slice(
                  Math.max(0, (ann.start_index ?? 0) - 100),
                  (ann.end_index ?? 200) + 100,
                ) || "",
              })
            }
          }
        }
      }
    }
  }

  // Cost estimate based on tokens
  const tokensIn = data.usage?.input_tokens ?? 500
  const tokensOut = data.usage?.output_tokens ?? 500
  const cost = (tokensIn * 0.4 + tokensOut * 1.6) / 1_000_000 // gpt-4.1-mini pricing

  return {
    results: results.slice(0, opts.maxResults ?? 10),
    provider: "openai",
    cost,
    query,
  }
}

// ─── Anthropic Native Web Search ─────────────────────────────────────────────

export async function searchWithAnthropic(
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set")

  // Use Anthropic's server-side web search tool
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      tools: [{
        type: "web_search",
        name: "web_search",
        max_uses: opts.maxResults ?? 5,
      }],
      messages: [{
        role: "user",
        content: `Search the web for: ${query}${opts.includeDomains?.length ? `\nFocus on these sites: ${opts.includeDomains.join(", ")}` : ""}\n\nReturn the search results with titles, URLs, and relevant snippets.`,
      }],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Anthropic web search failed (${response.status}): ${text}`)
  }

  const data = (await response.json()) as {
    content: Array<{
      type: string
      text?: string
      source?: { url?: string; title?: string; snippet?: string[] }
      content?: Array<{ type: string; url?: string; title?: string; encrypted_content?: string; text?: string }>
    }>
    usage: { input_tokens: number; output_tokens: number }
  }

  const results: WebSearchResult[] = []
  const seenUrls = new Set<string>()

  for (const block of data.content) {
    // Extract from web_search_tool_result blocks
    if (block.type === "web_search_tool_result" && block.content) {
      for (const item of block.content) {
        if (item.type === "web_search_result" && item.url && !seenUrls.has(item.url)) {
          seenUrls.add(item.url)
          results.push({
            title: item.title || item.url,
            url: item.url,
            snippet: item.text || "",
          })
        }
      }
    }
    // Also extract citations from text blocks
    if (block.type === "text" && block.text) {
      // Anthropic includes citations inline — the search results above are the primary source
    }
  }

  const cost = (data.usage.input_tokens * 0.8 + data.usage.output_tokens * 4) / 1_000_000

  return {
    results: results.slice(0, opts.maxResults ?? 10),
    provider: "anthropic",
    cost,
    query,
  }
}

// ─── Unified Search with Fallback Chain ──────────────────────────────────────

export type SearchProvider = "exa" | "openai" | "anthropic"

/**
 * Search the web using the best available provider with automatic fallback.
 * Chain: Exa → OpenAI → Anthropic → empty results.
 */
export async function searchWeb(
  query: string,
  opts: WebSearchOptions & { preferredProvider?: SearchProvider } = {},
): Promise<WebSearchResponse> {
  // Build provider chain based on preference and availability
  const chain: Array<() => Promise<WebSearchResponse>> = []

  if (opts.preferredProvider) {
    // Put preferred provider first
    const providerMap: Record<SearchProvider, () => Promise<WebSearchResponse>> = {
      exa: () => searchWithExa(query, opts),
      openai: () => searchWithOpenAI(query, opts),
      anthropic: () => searchWithAnthropic(query, opts),
    }
    chain.push(providerMap[opts.preferredProvider])
  }

  // Default chain
  if (process.env.EXA_API_KEY) chain.push(() => searchWithExa(query, opts))
  if (process.env.OPENAI_API_KEY) chain.push(() => searchWithOpenAI(query, opts))
  if (process.env.ANTHROPIC_API_KEY) chain.push(() => searchWithAnthropic(query, opts))

  // Deduplicate
  const seen = new Set<string>()
  const uniqueChain = chain.filter((fn) => {
    const key = fn.toString()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Try each provider in order
  const errors: string[] = []
  for (const searchFn of uniqueChain) {
    try {
      return await searchFn()
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  // All failed — return empty results
  return {
    results: [],
    provider: "none",
    cost: 0,
    query,
  }
}
