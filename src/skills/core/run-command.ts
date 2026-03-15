/**
 * Run command skill — execute shell commands in a sandbox with timeout.
 */

import type { Skill } from "../registry.ts"
import type { SkillInput, SkillOutput } from "../../types.ts"

export const runCommandSkill: Skill = {
  name: "run-command",
  description: "Execute shell commands in a sandbox with timeout",
  domains: ["general"],
  phases: ["gather", "parallel_experiment"],
  requires: [],
  cost_per_run: "free",

  async execute(input: SkillInput): Promise<SkillOutput> {
    const command = input.parameters.command as string
    if (!command) {
      return { success: false, data: null, summary: "No command provided" }
    }
    if (!input.sandbox) {
      return { success: false, data: null, summary: "No sandbox available" }
    }

    const timeout = (input.parameters.timeout as number) ?? 60_000
    const result = await input.sandbox.execute(command)

    return {
      success: result.exitCode === 0,
      data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      summary: result.exitCode === 0
        ? `Command succeeded: ${result.stdout.slice(0, 200)}`
        : `Command failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
    }
  },
}
