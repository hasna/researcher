/**
 * Agentic phase runners — each phase is a mini-agent with tools and a loop.
 *
 * Unlike the single-shot phase runner, these agents:
 * - Loop until they decide they're done
 * - Use tools to gather real information
 * - Can spawn child agents for parallel work
 * - Build up a scratchpad of reasoning
 */

import type { Database } from "bun:sqlite"
import type { ProviderRouter } from "../providers/router.ts"
import type { SandboxRouter } from "../sandbox/router.ts"
import type { SandboxInstance } from "../sandbox/base.ts"
import type { PhaseDefinition } from "../types.ts"
import { runAgent, runAgentsParallel, type AgentConfig, type AgentResult } from "./loop.ts"
import { problemTools, gatherTools, experimentTools, synthesizeTools } from "./tools.ts"
import { logModelCall } from "../db/index.ts"

export interface AgenticPhaseContext {
  db: Database
  router: ProviderRouter
  workspaceId: string
  projectId: string
  phase: PhaseDefinition
  accumulatedContext: string
  domain: string
  metricName: string
  metricDirection: "lower" | "higher"
  sandboxRouter?: SandboxRouter
  evaluationCommand?: string
  onAgentIteration?: (phase: string, iteration: number, thought: string) => void
}

export interface AgenticPhaseResult {
  phaseName: string
  success: boolean
  summary: string
  data: unknown
  cost: number
  iterations: number
  toolCalls: number
  childAgents: number
}

/**
 * Run a phase as an agentic loop.
 */
export async function runAgenticPhase(ctx: AgenticPhaseContext): Promise<AgenticPhaseResult> {
  switch (ctx.phase.type) {
    case "think":
      return runProblemAgent(ctx)
    case "gather":
      return runGatherAgent(ctx)
    case "parallel_experiment":
      return runExperimentAgent(ctx)
    case "synthesize":
      return runSynthesizeAgent(ctx)
    case "escalate":
      return runEscalateAgent(ctx)
    default:
      throw new Error(`Unknown phase type: ${ctx.phase.type}`)
  }
}

// ─── Problem Agent ───────────────────────────────────────────────────────────

async function runProblemAgent(ctx: AgenticPhaseContext): Promise<AgenticPhaseResult> {
  const result = await runAgent({
    name: `problem-agent`,
    systemPrompt: `You are a research problem analyst. Your job is to deeply understand the research problem before any experiments are run.

Context:
${ctx.accumulatedContext}

Your goal: ${ctx.phase.description}

You MUST:
1. Query past knowledge to see if this problem has been studied before
2. Query past experiments to see what's been tried
3. Formulate a clear, specific problem statement
4. Identify the key variables and constraints
5. When you have a thorough understanding, respond with DONE: followed by your analysis

Do NOT just restate the context. Dig deeper. Ask what's really going on.`,
    tools: problemTools(ctx.db),
    router: ctx.router,
    providerHint: ctx.phase.provider_hint,
    maxIterations: 5,
    canSpawn: false,
    onIteration: (i, thought) => ctx.onAgentIteration?.("problem", i, thought),
  })

  return mapResult("problem", result)
}

// ─── Gather Agent ────────────────────────────────────────────────────────────

async function runGatherAgent(ctx: AgenticPhaseContext): Promise<AgenticPhaseResult> {
  const result = await runAgent({
    name: `gather-agent`,
    systemPrompt: `You are a research information gatherer. Your job is to collect all relevant information about the problem.

Context:
${ctx.accumulatedContext}

Your goal: ${ctx.phase.description}

You MUST:
1. Search the knowledge base for relevant past findings
2. Search past experiments for what's been tried
3. Search the web for related approaches (if web_search is available)
4. Note down key findings as you go
5. If you find gaps in your understanding, search again with different queries
6. When you have comprehensive coverage, respond with DONE: followed by your compiled findings

Be thorough. Don't stop after one search. Cross-reference. Look for contradictions.`,
    tools: gatherTools(ctx.db),
    router: ctx.router,
    providerHint: ctx.phase.provider_hint,
    maxIterations: 8,
    canSpawn: false,
    onIteration: (i, thought) => ctx.onAgentIteration?.("gather", i, thought),
  })

  return mapResult("gather", result)
}

