/**
 * Skills system — registry + built-in skills.
 */

export { SkillRegistry, type Skill } from "./registry.ts"
export { runCommandSkill } from "./core/run-command.ts"
export { fileEditSkill } from "./core/file-edit.ts"
export { benchmarkSkill } from "./core/benchmark.ts"
export { webSearchSkill } from "./core/web-search.ts"
export { dbQuerySkill } from "./core/db-query.ts"
export { gitOpsSkill } from "./core/git-ops.ts"
export { pdfParseSkill } from "./core/pdf-parse.ts"
export { paperSearchSkill } from "./core/paper-search.ts"
export { loadOpenSkills, searchOpenSkills, getOpenSkillInfo } from "./open-skills.ts"

import { SkillRegistry } from "./registry.ts"
import { runCommandSkill } from "./core/run-command.ts"
import { fileEditSkill } from "./core/file-edit.ts"
import { benchmarkSkill } from "./core/benchmark.ts"
import { webSearchSkill } from "./core/web-search.ts"
import { dbQuerySkill } from "./core/db-query.ts"
import { gitOpsSkill } from "./core/git-ops.ts"
import { pdfParseSkill } from "./core/pdf-parse.ts"
import { paperSearchSkill } from "./core/paper-search.ts"

/**
 * Create a skill registry with all built-in skills registered.
 */
export function createDefaultRegistry(): SkillRegistry {
  const registry = new SkillRegistry()
  registry.register(runCommandSkill)
  registry.register(fileEditSkill)
  registry.register(benchmarkSkill)
  registry.register(webSearchSkill)
  registry.register(dbQuerySkill)
  registry.register(gitOpsSkill)
  registry.register(pdfParseSkill)
  registry.register(paperSearchSkill)
  return registry
}

/**
 * Create a skill registry with built-in + open-skills SDK skills.
 * Async because SDK skills are loaded dynamically.
 */
export async function createFullRegistry(): Promise<SkillRegistry> {
  const registry = createDefaultRegistry()
  try {
    const { loadOpenSkills } = await import("./open-skills.ts")
    const openSkills = await loadOpenSkills()
    for (const skill of openSkills) {
      registry.register(skill)
    }
  } catch {
    // open-skills SDK not available — built-in skills only
  }
  return registry
}
