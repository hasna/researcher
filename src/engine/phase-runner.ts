/**
 * Phase runner — executes a single phase within a cycle.
 *
 * Each phase type has different behavior:
 * - think: Send context to LLM, get structured analysis
 * - gather: Use skills to collect information, summarize with cheap LLM
 * - parallel_experiment: Spawn N sandboxes, run experiments concurrently
 * - synthesize: Take results, use smart LLM to extract knowledge
 * - escalate: Re-process previous output with a better model
 */

import type { Database } from "bun:sqlite"
import type { PhaseDefinition } from "../types.ts"
import type { ProviderRouter } from "../providers/router.ts"
import type { SandboxRouter, ResolveHints } from "../sandbox/router.ts"
import { logModelCall } from "../db/index.ts"
import { saveKnowledge } from "./knowledge.ts"
import { runParallelExperiments, type ExperimentHypothesis } from "./parallel.ts"

export interface PhaseContext {
  db: Database
  router: ProviderRouter
  workspaceId: string
  projectId: string
  phase: PhaseDefinition
  accumulatedContext: string
  previousResults: PhaseResult[]
  /** Optional sandbox router — required for parallel_experiment phases to actually execute */
  sandboxRouter?: SandboxRouter
  /** Hints for sandbox creation */
  sandboxHints?: ResolveHints
  /** Command to run for evaluation in sandboxes */
  evaluationCommand?: string
  /** Primary metric name */
  metricName?: string
  /** Metric direction */
  metricDirection?: "lower" | "higher"
  /** Project domain */
  projectDomain?: string
}

export interface PhaseResult {
  phaseName: string
  success: boolean
  summary: string
  data: unknown
  cost: number
  provider: string
  model: string
  experiments?: ExperimentSummary[]
}

export interface ExperimentSummary {
  sandboxId: string
  hypothesis: string
  metrics: Record<string, number>
  decision: "keep" | "discard" | "crash"
}

/**
 * Execute a single phase based on its type.
 */
export async function runPhase(ctx: PhaseContext): Promise<PhaseResult> {
  switch (ctx.phase.type) {
    case "think":
      return runThinkPhase(ctx)
    case "gather":
      return runGatherPhase(ctx)
    case "parallel_experiment":
      return runParallelExperimentPhase(ctx)
    case "synthesize":
      return runSynthesizePhase(ctx)
    case "escalate":
      return runEscalatePhase(ctx)
    default:
      throw new Error(`Unknown phase type: ${ctx.phase.type}`)
  }
}

// ─── Think phase ─────────────────────────────────────────────────────────────

async function runThinkPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const prompt = `You are a research analyst. Analyze the following context and provide a clear, structured analysis.

${ctx.accumulatedContext}

Phase goal: ${ctx.phase.description}
Expected output: ${ctx.phase.output}

Provide your analysis in a structured format. Be specific and actionable.`

  const result = await ctx.router.generate(prompt, ctx.phase.provider_hint, {
    system: "You are an expert researcher. Provide clear, concise, structured analysis.",
  })

  logModelCall(ctx.db, {
    workspace_id: ctx.workspaceId,
    provider: result.provider_name,
    model: result.model,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    cost: result.cost,
    latency_ms: result.latency_ms,
    phase: ctx.phase.name,
  })

  return {
    phaseName: ctx.phase.name,
    success: true,
    summary: result.content,
    data: result.content,
    cost: result.cost,
    provider: result.provider_name,
    model: result.model,
  }
}

// ─── Gather phase ────────────────────────────────────────────────────────────

async function runGatherPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const prompt = `You are a research assistant gathering information.

${ctx.accumulatedContext}

Phase goal: ${ctx.phase.description}
Skills available: ${ctx.phase.skills.join(", ") || "none"}
Expected output: ${ctx.phase.output}

Gather and organize all relevant information. Include:
- Related prior work and approaches
- Key data points and metrics
- Constraints and considerations
- Potential directions to explore`

  const result = await ctx.router.generate(prompt, ctx.phase.provider_hint, {
    system: "You are a thorough research assistant. Gather comprehensive information.",
  })

  logModelCall(ctx.db, {
    workspace_id: ctx.workspaceId,
    provider: result.provider_name,
    model: result.model,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    cost: result.cost,
    latency_ms: result.latency_ms,
    phase: ctx.phase.name,
  })

  return {
    phaseName: ctx.phase.name,
    success: true,
    summary: result.content,
    data: result.content,
    cost: result.cost,
    provider: result.provider_name,
    model: result.model,
  }
}