// ─── Experiment Agent ────────────────────────────────────────────────────────

async function runExperimentAgent(ctx: AgenticPhaseContext): Promise<AgenticPhaseResult> {
  const numExperiments = ctx.phase.max_parallel

  // If we have a sandbox router, run real experiments with child agents
  if (ctx.sandboxRouter && ctx.evaluationCommand) {
    return runRealExperiments(ctx, numExperiments)
  }

  // Otherwise, run a thinking agent that proposes and analyzes experiments
  const result = await runAgent({
    name: `experiment-agent`,
    systemPrompt: `You are an experimental researcher. Your job is to design and reason about ${numExperiments} experiments.

Context:
${ctx.accumulatedContext}

Metric: ${ctx.metricName} (optimize: ${ctx.metricDirection})
Your goal: ${ctx.phase.description}

You MUST:
1. First query past experiments and knowledge to avoid repeating what's been tried
2. Design ${numExperiments} diverse experiments, each testing a different approach
3. For each experiment, reason about:
   - What specifically to change
   - Why it might work (or fail)
   - Expected impact on ${ctx.metricName}
4. Rank them by expected impact
5. When done, respond with DONE: followed by all experiments with rankings

Be creative. Don't just do obvious variations. Think about non-obvious approaches.`,
    tools: [...gatherTools(ctx.db)],
    router: ctx.router,
    providerHint: ctx.phase.provider_hint,
    maxIterations: 6,
    canSpawn: false,
    onIteration: (i, thought) => ctx.onAgentIteration?.("experiment", i, thought),
  })

  return mapResult("experiment", result)
}

/**
 * Run real experiments with sandboxes and child agents.
 * Each child agent gets its own sandbox and loops: modify → run → measure → decide.
 */
async function runRealExperiments(ctx: AgenticPhaseContext, count: number): Promise<AgenticPhaseResult> {
  // First, generate hypotheses with a planning agent
  const planResult = await runAgent({
    name: "experiment-planner",
    systemPrompt: `You are planning ${count} experiments. Based on the context, output EXACTLY ${count} experiment descriptions, one per line, prefixed with "EXP N: ". Each should be a specific, actionable change to test.

Context:
${ctx.accumulatedContext}

Metric: ${ctx.metricName} (${ctx.metricDirection})`,
    tools: [problemTools(ctx.db)[0]!], // just noteToSelf
    router: ctx.router,
    providerHint: ctx.phase.provider_hint,
    maxIterations: 2,
    canSpawn: false,
  })

  // Parse hypotheses
  const hypotheses = planResult.output
    .split("\n")
    .filter((line) => line.match(/^EXP\s*\d+/i))
    .map((line) => line.replace(/^EXP\s*\d+:\s*/i, "").trim())
    .slice(0, count)

  if (hypotheses.length === 0) {
    return {
      phaseName: "experiment",
      success: false,
      summary: "Failed to generate experiment hypotheses",
      data: planResult.output,
      cost: planResult.cost,
      iterations: planResult.iterations,
      toolCalls: 0,
      childAgents: 0,
    }
  }

  // Create child agent configs — each gets a sandbox
  const childConfigs: AgentConfig[] = []
  const sandboxes: SandboxInstance[] = []

  for (const hypothesis of hypotheses) {
    try {
      const sandbox = await ctx.sandboxRouter!.create(
        {},
        { workspaceId: ctx.workspaceId, hypothesis },
      )
      sandboxes.push(sandbox)

      childConfigs.push({
        name: `exp-${sandboxes.length}`,
        systemPrompt: `You are running a single experiment in a sandbox.

Hypothesis: ${hypothesis}
Evaluation command: ${ctx.evaluationCommand}
Metric: ${ctx.metricName} (${ctx.metricDirection})

Steps:
1. Read the current state of files in the sandbox
2. Make the specific change described in the hypothesis
3. Run the evaluation command
4. Parse the metric from the output
5. Report the metric value
6. Respond with DONE: and include the metric value and whether the change helped`,
        tools: experimentTools(ctx.db, sandbox, ctx.projectId, ctx.domain),
        router: ctx.router,
        providerHint: ctx.phase.provider_hint,
        maxIterations: 5,
        canSpawn: false,
        onIteration: (i, thought) => ctx.onAgentIteration?.(`exp-${sandboxes.length}`, i, thought),
      })
    } catch (err) {
      console.error(`Failed to create sandbox for: ${hypothesis}`, err)
    }
  }

  // Run all child agents in parallel
  const childResults = await runAgentsParallel(childConfigs)

  // Cleanup sandboxes
  for (const sandbox of sandboxes) {
    try {
      await ctx.sandboxRouter!.release(sandbox.id)
    } catch {}
  }

  // Compile results
  const totalCost = planResult.cost + childResults.reduce((sum, r) => sum + r.cost, 0)
  const successCount = childResults.filter((r) => r.success).length

  return {
    phaseName: "experiment",
    success: successCount > 0,
    summary: `Ran ${childResults.length} experiments (${successCount} succeeded). Results:\n${childResults.map((r, i) => `  ${i + 1}. [${r.success ? "OK" : "FAIL"}] ${hypotheses[i]}: ${r.output.slice(0, 200)}`).join("\n")}`,
    data: { hypotheses, results: childResults.map((r) => ({ success: r.success, output: r.output, cost: r.cost })) },
    cost: totalCost,
    iterations: planResult.iterations + childResults.reduce((sum, r) => sum + r.iterations, 0),
    toolCalls: childResults.reduce((sum, r) => sum + r.toolCalls.length, 0),
    childAgents: childResults.length,
  }
}

