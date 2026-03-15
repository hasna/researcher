/**
 * Skills registry — loads and manages pluggable skills.
 */

import type { SkillDefinition, SkillInput, SkillOutput } from "../types.ts"

export interface Skill extends SkillDefinition {
  execute(input: SkillInput): Promise<SkillOutput>
}

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map()

  register(skill: Skill): void {
    this.skills.set(skill.name, skill)
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  list(): Skill[] {
    return [...this.skills.values()]
  }

  has(name: string): boolean {
    return this.skills.has(name)
  }

  /**
   * Get all skills available for a given phase type.
   */
  forPhase(phaseType: string): Skill[] {
    return this.list().filter((s) => s.phases.includes(phaseType as SkillDefinition["phases"][number]))
  }

  /**
   * Get all skills available for a given domain.
   */
  forDomain(domain: string): Skill[] {
    return this.list().filter((s) => s.domains.includes(domain) || s.domains.includes("general"))
  }
}
