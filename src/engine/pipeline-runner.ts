/**
 * Pipeline runner -- executes multi-cycle pipelines with conditional branching.
 *
 * A pipeline is an ordered sequence of steps, each executing a full cycle.
 * Steps can have conditions that gate execution, support branching to
 * alternative steps, and pass accumulated knowledge between cycles.
 */

import type { Database } from "bun:sqlite"
import type {
  CyclePipeline,
  PipelineStep,
  PipelineCondition,
  PipelineResult,
  PipelineStepResult,
} from "../types.ts"
import type { ProviderRouter } from "../providers/router.ts"
import type { SandboxRouter, ResolveHints } from "../sandbox/router.ts"
import type { CycleRegistry } from "../cycles/registry.ts"
import type { CycleMode } from "./cycle-runner.ts"
import type { ResearchEventEmitter } from "./events.ts"
import { runCycle, type CycleResult } from "./cycle-runner.ts"
import { queryKnowledge } from "./knowledge.ts"
import { createWorkspace } from "../db/index.ts"
import { createPipelineRun, updatePipelineRun } from "../db/index.ts"
import { getGlobalEmitter } from "./events.ts"

export interface PipelineRunnerConfig {
  db: Database
  router: ProviderRouter
  projectId: string
  pipeline: CyclePipeline
  cycleRegistry: CycleRegistry
  context: {
    projectName: string
    domain: string
    metricName: string
    metricDirection: string
    userGoal?: string
  }
  mode?: CycleMode
  sandboxRouter?: SandboxRouter
  sandboxHints?: ResolveHints
  evaluationCommand?: string
  emitter?: ResearchEventEmitter
  /** Max recursion depth for sub-cycles (default: 3) */
  maxDepth?: number
  onStepStart?: (step: PipelineStep, index: number) => void
  onStepComplete?: (step: PipelineStep, result: PipelineStepResult, index: number) => void
}

/**
 * Execute a full pipeline -- runs steps sequentially, evaluates conditions,
 * handles branching, and passes accumulated knowledge between cycles.
 */
