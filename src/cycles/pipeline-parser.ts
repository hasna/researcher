/**
 * Pipeline definition parser -- loads YAML pipeline definitions and validates them.
 *
 * Pipeline YAML format mirrors the cycle YAML format but defines ordered steps
 * that each reference a cycle ID, with optional conditions for branching.
 */

import { parse as parseYaml } from "yaml"
import { z } from "zod"
import type { CyclePipeline, PipelineStep, PipelineCondition } from "../types.ts"

// -- Validation schema -------------------------------------------------------

const PipelineConditionSchema = z.object({
  type: z.enum(["confidence_threshold", "knowledge_gap", "experiment_success_rate", "always", "custom"]),
  threshold: z.number().min(0).max(1).optional(),
  expression: z.string().optional(),
  onFail: z.enum(["skip", "branch", "stop"]),
  branchTo: z.string().optional(),
})

const PipelineStepSchema = z.object({
  id: z.string().min(1),
  cycleId: z.string().min(1),
  condition: PipelineConditionSchema.optional(),
  overrides: z
    .object({
      maxParallel: z.number().int().positive().optional(),
      providerHint: z.string().optional(),
      evaluationCommand: z.string().optional(),
    })
    .optional(),
})

const PipelineSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  author: z.string().default("human"),
  steps: z.array(PipelineStepSchema).min(1),
  meta: z.record(z.unknown()).optional(),
})

// -- Parse functions ----------------------------------------------------------

export function parsePipelineYaml(yamlContent: string): CyclePipeline {
  const raw = parseYaml(yamlContent)
  const validated = PipelineSchema.parse(raw)

  return {
    id: validated.name.toLowerCase().replace(/\s+/g, "-"),
    name: validated.name,
    description: validated.description,
    author: validated.author,
    steps: validated.steps.map(
      (s): PipelineStep => ({
        id: s.id,
        cycleId: s.cycleId,
        condition: s.condition as PipelineCondition | undefined,
        overrides: s.overrides,
      }),
    ),
    meta: validated.meta,
  }
}

export async function loadPipelineFromFile(filePath: string): Promise<CyclePipeline> {
  const content = await Bun.file(filePath).text()
  return parsePipelineYaml(content)
}

export function validatePipelineDefinition(pipeline: unknown): { valid: boolean; errors: string[] } {
  const result = PipelineSchema.safeParse(pipeline)
  if (result.success) {
    // Additional validation: check branchTo references exist
    const stepIds = new Set(result.data.steps.map((s) => s.id))
    const errors: string[] = []
    for (const step of result.data.steps) {
      if (step.condition?.onFail === "branch" && step.condition.branchTo) {
        if (!stepIds.has(step.condition.branchTo)) {
          errors.push(`Step "${step.id}": branchTo "${step.condition.branchTo}" references non-existent step`)
        }
      }
    }
    if (errors.length > 0) {
      return { valid: false, errors }
    }
    return { valid: true, errors: [] }
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  }
}
