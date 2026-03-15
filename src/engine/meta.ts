/**
 * Meta-cycle system — AI-discovered research cycles.
 *
 * Uses PFLK on the cycles themselves:
 * - Problem: Which cycles underperform in which domains?
 * - Feedback: Historical success rates, cost efficiency, domain fit
 * - Loophole: Propose new cycle definitions
 * - Knowledge: Promote winning cycles
 */

import type { Database } from "bun:sqlite"
import type { ProviderRouter } from "../providers/router.ts"
import type { CycleDefinition } from "../types.ts"
import { listCycles, registerCycle } from "../db/index.ts"
import { parseCycleYaml, validateCycleDefinition } from "../cycles/parser.ts"

/**
 * Analyze cycle performance and suggest improvements.
 */
export async function analyzeCyclePerformance(db: Database): Promise<CycleAnalysis[]> {
  const cycles = listCycles(db) as Record<string, unknown>[]
  return cycles.map((c) => ({
    name: c.name as string,
    author: c.author as string,
    totalRuns: c.total_runs as number,
    successRate: c.success_rate as number | null,
    bestDomains: JSON.parse((c.best_domains as string) ?? "[]"),
  }))
}

export interface CycleAnalysis {
  name: string
  author: string
  totalRuns: number
  successRate: number | null
  bestDomains: string[]
}

/**
 * Use an LLM to propose a new research cycle based on accumulated data.
 */
export async function proposeCycle(
  router: ProviderRouter,
  context: {
    existingCycles: CycleAnalysis[]
    domain?: string
    problem?: string
  },
): Promise<CycleDefinition | null> {
  const prompt = `You are a meta-researcher designing new research cycles.

Existing cycles and their performance:
${context.existingCycles.map((c) => `- ${c.name} (${c.author}): ${c.totalRuns} runs, success rate: ${c.successRate ?? "unknown"}, best domains: ${c.bestDomains.join(", ") || "general"}`).join("\n")}

${context.domain ? `Target domain: ${context.domain}` : ""}
${context.problem ? `Problem to solve: ${context.problem}` : ""}

Design a NEW research cycle that might outperform existing ones. Output it as YAML with this structure:

name: <CycleName>
description: <one-line description>
author: ai
phases:
  - name: <phase_name>
    type: <think|gather|parallel_experiment|synthesize|escalate>
    provider_hint: <cheap|balanced|smart|best|user_choice>
    skills: [<skill_names>]
    max_parallel: <number>
    description: <what this phase does>
    input: <what it receives>
    output: <what it produces>

Be creative. Consider:
- Different phase orderings
- Multiple gather phases
- Nested experiment phases
- Different provider escalation strategies
- Phases that existing cycles lack`

  try {
    const result = await router.generate(prompt, "best", {
      system: "You are an expert at designing research methodologies. Output only valid YAML.",
      max_tokens: 2000,
    })

    // Extract YAML from response
    const yamlMatch = result.content.match(/```ya?ml\n([\s\S]*?)```/) ?? [null, result.content]
    const yamlContent = yamlMatch[1] ?? result.content

    const cycle = parseCycleYaml(yamlContent)
    cycle.author = "ai"
    cycle.meta = { discovered_at: new Date().toISOString() }

    return cycle
  } catch {
    return null
  }
}

/**
 * Register an AI-discovered cycle in the database.
 */
export function saveCycle(db: Database, cycle: CycleDefinition): string {
  return registerCycle(db, {
    name: cycle.name,
    author: cycle.author,
    definition: cycle,
  })
}

/**
 * Evaluate a cycle's effectiveness based on workspace outcomes.
 */
export function evaluateCycle(db: Database, cycleName: string): {
  totalWorkspaces: number
  completedWorkspaces: number
  failedWorkspaces: number
  avgCost: number
} {
  const row = db
    .query(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(cost_total) as avg_cost
       FROM workspaces WHERE cycle_id = ?`,
    )
    .get(cycleName) as { total: number; completed: number; failed: number; avg_cost: number | null }

  return {
    totalWorkspaces: row.total,
    completedWorkspaces: row.completed,
    failedWorkspaces: row.failed,
    avgCost: row.avg_cost ?? 0,
  }
}
