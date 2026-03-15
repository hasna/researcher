/**
 * Git operations skill — commit, branch, diff, merge in a sandbox.
 */

import type { Skill } from "../registry.ts"
import type { SkillInput, SkillOutput } from "../../types.ts"

export const gitOpsSkill: Skill = {
  name: "git-ops",
  description: "Git operations: commit, diff, branch, merge within a sandbox",
  domains: ["code"],
  phases: ["parallel_experiment"],
  requires: [],
  cost_per_run: "free",

  async execute(input: SkillInput): Promise<SkillOutput> {
    if (!input.sandbox) {
      return { success: false, data: null, summary: "No sandbox available" }
    }

    const action = input.parameters.action as string
    const message = input.parameters.message as string

    switch (action) {
      case "commit": {
        await input.sandbox.execute("git add -A")
        const result = await input.sandbox.execute(`git commit -m "${message ?? "experiment"}"`)
        return {
          success: result.exitCode === 0,
          data: result.stdout,
          summary: result.exitCode === 0 ? "Committed changes" : `Commit failed: ${result.stderr}`,
        }
      }
      case "diff": {
        const diff = await input.sandbox.getDiff()
        return { success: true, data: diff, summary: `Diff: ${diff.split("\n").length} lines` }
      }
      default:
        return { success: false, data: null, summary: `Unknown git action: ${action}` }
    }
  },
}
