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

import { SkillRegistry } from "./registry.ts"
import { runCommandSkill } from "./core/run-command.ts"
import { fileEditSkill } from "./core/file-edit.ts"
import { benchmarkSkill } from "./core/benchmark.ts"
import { webSearchSkill } from "./core/web-search.ts"
import { dbQuerySkill } from "./core/db-query.ts"
import { gitOpsSkill } from "./core/git-ops.ts"

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
  return registry
}
