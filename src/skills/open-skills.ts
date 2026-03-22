/**
 * Open-skills SDK integration.
 *
 * Bridges @hasna/skills ecosystem into the researcher's skill registry.
 * Skills from the open-skills library are loaded and adapted to the
 * researcher's Skill interface.
 */

import type { Skill } from "./registry.ts"
import type { SkillInput, SkillOutput } from "../types.ts"

/**
 * Load skills from the @hasna/skills SDK.
 * Returns researcher-compatible Skill objects for each installed skill.
 */
export async function loadOpenSkills(): Promise<Skill[]> {
  try {
    const sdk = await import("@hasna/skills")
    const skills: Skill[] = []

    for (const meta of sdk.SKILLS) {
      skills.push({
        name: `os:${meta.name}`,
        description: `[open-skills] ${meta.description}`,
        domains: mapCategoryToDomains(meta.category),
        phases: ["gather", "think"],
        requires: meta.dependencies ?? [],
        cost_per_run: "free",

        async execute(input: SkillInput): Promise<SkillOutput> {
          try {
            // runSkill expects skill name and array of string args
            const args = [input.context, ...(input.parameters.query ? [String(input.parameters.query)] : [])]
            const result = await sdk.runSkill(meta.name, args)

            const resultStr = typeof result === "string" ? result : JSON.stringify(result)
            return {
              success: true,
              data: result,
              summary: `[${meta.name}] ${resultStr.slice(0, 500)}`,
            }
          } catch (err) {
            return {
              success: false,
              data: null,
              summary: `Skill ${meta.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            }
          }
        },
      })
    }

    return skills
  } catch {
    // SDK not available — return empty
    return []
  }
}

/**
 * Search for skills in the open-skills registry.
 */
export async function searchOpenSkills(query: string): Promise<Array<{ name: string; description: string; category: string }>> {
  try {
    const sdk = await import("@hasna/skills")
    return sdk.searchSkills(query).map(s => ({
      name: s.name,
      description: s.description,
      category: s.category,
    }))
  } catch {
    return []
  }
}

/**
 * Get info about a specific open-skill.
 */
export async function getOpenSkillInfo(name: string): Promise<{ name: string; description: string; category: string; tags: string[] } | null> {
  try {
    const sdk = await import("@hasna/skills")
    const skill = sdk.getSkill(name)
    if (!skill) return null
    return { name: skill.name, description: skill.description, category: skill.category, tags: skill.tags }
  } catch {
    return null
  }
}

function mapCategoryToDomains(category: string): string[] {
  const mapping: Record<string, string[]> = {
    "Development Tools": ["code", "engineering"],
    "Business & Marketing": ["marketing", "business"],
    "Productivity & Organization": ["general"],
    "Project Management": ["management"],
    "Content Generation": ["content", "writing"],
    "Finance & Compliance": ["finance"],
    "Data & Analysis": ["data", "analytics"],
    "Media Processing": ["media"],
    "Design & Branding": ["design"],
    "Web & Browser": ["web"],
    "Research & Writing": ["research", "academic"],
    "Science & Academic": ["science", "academic"],
    "Education & Learning": ["education"],
    "Communication": ["general"],
    "Health & Wellness": ["health"],
    "Travel & Lifestyle": ["general"],
    "Event Management": ["events"],
  }
  return mapping[category] ?? ["general"]
}