export async function runPipeline(config: PipelineRunnerConfig): Promise<PipelineResult> {
  const { db, router, projectId, pipeline, cycleRegistry, context } = config
  const emitter = config.emitter ?? getGlobalEmitter()
  const maxDepth = config.maxDepth ?? 3

  if (maxDepth <= 0) {
    return {
      success: false,
      stepsCompleted: 0,
      totalSteps: pipeline.steps.length,
      totalCost: 0,
      stepResults: [],
      error: "Maximum pipeline recursion depth exceeded",
    }
  }

  // Create pipeline run record in DB
  const pipelineRunId = crypto.randomUUID().slice(0, 16)
  createPipelineRun(db, {
    id: pipelineRunId,
    project_id: projectId,
    pipeline_id: pipeline.id,
    config: { context, mode: config.mode },
  })

  const stepResults: PipelineStepResult[] = []
  let totalCost = 0
  let stepsCompleted = 0

  // Build step index for branching
  const stepIndex = new Map<string, number>()
  for (let i = 0; i < pipeline.steps.length; i++) {
    stepIndex.set(pipeline.steps[i]!.id, i)
  }

  let i = 0
  while (i < pipeline.steps.length) {
    const step = pipeline.steps[i]!

    // Update pipeline run state
    updatePipelineRun(db, pipelineRunId, {
      current_step: step.id,
    })

    config.onStepStart?.(step, i)

    // Evaluate condition if present
    if (step.condition) {
      const conditionMet = evaluateCondition(db, step.condition, projectId, stepResults, context.domain)

      if (!conditionMet) {
        switch (step.condition.onFail) {
          case "skip": {
            const skippedResult: PipelineStepResult = {
              stepId: step.id,
              cycleId: step.cycleId,
              success: true,
              cost: 0,
              skipped: true,
            }
            stepResults.push(skippedResult)
            config.onStepComplete?.(step, skippedResult, i)
            i++
            continue
          }

          case "branch": {
            if (step.condition.branchTo) {
              const branchIdx = stepIndex.get(step.condition.branchTo)
              if (branchIdx !== undefined) {
                i = branchIdx
                continue
              }
            }
            // If branchTo target not found, skip this step
            const skippedResult: PipelineStepResult = {
              stepId: step.id,
              cycleId: step.cycleId,
              success: true,
              cost: 0,
              skipped: true,
            }
            stepResults.push(skippedResult)
            config.onStepComplete?.(step, skippedResult, i)
            i++
            continue
          }

          case "stop": {
            const stoppedResult: PipelineStepResult = {
              stepId: step.id,
              cycleId: step.cycleId,
              success: false,
              cost: 0,
              skipped: true,
            }
            stepResults.push(stoppedResult)
            config.onStepComplete?.(step, stoppedResult, i)

            updatePipelineRun(db, pipelineRunId, {
              status: "stopped",
              steps_completed: stepsCompleted,
              cost_total: totalCost,
            })

            return {
              success: false,
              stepsCompleted,
              totalSteps: pipeline.steps.length,
              totalCost,
              stepResults,
              error: `Pipeline stopped: condition not met at step "${step.id}"`,
            }
          }
        }
      }
    }

    // Resolve the cycle definition
    const cycleDef = cycleRegistry.get(step.cycleId)
    if (!cycleDef) {
      const errorResult: PipelineStepResult = {
        stepId: step.id,
        cycleId: step.cycleId,
        success: false,
        cost: 0,
        skipped: false,
      }
      stepResults.push(errorResult)
      config.onStepComplete?.(step, errorResult, i)

      updatePipelineRun(db, pipelineRunId, {
        status: "failed",
        steps_completed: stepsCompleted,
        cost_total: totalCost,
      })

      return {
        success: false,
        stepsCompleted,
        totalSteps: pipeline.steps.length,
        totalCost,
        stepResults,
        error: `Cycle "${step.cycleId}" not found in registry`,
      }
    }

    // Gather accumulated knowledge from previous steps to pass forward
    const previousKnowledge = gatherKnowledgeContext(db, projectId, context.domain)

    // Create a workspace for this cycle step
    const workspaceId = createWorkspace(db, {
      project_id: projectId,
      cycle_id: step.cycleId,
      config: {
        pipeline_run_id: pipelineRunId,
        pipeline_step: step.id,
        ...step.overrides,
      },
    })

    // Run the cycle
    try {
      const cycleResult = await runCycle({
        db,
        router,
        workspaceId,
        projectId,
        cycle: cycleDef,
        context: {
          ...context,
          previousKnowledge: previousKnowledge || undefined,
        },
        mode: config.mode,
        sandboxRouter: config.sandboxRouter,
        sandboxHints: config.sandboxHints,
        evaluationCommand: step.overrides?.evaluationCommand ?? config.evaluationCommand,
        emitter,
      })

      const stepResult: PipelineStepResult = {
        stepId: step.id,
        cycleId: step.cycleId,
        success: cycleResult.success,
        cost: cycleResult.totalCost,
        skipped: false,
        cycleResult,
      }

      stepResults.push(stepResult)
      totalCost += cycleResult.totalCost
      if (cycleResult.success) {
        stepsCompleted++
      }

      updatePipelineRun(db, pipelineRunId, {
        steps_completed: stepsCompleted,
        cost_total: totalCost,
      })

      config.onStepComplete?.(step, stepResult, i)

      // If the cycle failed, stop the pipeline
      if (!cycleResult.success) {
        updatePipelineRun(db, pipelineRunId, {
          status: "failed",
          steps_completed: stepsCompleted,
          cost_total: totalCost,
        })

        return {
          success: false,
          stepsCompleted,
          totalSteps: pipeline.steps.length,
          totalCost,
          stepResults,
          error: `Cycle "${step.cycleId}" failed at step "${step.id}": ${cycleResult.error}`,
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const stepResult: PipelineStepResult = {
        stepId: step.id,
        cycleId: step.cycleId,
        success: false,
        cost: 0,
        skipped: false,
      }
      stepResults.push(stepResult)
      config.onStepComplete?.(step, stepResult, i)

      updatePipelineRun(db, pipelineRunId, {
        status: "failed",
        steps_completed: stepsCompleted,
        cost_total: totalCost,
      })

      return {
        success: false,
        stepsCompleted,
        totalSteps: pipeline.steps.length,
        totalCost,
        stepResults,
        error: `Step "${step.id}" threw: ${error.message}`,
      }
    }

    i++
  }

  // Pipeline completed successfully
  updatePipelineRun(db, pipelineRunId, {
    status: "completed",
    steps_completed: stepsCompleted,
    cost_total: totalCost,
  })

  return {
    success: true,
    stepsCompleted,
    totalSteps: pipeline.steps.length,
    totalCost,
    stepResults,
  }
}

/**
 * Evaluate a pipeline condition against the current state.
 */
export function evaluateCondition(
  db: Database,
  condition: PipelineCondition,
  projectId: string,
  previousResults: PipelineStepResult[],
  domain: string,
): boolean {
  switch (condition.type) {
    case "always":
      return true

    case "confidence_threshold": {
      const threshold = condition.threshold ?? 0.5
      const knowledge = queryKnowledge(db, { project_id: projectId, domain })
      if (knowledge.length === 0) return false
      const avgConfidence = knowledge.reduce((sum, k) => sum + k.confidence, 0) / knowledge.length
      // Condition is met if confidence is BELOW threshold (meaning: we need more work)
      // Wait -- the semantics: condition gating means "should this step run?"
      // confidence_threshold: run this step if avg confidence < threshold (needs more research)
      // So condition is NOT met (skip/branch/stop) when confidence >= threshold
      return avgConfidence < threshold
    }

    case "knowledge_gap": {
      // Knowledge gap: run if there are few knowledge entries
      const knowledge = queryKnowledge(db, { project_id: projectId, domain })
      const threshold = condition.threshold ?? 0.5
      // Treat threshold as minimum number of knowledge entries (scaled to 0-1 by dividing by 10)
      const minEntries = Math.ceil(threshold * 10)
      return knowledge.length < minEntries
    }

    case "experiment_success_rate": {
      const threshold = condition.threshold ?? 0.5
      const completedResults = previousResults.filter((r) => !r.skipped && r.cycleResult)
      if (completedResults.length === 0) return false
      const successCount = completedResults.filter((r) => r.success).length
      const rate = successCount / completedResults.length
      return rate >= threshold
    }

    case "custom": {
      // Simple expression evaluation for custom conditions
      // Supports: "step.X.success", "step.X.cost < N", "knowledge.count > N"
      if (!condition.expression) return true
      try {
        return evaluateCustomExpression(condition.expression, db, projectId, previousResults, domain)
      } catch {
        return false
      }
    }

    default:
      return true
  }
}

/**
 * Evaluate a simple custom expression against pipeline state.
 */
function evaluateCustomExpression(
  expression: string,
  db: Database,
  projectId: string,
  previousResults: PipelineStepResult[],
  domain: string,
): boolean {
  // Support a few simple patterns:
  // "knowledge.count > N" -- number of knowledge entries
  // "cost.total < N" -- total cost across previous steps
  // "steps.success > N" -- number of successful steps

  const knowledgeCountMatch = expression.match(/knowledge\.count\s*(>|<|>=|<=|==)\s*(\d+)/)
  if (knowledgeCountMatch) {
    const knowledge = queryKnowledge(db, { project_id: projectId, domain })
    const count = knowledge.length
    const op = knowledgeCountMatch[1]!
    const value = parseInt(knowledgeCountMatch[2]!, 10)
    return compareValues(count, op, value)
  }

  const costMatch = expression.match(/cost\.total\s*(>|<|>=|<=|==)\s*([\d.]+)/)
  if (costMatch) {
    const totalCost = previousResults.reduce((sum, r) => sum + r.cost, 0)
    const op = costMatch[1]!
    const value = parseFloat(costMatch[2]!)
    return compareValues(totalCost, op, value)
  }

  const stepsMatch = expression.match(/steps\.success\s*(>|<|>=|<=|==)\s*(\d+)/)
  if (stepsMatch) {
    const successCount = previousResults.filter((r) => r.success && !r.skipped).length
    const op = stepsMatch[1]!
    const value = parseInt(stepsMatch[2]!, 10)
    return compareValues(successCount, op, value)
  }

  // Default: return true for unrecognized expressions
  return true
}

function compareValues(left: number, op: string, right: number): boolean {
  switch (op) {
    case ">": return left > right
    case "<": return left < right
    case ">=": return left >= right
    case "<=": return left <= right
    case "==": return left === right
    default: return false
  }
}

/**
 * Gather knowledge context from the database for passing between pipeline steps.
 */
function gatherKnowledgeContext(db: Database, projectId: string, domain: string): string {
  const knowledge = queryKnowledge(db, { project_id: projectId, domain })
  if (knowledge.length === 0) return ""

  let ctx = "## Accumulated Knowledge from Previous Steps\n\n"
  for (const entry of knowledge.sort((a, b) => b.confidence - a.confidence).slice(0, 20)) {
    ctx += `- [${(entry.confidence * 100).toFixed(0)}%] ${entry.insight}\n`
  }
  return ctx
}
