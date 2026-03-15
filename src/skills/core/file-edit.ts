/**
 * File edit skill — read/write/diff files in a sandbox.
 */

import type { Skill } from "../registry.ts"
import type { SkillInput, SkillOutput } from "../../types.ts"

export const fileEditSkill: Skill = {
  name: "file-edit",
  description: "Read, write, and diff files in a sandbox",
  domains: ["general"],
  phases: ["parallel_experiment", "gather"],
  requires: [],
  cost_per_run: "free",

  async execute(input: SkillInput): Promise<SkillOutput> {
    if (!input.sandbox) {
      return { success: false, data: null, summary: "No sandbox available" }
    }

    const action = input.parameters.action as string
    const path = input.parameters.path as string

    switch (action) {
      case "read": {
        const content = await input.sandbox.readFile(path)
        return { success: true, data: content, summary: `Read ${path} (${content.length} chars)` }
      }
      case "write": {
        const content = input.parameters.content as string
        await input.sandbox.writeFile(path, content)
        return { success: true, data: null, summary: `Wrote ${path} (${content.length} chars)` }
      }
      case "diff": {
        const diff = await input.sandbox.getDiff()
        return { success: true, data: diff, summary: `Diff: ${diff.split("\n").length} lines` }
      }
      default:
        return { success: false, data: null, summary: `Unknown action: ${action}` }
    }
  },
}
