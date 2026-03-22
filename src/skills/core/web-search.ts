/**
 * Web search skill — multi-provider search (Exa, OpenAI, Anthropic).
 *
 * Fallback chain: Exa (if EXA_API_KEY) → OpenAI native → Anthropic native.
 * All providers return structured results with titles, URLs, and snippets.
 */

import type { Skill } from "../registry.ts"
import type { SkillInput, SkillOutput } from "../../types.ts"
import { searchWeb } from "../../providers/web-search.ts"

export const webSearchSkill: Skill = {
  name: "web-search",
  description: "Search the web using Exa, OpenAI, or Anthropic with automatic fallback. Returns structured results with titles, URLs, and snippets.",
  domains: ["general"],
  phases: ["gather"],
  requires: ["internet"],
  cost_per_run: "cheap",

  async execute(input: SkillInput): Promise<SkillOutput> {
    const query = input.parameters.query as string
    if (!query) {
      return { success: false, data: null, summary: "No search query provided" }
    }

    try {
      const maxResults = (input.parameters.max_results as number) ?? 5
      const domains = input.parameters.domains as string[] | undefined

      const response = await searchWeb(query, {
        maxResults,
        includeDomains: domains,
      })

      if (response.results.length === 0) {
        return {
          success: true,
          data: { query, results: [], provider: "none" },
          summary: `No results for "${query}". Set EXA_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY for web search.`,
          cost: 0,
        }
      }

      const formattedResults = response.results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet.slice(0, 300)}`)
        .join("\n\n")

      return {
        success: true,
        data: { query, results: response.results, provider: response.provider },
        summary: `Found ${response.results.length} results via ${response.provider}:\n${formattedResults}`,
        cost: response.cost,
      }
    } catch (err) {
      return {
        success: false,
        data: { query, error: err instanceof Error ? err.message : String(err) },
        summary: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