// ─── Parallel experiment phase ───────────────────────────────────────────────

async function runParallelExperimentPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const numExperiments = ctx.phase.max_parallel

  // Step 1: Generate experiment hypotheses via LLM
  const prompt = `Based on the research context below, propose exactly ${numExperiments} distinct experiment hypotheses.

${ctx.accumulatedContext}

For each experiment, provide:
1. A short hypothesis (one sentence)
2. What specific change to make — provide the EXACT file content or code change
3. Why this might work

Format EACH experiment EXACTLY as:
EXPERIMENT N:
Hypothesis: <one sentence>
File: <filename to create/modify>
Content: <exact file content>
Rationale: <why this might work>`

  const result = await ctx.router.generate(prompt, ctx.phase.provider_hint, {
    system: `You are an experimental researcher. Propose ${numExperiments} diverse, creative experiments. Each should test a different approach. For each experiment, provide exact file contents that can be written to a sandbox.`,
    max_tokens: 8192,
  })

  logModelCall(ctx.db, {
    workspace_id: ctx.workspaceId,
    provider: result.provider_name,
    model: result.model,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    cost: result.cost,
    latency_ms: result.latency_ms,
    phase: ctx.phase.name,
  })

  // Step 2: Parse hypotheses from LLM output
  const hypotheses = parseHypotheses(result.content)

  // Step 3: If we have a sandbox router and evaluation command, actually run experiments
  if (ctx.sandboxRouter && ctx.evaluationCommand && hypotheses.length > 0) {
    const parallelResult = await runParallelExperiments({
      db: ctx.db,
      router: ctx.router,
      sandboxRouter: ctx.sandboxRouter,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      hypotheses,
      sandboxHints: ctx.sandboxHints ?? {},
      evaluationCommand: ctx.evaluationCommand,
      metricName: ctx.metricName ?? "score",
      metricDirection: ctx.metricDirection ?? "higher",
      timeout: 300_000,
    })

    const experimentSummaries: ExperimentSummary[] = parallelResult.results.map((r) => ({
      sandboxId: r.sandboxId,
      hypothesis: r.hypothesis,
      metrics: r.metrics,
      decision: r.decision,
    }))

    const winnerSummary = parallelResult.winner
      ? `Winner: "${parallelResult.winner.hypothesis}" with ${JSON.stringify(parallelResult.winner.metrics)}`
      : "No winner found"

    return {
      phaseName: ctx.phase.name,
      success: true,
      summary: `Ran ${parallelResult.total} experiments: ${parallelResult.completed} completed, ${parallelResult.crashed} crashed. ${winnerSummary}`,
      data: {
        hypotheses: result.content,
        results: parallelResult.results,
        winner: parallelResult.winner,
      },
      cost: result.cost,
      provider: result.provider_name,
      model: result.model,
      experiments: experimentSummaries,
    }
  }

  // Fallback: no sandbox router — just return hypotheses (LLM-only mode)
  return {
    phaseName: ctx.phase.name,
    success: true,
    summary: `Generated ${hypotheses.length} experiment hypotheses (no sandbox configured — LLM-only mode)`,
    data: result.content,
    cost: result.cost,
    provider: result.provider_name,
    model: result.model,
    experiments: [],
  }
}

/**
 * Parse experiment hypotheses from LLM output into structured format.
 */
function parseHypotheses(output: string): ExperimentHypothesis[] {
  const experiments: ExperimentHypothesis[] = []
  // Split by EXPERIMENT N: pattern
  const blocks = output.split(/EXPERIMENT\s+\d+\s*:/i).filter((b) => b.trim())

  for (const block of blocks) {
    const hypothesisMatch = block.match(/Hypothesis:\s*(.+)/i)
    const fileMatch = block.match(/File:\s*(.+)/i)
    const contentMatch = block.match(/Content:\s*([\s\S]*?)(?=Rationale:|EXPERIMENT|\s*$)/i)

    const description = hypothesisMatch?.[1]?.trim()
    const fileName = fileMatch?.[1]?.trim() ?? "experiment.txt"
    const content = contentMatch?.[1]?.trim() ?? ""

    if (description) {
      experiments.push({
        description,
        changes: content
          ? [{ path: fileName, content }]
          : [],
      })
    }
  }

  return experiments
}

