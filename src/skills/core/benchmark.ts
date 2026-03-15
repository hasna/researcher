/**
 * Benchmark skill — run a command and parse numeric metrics from output.
 */

import type { Skill } from "../registry.ts"
import type { SkillInput, SkillOutput } from "../../types.ts"
import { parseMetrics } from "../../engine/parallel.ts"

export const benchmarkSkill: Skill = {
  name: "benchmark",
  description: "Run a benchmark command and parse numeric metrics from output",
  domains: ["general", "code"],
  phases: ["parallel_experiment"],
  requires: [],
  cost_per_run: "free",

  async execute(input: SkillInput): Promise<SkillOutput> {
    const command = input.parameters.command as string
    const metricName = input.parameters.metric_name as string ?? "score"

    if (!command) {
      return { success: false, data: null, summary: "No command provided" }
    }
    if (!input.sandbox) {
      return { success: false, data: null, summary: "No sandbox available" }
    }

    const timeout = (input.parameters.timeout as number) ?? 300_000
    const result = await input.sandbox.execute(command)

    if (result.exitCode !== 0) {
      return {
        success: false,
        data: { exitCode: result.exitCode, stderr: result.stderr },
        summary: `Benchmark crashed (exit ${result.exitCode})`,
      }
    }

    const metrics = parseMetrics(result.stdout, metricName)
    return {
      success: true,
      data: metrics,
      summary: `Benchmark complete: ${Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    }
  },
}
