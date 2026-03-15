/**
 * Cycle definition parser — loads YAML cycle definitions and validates them.
 */

import { parse as parseYaml } from "yaml"
import { z } from "zod"
import type { CycleDefinition, PhaseDefinition } from "../types.ts"

// ─── Validation schema ───────────────────────────────────────────────────────

const PhaseSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["think", "gather", "parallel_experiment", "synthesize", "escalate"]),
  provider_hint: z.enum(["cheap", "balanced", "smart", "best", "user_choice"]),
  skills: z.array(z.string()).default([]),
  max_parallel: z.number().int().positive().default(1),
  description: z.string().default(""),
  input: z.string().default(""),
  output: z.string().default(""),
})

const CycleSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  author: z.enum(["human", "ai"]).default("human"),
  phases: z.array(PhaseSchema).min(1),
})

// ─── Parse functions ─────────────────────────────────────────────────────────

export function parseCycleYaml(yamlContent: string): CycleDefinition {
  const raw = parseYaml(yamlContent)
  const validated = CycleSchema.parse(raw)

  return {
    id: validated.name.toLowerCase().replace(/\s+/g, "-"),
    name: validated.name,
    description: validated.description,
    author: validated.author,
    phases: validated.phases.map(
      (p): PhaseDefinition => ({
        name: p.name,
        type: p.type,
        provider_hint: p.provider_hint,
        skills: p.skills,
        max_parallel: p.max_parallel,
        description: p.description,
        input: p.input,
        output: p.output,
      }),
    ),
    meta: {},
  }
}

export async function loadCycleFromFile(filePath: string): Promise<CycleDefinition> {
  const content = await Bun.file(filePath).text()
  return parseCycleYaml(content)
}

export function validateCycleDefinition(cycle: unknown): { valid: boolean; errors: string[] } {
  const result = CycleSchema.safeParse(cycle)
  if (result.success) {
    return { valid: true, errors: [] }
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  }
}
