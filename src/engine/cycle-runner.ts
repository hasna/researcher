/**
 * Cycle runner — executes any cycle definition phase by phase.
 *
 * The core orchestrator: reads a CycleDefinition, iterates through phases,
 * delegates to the phase runner, tracks progress in the database.
 *
 * Default mode is "agentic" — each phase runs as a mini-agent with tools
 * and a loop (think → act → observe → decide). Use mode: "simple" to fall
 * back to single LLM call per phase.
 */

import type { Database } from "bun:sqlite"
import type { CycleDefinition, PhaseDefinition } from "../types.ts"
import type { ProviderRouter } from "../providers/router.ts"
import type { SandboxRouter, ResolveHints } from "../sandbox/router.ts"
import { updateWorkspacePhase, updateWorkspaceStatus, addWorkspaceCost } from "../db/index.ts"
import { runPhase, type PhaseContext, type PhaseResult } from "./phase-runner.ts"
import { runAgenticPhase, type AgenticPhaseContext, type AgenticPhaseResult } from "../agent/phases.ts"
import { type ResearchEventEmitter, getGlobalEmitter } from "./events.ts"

export type CycleMode = "agentic" | "simple"

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
  /**
   * Execution mode: "agentic" (default) uses tool-calling agent loops per phase.
   * "simple" uses single LLM call per phase (faster, cheaper, less capable).
   */
  mode?: CycleMode
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
  /** Called after each agentic iteration (agentic mode only) */
  onAgentIteration?: (phase: string, iteration: number, thought: string) => void
  /** Event emitter for real-time progress. Uses global emitter if not provided. */
  emitter?: ResearchEventEmitter
}

export interface CycleResult {
  success: boolean
  phases: PhaseResult[]
  totalCost: number
  error?: string
}

/**
 * Execute a full cycle — runs each phase sequentially, passing outputs forward.
 *
 * Default mode is "agentic": each phase runs as a mini-agent with tools and
 * iterative loops. Use mode: "simple" for single LLM calls (faster/cheaper).
 */
export async function runCycle(config: CycleRunnerConfig): Promise<CycleResult> {
  const { db, router, workspaceId, cycle, context } = config
  const mode = config.mode ?? "agentic"
  const emitter = config.emitter ?? getGlobalEmitter()
  const ev = emitter.forWorkspace(workspaceId)
  const phaseResults: PhaseResult[] = []
  let totalCost = 0
  let accumulatedContext = buildInitialContext(context)

  ev.cycleStart(cycle.id, cycle.name, cycle.phases.length, mode)

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
    ev.phaseStart(phase.name, phase.type, i, cycle.phases.length, phase.provider_hint)
    const phaseStartTime = Date.now()

    try {
      let result: PhaseResult

      if (mode === "agentic") {
        // Agentic mode: each phase is a mini-agent with tools and loop
        const agenticCtx: AgenticPhaseContext = {
          db,
          router,
          workspaceId,
          projectId: config.projectId,
          phase,
          accumulatedContext,
          domain: context.domain,
          metricName: context.metricName,
          metricDirection: context.metricDirection as "lower" | "higher",
          sandboxRouter: config.sandboxRouter,
          evaluationCommand: config.evaluationCommand,
          onAgentIteration: config.onAgentIteration,
        }
        const agenticResult = await runAgenticPhase(agenticCtx)
        result = mapAgenticResult(agenticResult)
      } else {
        // Simple mode: single LLM call per phase
        const phaseContext: PhaseContext = {
          db,
          router,
          workspaceId,
          projectId: config.projectId,
          phase,
          accumulatedContext,
          previousResults: phaseResults,
          sandboxRouter: config.sandboxRouter,
          sandboxHints: config.sandboxHints,
          evaluationCommand: config.evaluationCommand,
          metricName: context.metricName,
          metricDirection: context.metricDirection as "lower" | "higher",
          projectDomain: context.domain,
        }
        result = await runPhase(phaseContext)
      }

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

      ev.phaseComplete(phase.name, phase.type, result.success, result.cost, Date.now() - phaseStartTime, result.summary.slice(0, 500))
      ev.costUpdate(result.cost, totalCost, result.provider, result.model, 0, 0)
      config.onPhaseComplete?.(phase, result, i)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      ev.phaseError(phase.name, error.message)
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
      ev.cycleError(cycle.id, phase.name, error.message)
      return {
        success: false,
        phases: phaseResults,
        totalCost,
        error: `Phase "${phase.name}" failed: ${error.message}`,
      }
    }
  }

  updateWorkspaceStatus(db, workspaceId, "completed")
  ev.cycleComplete(cycle.id, true, totalCost, phaseResults.length)
  return {
    success: true,
    phases: phaseResults,
    totalCost,
  }
}

/**
 * Map an AgenticPhaseResult to the standard PhaseResult format.
 */
function mapAgenticResult(r: AgenticPhaseResult): PhaseResult {
  return {
    phaseName: r.phaseName,
    success: r.success,
    summary: r.summary,
    data: r.data,
    cost: r.cost,
    provider: "agentic",
    model: `${r.iterations}i/${r.toolCalls}t/${r.childAgents}c`,
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
