/**
 * AI Cycle Generator — uses LLM to create new cycle definitions based on
 * performance data from past runs.
 *
 * The generator analyzes what worked (and what didn't), then prompts an LLM
 * to design a novel cycle optimized for a target domain and objective.
 */

import type { Database } from "bun:sqlite"
import type { CycleDefinition, PhaseDefinition } from "../types.ts"
import type { ProviderRouter } from "../providers/router.ts"
import type { CyclePerformanceMetrics } from "./cycle-analyzer.ts"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CycleGenerationConfig {
  db: Database
  router: ProviderRouter
  performanceData: CyclePerformanceMetrics[]
  domain: string
  optimizeFor: "cost" | "quality" | "speed" | "balanced"
}

// Valid values for type-checking generated cycles
const VALID_PHASE_TYPES: PhaseDefinition["type"][] = [
  "think",
  "gather",
  "parallel_experiment",
  "synthesize",
  "escalate",
]

const VALID_PROVIDER_HINTS: PhaseDefinition["provider_hint"][] = [
  "cheap",
  "balanced",
  "smart",
  "best",
  "user_choice",
]

// ─── Generation ─────────────────────────────────────────────────────────────

/**
 * Generate a new cycle definition using an LLM.
 *
 * Provides performance data context to the model and asks it to design
 * an optimized cycle for the given domain and objective.
 */
export async function generateCycle(config: CycleGenerationConfig): Promise<CycleDefinition> {
  const { router, performanceData, domain, optimizeFor } = config

  const prompt = buildGenerationPrompt(performanceData, domain, optimizeFor)

  const result = await router.generate(prompt, "smart", {
    temperature: 0.7,
    max_tokens: 2000,
    system: `You are a research methodology designer. You create YAML cycle definitions for an autonomous research framework. Each cycle has phases with specific types and provider hints. Your output MUST be valid YAML only — no markdown fences, no explanation, just the YAML document.`,
  })

  // Parse the YAML from the LLM response
  const yamlContent = extractYaml(result.content)
  const raw = parseYaml(yamlContent) as Record<string, unknown>

  // Normalize to CycleDefinition
  const cycle = normalizeCycleFromRaw(raw, domain)

  // Validate before returning
  if (!validateGeneratedCycle(cycle)) {
    throw new Error("Generated cycle failed validation")
  }

  return cycle
}

/**
 * Validate that a generated cycle has all required fields and valid values.
 */
export function validateGeneratedCycle(cycle: CycleDefinition): boolean {
  // Must have a name
  if (!cycle.name || typeof cycle.name !== "string" || cycle.name.trim().length === 0) {
    return false
  }

  // Must have at least 2 phases
  if (!Array.isArray(cycle.phases) || cycle.phases.length < 2) {
    return false
  }

  // Each phase must have valid type and provider_hint
  for (const phase of cycle.phases) {
    if (!phase.name || typeof phase.name !== "string") return false
    if (!VALID_PHASE_TYPES.includes(phase.type)) return false
    if (!VALID_PROVIDER_HINTS.includes(phase.provider_hint)) return false
    if (typeof phase.max_parallel !== "number" || phase.max_parallel < 1) return false
  }

  // Must have id
  if (!cycle.id || typeof cycle.id !== "string") return false

  // Author must be "ai" for generated cycles
  if (cycle.author !== "ai") return false

  return true
}

/**
 * Serialize a CycleDefinition to YAML string (for saving to file or DB).
 */
