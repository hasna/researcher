/**
 * Web search skill — search the web for information (uses fetch).
 */

import type { Skill } from "../registry.ts"
import type { SkillInput, SkillOutput } from "../../types.ts"

export const webSearchSkill: Skill = {
  name: "web-search",
  description: "Search the web for information related to the research problem",
  domains: ["general"],
  phases: ["gather"],
  requires: ["internet"],
  cost_per_run: "free",

  async execute(input: SkillInput): Promise<SkillOutput> {
    const query = input.parameters.query as string
    if (!query) {
      return { success: false, data: null, summary: "No search query provided" }
    }

    // Placeholder — in production this would use Exa, Serper, or similar API
    // For now, return a message indicating web search capability
    return {
      success: true,
      data: { query, note: "Web search requires API integration (Exa, Serper, etc.)" },
      summary: `Web search for: "${query}" — requires API key configuration`,
    }
  },
}
