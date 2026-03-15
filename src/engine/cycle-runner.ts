/**
 * Cycle runner — executes any cycle definition phase by phase.
 *
 * The core orchestrator: reads a CycleDefinition, iterates through phases,
 * delegates to the phase runner, tracks progress in the database.
 */

import type { Database } from "bun:sqlite"
import type { CycleDefinition, PhaseDefinition } from "../types.ts"
import type { ProviderRouter } from "../providers/router.ts"
import type { SandboxRouter, ResolveHints } from "../sandbox/router.ts"
import { updateWorkspacePhase, updateWorkspaceStatus, addWorkspaceCost } from "../db/index.ts"
import { runPhase, type PhaseContext, type PhaseResult } from "./phase-runner.ts"

export interface CycleRunnerConfig {
  db: Database
  router: ProviderRouter
  workspaceId: string
  projectId: string
  cycle: CycleDefinition
  context: {
    projectName: string
    domain: string
    metricName: string
    metricDirection: string
    previousKnowledge?: string
    userGoal?: string
  }
  /** Optional sandbox router for running real experiments */
  sandboxRouter?: SandboxRouter
  /** Hints for sandbox creation (isGitRepo, repoPath, etc.) */
  sandboxHints?: ResolveHints
  /** Evaluation command to run in sandboxes */
  evaluationCommand?: string
  /** Resume from this phase index (skip earlier phases) */
  resumeFromPhase?: number
  onPhaseStart?: (phase: PhaseDefinition, index: number) => void
  onPhaseComplete?: (phase: PhaseDefinition, result: PhaseResult, index: number) => void
  onError?: (phase: PhaseDefinition, error: Error, index: number) => void
}

export interface CycleResult {
  success: boolean
  phases: PhaseResult[]
  totalCost: number
  error?: string
}

/**
 * Execute a full cycle — runs each phase sequentially, passing outputs forward.
 */
export async function runCycle(config: CycleRunnerConfig): Promise<CycleResult> {
  const { db, router, workspaceId, cycle, context } = config
  const phaseResults: PhaseResult[] = []
  let totalCost = 0
  let accumulatedContext = buildInitialContext(context)

  const startPhase = config.resumeFromPhase ?? 0
  if (startPhase > 0) {
    // Mark skipped phases
    for (let s = 0; s < startPhase && s < cycle.phases.length; s++) {
      phaseResults.push({
        phaseName: cycle.phases[s]!.name,
        success: true,
        summary: "(skipped — resumed)",
        data: null,
        cost: 0,
        provider: "",
        model: "",
      })
    }
  }

  for (let i = startPhase; i < cycle.phases.length; i++) {
    const phase = cycle.phases[i]!

    // Update workspace state
    updateWorkspacePhase(db, workspaceId, phase.name)
    config.onPhaseStart?.(phase, i)

    try {
      const phaseContext: PhaseContext = {
        db,
        router,
        workspaceId,
        projectId: config.projectId,
        phase,
        accumulatedContext,
        previousResults: phaseResults,
        // Sandbox context for experiment phases
        sandboxRouter: config.sandboxRouter,
        sandboxHints: config.sandboxHints,
        evaluationCommand: config.evaluationCommand,
        metricName: context.metricName,
        metricDirection: context.metricDirection as "lower" | "higher",
        projectDomain: context.domain,
      }

      const result = await runPhase(phaseContext)
      phaseResults.push(result)
      totalCost += result.cost

      // Track cost
      if (result.cost > 0) {
        addWorkspaceCost(db, workspaceId, result.cost)
      }

      // Accumulate context for next phase
      accumulatedContext += `\n\n## Phase: ${phase.name}\n${result.summary}`
      if (result.data) {
        accumulatedContext += `\nData: ${typeof result.data === "string" ? result.data : JSON.stringify(result.data)}`
      }

      config.onPhaseComplete?.(phase, result, i)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      config.onError?.(phase, error, i)

      phaseResults.push({
        phaseName: phase.name,
        success: false,
        summary: `Error: ${error.message}`,
        data: null,
        cost: 0,
        provider: "",
        model: "",
      })

      updateWorkspaceStatus(db, workspaceId, "failed")
      return {
        success: false,
        phases: phaseResults,
        totalCost,
        error: `Phase "${phase.name}" failed: ${error.message}`,
      }
    }
  }

  updateWorkspaceStatus(db, workspaceId, "completed")
  return {
    success: true,
    phases: phaseResults,
    totalCost,
  }
}

function buildInitialContext(ctx: CycleRunnerConfig["context"]): string {
  let s = `# Research Context\n`
  s += `Project: ${ctx.projectName}\n`
  s += `Domain: ${ctx.domain}\n`
  s += `Metric: ${ctx.metricName} (optimize: ${ctx.metricDirection})\n`
  if (ctx.userGoal) s += `Goal: ${ctx.userGoal}\n`
  if (ctx.previousKnowledge) s += `\n## Previous Knowledge\n${ctx.previousKnowledge}\n`
  return s
}