export function cycleToYaml(cycle: CycleDefinition): string {
  const obj = {
    name: cycle.name,
    description: cycle.description,
    author: cycle.author,
    phases: cycle.phases.map((p) => ({
      name: p.name,
      type: p.type,
      provider_hint: p.provider_hint,
      skills: p.skills,
      max_parallel: p.max_parallel,
      description: p.description,
      input: p.input,
      output: p.output,
    })),
  }
  return stringifyYaml(obj)
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function buildGenerationPrompt(
  performanceData: CyclePerformanceMetrics[],
  domain: string,
  optimizeFor: string,
): string {
  const sorted = [...performanceData].sort(
    (a, b) => b.experimentSuccessRate - a.experimentSuccessRate,
  )

  const bestCycles = sorted.slice(0, 3)
  const worstCycles = sorted.slice(-3).reverse()

  let perfSummary = "## Performance Data from Past Cycles\n\n"

  if (bestCycles.length > 0) {
    perfSummary += "### Best Performing Cycles\n"
    for (const m of bestCycles) {
      perfSummary += `- **${m.cycleId}**: ${m.runCount} runs, ${(m.experimentSuccessRate * 100).toFixed(0)}% success, `
      perfSummary += `avg confidence ${(m.avgConfidence * 100).toFixed(0)}%, cost efficiency ${m.costEfficiency.toFixed(2)} knowledge/$, `
      perfSummary += `total cost $${m.totalCost.toFixed(4)}\n`
      if (Object.keys(m.avgPhaseDuration).length > 0) {
        perfSummary += `  Phase durations: ${JSON.stringify(m.avgPhaseDuration)}\n`
      }
    }
  }

  if (worstCycles.length > 0) {
    perfSummary += "\n### Worst Performing Cycles\n"
    for (const m of worstCycles) {
      perfSummary += `- **${m.cycleId}**: ${m.runCount} runs, ${(m.experimentSuccessRate * 100).toFixed(0)}% success, `
      perfSummary += `avg confidence ${(m.avgConfidence * 100).toFixed(0)}%\n`
    }
  }

  const objectiveGuidance: Record<string, string> = {
    cost: "Minimize total cost. Use cheap providers where possible. Fewer phases. Avoid 'best' provider hint unless absolutely necessary.",
    quality:
      "Maximize knowledge quality and confidence. Use smart/best providers for synthesis. Add extra think/synthesize phases. More parallel experiments.",
    speed:
      "Minimize time to knowledge. Use cheap/fast providers. Fewer phases. High parallelism for experiments.",
    balanced:
      "Balance cost, quality, and speed. Use escalating provider hints (cheap → balanced → smart). Standard phase count.",
  }

  return `Design a new research cycle optimized for the "${domain}" domain.

${perfSummary}

## Optimization Target: ${optimizeFor}
${objectiveGuidance[optimizeFor] ?? "Balance all factors."}

## Rules
- Valid phase types: think, gather, parallel_experiment, synthesize, escalate
- Valid provider hints: cheap, balanced, smart, best, user_choice
- Each cycle needs 2-6 phases
- max_parallel should be 1 for non-experiment phases, 1-30 for parallel_experiment
- Skills are strings like: web-search, db-query, file-scan, file-edit, run-command, benchmark, git-ops
- author MUST be "ai"
- Give the cycle a unique, descriptive name

## Output Format (YAML only, no markdown fences)

name: Your Cycle Name
description: >
  What this cycle does and why
author: ai
phases:
  - name: phase_name
    type: think
    provider_hint: balanced
    skills: []
    max_parallel: 1
    description: What this phase does
    input: What it receives
    output: What it produces
`
}

/**
 * Extract YAML content from LLM response.
 * Handles cases where the LLM wraps output in markdown code fences.
 */
function extractYaml(content: string): string {
  // Strip markdown YAML code fences if present
  const fenceMatch = content.match(/```(?:ya?ml)?\s*\n([\s\S]*?)```/)
  if (fenceMatch) {
    return fenceMatch[1]!.trim()
  }
  // Strip generic code fences
  const genericFence = content.match(/```\s*\n([\s\S]*?)```/)
  if (genericFence) {
    return genericFence[1]!.trim()
  }
  return content.trim()
}

/**
 * Normalize raw parsed YAML into a CycleDefinition with all required fields.
 */
function normalizeCycleFromRaw(
  raw: Record<string, unknown>,
  domain: string,
): CycleDefinition {
  const name = String(raw.name ?? `ai-${domain}-${Date.now()}`)
  const id = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")

  const rawPhases = Array.isArray(raw.phases) ? raw.phases : []
  const phases: PhaseDefinition[] = rawPhases.map((p: Record<string, unknown>) => ({
    name: String(p.name ?? "unnamed"),
    type: normalizePhaseType(String(p.type ?? "think")),
    provider_hint: normalizeProviderHint(String(p.provider_hint ?? "balanced")),
    skills: Array.isArray(p.skills) ? p.skills.map(String) : [],
    max_parallel: typeof p.max_parallel === "number" ? Math.max(1, p.max_parallel) : 1,
    description: String(p.description ?? ""),
    input: String(p.input ?? ""),
    output: String(p.output ?? ""),
  }))

  return {
    id,
    name,
    description: String(raw.description ?? "AI-generated cycle"),
    author: "ai",
    phases,
    meta: {
      discovered_at: new Date().toISOString(),
      best_domains: [domain],
      total_runs: 0,
    },
  }
}

function normalizePhaseType(type: string): PhaseDefinition["type"] {
  if (VALID_PHASE_TYPES.includes(type as PhaseDefinition["type"])) {
    return type as PhaseDefinition["type"]
  }
  // Map common LLM mistakes
  if (type.includes("experiment")) return "parallel_experiment"
  if (type.includes("synth")) return "synthesize"
  if (type.includes("gather") || type.includes("collect")) return "gather"
  if (type.includes("escalat")) return "escalate"
  return "think"
}

function normalizeProviderHint(hint: string): PhaseDefinition["provider_hint"] {
  if (VALID_PROVIDER_HINTS.includes(hint as PhaseDefinition["provider_hint"])) {
    return hint as PhaseDefinition["provider_hint"]
  }
  if (hint.includes("cheap") || hint.includes("fast")) return "cheap"
  if (hint.includes("smart")) return "smart"
  if (hint.includes("best")) return "best"
  return "balanced"
}
