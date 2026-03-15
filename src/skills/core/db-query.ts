/**
 * DB query skill — query the researcher SQLite for past experiments/knowledge.
 */

import type { Skill } from "../registry.ts"
import type { SkillInput, SkillOutput } from "../../types.ts"

export const dbQuerySkill: Skill = {
  name: "db-query",
  description: "Query the researcher database for past experiments, results, and knowledge",
  domains: ["general"],
  phases: ["gather", "synthesize"],
  requires: [],
  cost_per_run: "free",

  async execute(input: SkillInput): Promise<SkillOutput> {
    const queryType = input.parameters.type as string
    // This skill needs access to the DB — it's provided via context
    // For now, return a structured placeholder

    return {
      success: true,
      data: { queryType, note: "DB query skill — requires database context injection" },
      summary: `DB query (${queryType ?? "general"}) — returns past experiment data`,
    }
  },
}