// ─── Synthesize Agent ────────────────────────────────────────────────────────

async function runSynthesizeAgent(ctx: AgenticPhaseContext): Promise<AgenticPhaseResult> {
  const result = await runAgent({
    name: `synthesize-agent`,
    systemPrompt: `You are a senior research synthesizer. Your job is to extract permanent knowledge from research findings.

Context (includes all previous phase outputs):
${ctx.accumulatedContext}

Your goal: ${ctx.phase.description}

You MUST:
1. Review all findings from previous phases
2. Query past knowledge to see how new findings relate to existing knowledge
3. Identify the KEY INSIGHT — the single most important finding
4. Assess your confidence (0-1) based on evidence strength
5. Save the knowledge using the save_knowledge tool
6. Then respond with DONE: followed by your synthesis

The knowledge you save will persist across experiments. Make it clear, specific, and actionable.`,
    tools: synthesizeTools(ctx.db, ctx.projectId, ctx.domain),
    router: ctx.router,
    providerHint: ctx.phase.provider_hint,
    maxIterations: 5,
    canSpawn: false,
    onIteration: (i, thought) => ctx.onAgentIteration?.("synthesize", i, thought),
  })

  return mapResult("synthesize", result)
}

// ─── Escalate Agent ──────────────────────────────────────────────────────────

async function runEscalateAgent(ctx: AgenticPhaseContext): Promise<AgenticPhaseResult> {
  const result = await runAgent({
    name: `escalate-agent`,
    systemPrompt: `You are a senior researcher refining earlier analysis with deeper reasoning.

Context (includes cheaper model's analysis):
${ctx.accumulatedContext}

Your goal: ${ctx.phase.description}

You MUST:
1. Read the previous analysis critically
2. Query knowledge base for additional context
3. Correct errors, add nuance, prioritize
4. Respond with DONE: followed by your refined analysis

You are a more capable model than the one that produced the initial analysis. Use that capability.`,
    tools: gatherTools(ctx.db),
    router: ctx.router,
    providerHint: ctx.phase.provider_hint,
    maxIterations: 4,
    canSpawn: false,
    onIteration: (i, thought) => ctx.onAgentIteration?.("escalate", i, thought),
  })

  return mapResult("escalate", result)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapResult(phaseName: string, result: AgentResult): AgenticPhaseResult {
  return {
    phaseName,
    success: result.success,
    summary: result.output,
    data: result.output,
    cost: result.cost,
    iterations: result.iterations,
    toolCalls: result.toolCalls.length,
    childAgents: result.childResults.length,
  }
}