// ─── Synthesize phase ────────────────────────────────────────────────────────

async function runSynthesizePhase(ctx: PhaseContext): Promise<PhaseResult> {
  const prompt = `You are synthesizing research results into permanent knowledge.

${ctx.accumulatedContext}

Phase goal: ${ctx.phase.description}
Expected output: ${ctx.phase.output}

Synthesize the results into:
1. KEY INSIGHT: One clear, actionable insight
2. EVIDENCE: What experiments/data support this
3. CONFIDENCE: How confident are you (0-1 scale with reasoning)
4. NEXT STEPS: What should be explored next
5. KNOWLEDGE: A single sentence that codifies what was learned (this becomes permanent knowledge)`

  const result = await ctx.router.generate(prompt, ctx.phase.provider_hint, {
    system: "You are a senior researcher synthesizing findings into permanent, reusable knowledge.",
  })

  logModelCall(ctx.db, {
    workspace_id: ctx.workspaceId,
    provider: result.provider_name,
    model: result.model,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    cost: result.cost,
    latency_ms: result.latency_ms,
    phase: ctx.phase.name,
  })

  // Auto-save knowledge from synthesize output
  try {
    const insightMatch = result.content.match(/KEY INSIGHT[:\s]*\n?\s*\**(.+?)(?:\*\*|\n\n)/is)
      ?? result.content.match(/KNOWLEDGE:\s*(.+)/i)
    const insight = insightMatch?.[1]?.replace(/\*\*/g, "").trim() ?? result.content.slice(0, 500)
    const confidenceMatch = result.content.match(/CONFIDENCE[:\s]*\**\s*(0?\.\d+|\d\.\d+)/i)
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]!) : 0.5

    saveKnowledge(ctx.db, {
      project_id: ctx.projectId,
      domain: ctx.projectDomain ?? "general",
      insight,
      confidence: Math.min(1, Math.max(0, confidence)),
      tags: ["auto-generated", ctx.phase.name],
    })
  } catch {
    // Non-critical — don't fail the phase if knowledge save fails
  }

  return {
    phaseName: ctx.phase.name,
    success: true,
    summary: result.content,
    data: result.content,
    cost: result.cost,
    provider: result.provider_name,
    model: result.model,
  }
}

// ─── Escalate phase ──────────────────────────────────────────────────────────

async function runEscalatePhase(ctx: PhaseContext): Promise<PhaseResult> {
  const lastResult = ctx.previousResults[ctx.previousResults.length - 1]
  const previousOutput = lastResult
    ? typeof lastResult.data === "string"
      ? lastResult.data
      : JSON.stringify(lastResult.data)
    : ""

  const prompt = `You are a senior researcher refining and improving earlier analysis.

## Original Analysis (from a faster/cheaper model):
${previousOutput}

## Full Context:
${ctx.accumulatedContext}

Phase goal: ${ctx.phase.description}
Expected output: ${ctx.phase.output}

Refine the original analysis:
- Correct any errors or oversights
- Add depth and nuance
- Prioritize the most promising directions
- Remove noise and focus on what matters`

  const result = await ctx.router.generate(prompt, ctx.phase.provider_hint, {
    system: "You are a senior researcher. Refine and elevate the quality of the analysis.",
  })

  logModelCall(ctx.db, {
    workspace_id: ctx.workspaceId,
    provider: result.provider_name,
    model: result.model,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    cost: result.cost,
    latency_ms: result.latency_ms,
    phase: ctx.phase.name,
  })

  return {
    phaseName: ctx.phase.name,
    success: true,
    summary: result.content,
    data: result.content,
    cost: result.cost,
    provider: result.provider_name,
    model: result.model,
  }
}

export { parseHypotheses }
