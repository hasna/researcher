/**
 * Parallel experiment runner — manages concurrent experiments during LOOPHOLE/EXPERIMENT phases.
 *
 * Flow:
 * 1. Call LLM to generate N experiment hypotheses
 * 2. Create N sandboxes via sandbox router
 * 3. Run all experiments concurrently (Promise.allSettled)
 * 4. Collect results, rank by metric
 * 5. Return all results with winner highlighted
 */

import type { Database } from "bun:sqlite"
import type { ProviderRouter } from "../providers/router.ts"
import type { SandboxRouter, ResolveHints } from "../sandbox/router.ts"
import type { SandboxInstance } from "../sandbox/base.ts"
import { createSandbox, updateSandboxStatus, createResult } from "../db/index.ts"

export interface ParallelRunConfig {
  db: Database
  router: ProviderRouter
  sandboxRouter: SandboxRouter
  workspaceId: string
  projectId: string
  hypotheses: ExperimentHypothesis[]
  sandboxHints: ResolveHints
  evaluationCommand: string
  metricName: string
  metricDirection: "lower" | "higher"
  timeout?: number // per-experiment timeout in ms
}

export interface ExperimentHypothesis {
  description: string
  changes: { path: string; content: string }[]
}

export interface ParallelRunResult {
  total: number
  completed: number
  crashed: number
  results: ExperimentOutcome[]
  winner: ExperimentOutcome | null
}

export interface ExperimentOutcome {
  sandboxId: string
  hypothesis: string
  metrics: Record<string, number>
  decision: "keep" | "discard" | "crash"
  diff: string
  error?: string
}

/**
 * Run multiple experiments in parallel across isolated sandboxes.
 */
export async function runParallelExperiments(config: ParallelRunConfig): Promise<ParallelRunResult> {
  const {
    db,
    sandboxRouter,
    workspaceId,
    hypotheses,
    sandboxHints,
    evaluationCommand,
    metricName,
    metricDirection,
    timeout = 300_000,
  } = config

  // Create sandboxes for each hypothesis
  const experiments: { sandbox: SandboxInstance; hypothesis: ExperimentHypothesis; dbSandboxId: string }[] = []

  for (const hypothesis of hypotheses) {
    try {
      const sandbox = await sandboxRouter.create(sandboxHints, {
        workspaceId,
        hypothesis: hypothesis.description,
        files: hypothesis.changes,
      })

      const dbSandboxId = createSandbox(db, {
        workspace_id: workspaceId,
        type: sandbox.type,
        hypothesis: hypothesis.description,
        path: sandbox.path ?? undefined,
      })

      updateSandboxStatus(db, dbSandboxId, "running")
      experiments.push({ sandbox, hypothesis, dbSandboxId })
    } catch (err) {
      console.error(`Failed to create sandbox for hypothesis: ${hypothesis.description}`, err)
    }
  }

  // Run all experiments concurrently
  const outcomes = await Promise.allSettled(
    experiments.map(async ({ sandbox, hypothesis, dbSandboxId }) => {
      try {
        // Apply changes
        for (const change of hypothesis.changes) {
          await sandbox.writeFile(change.path, change.content)
        }

        // Run evaluation
        const evalResult = await sandbox.execute(evaluationCommand, { timeout })

        if (evalResult.exitCode !== 0) {
          updateSandboxStatus(db, dbSandboxId, "failed")
          const outcome: ExperimentOutcome = {
            sandboxId: dbSandboxId,
            hypothesis: hypothesis.description,
            metrics: {},
            decision: "crash",
            diff: await sandbox.getDiff(),
            error: evalResult.stderr,
          }
          createResult(db, {
            sandbox_id: dbSandboxId,
            workspace_id: workspaceId,
            metrics: {},
            decision: "crash",
            diff: outcome.diff ?? undefined,
            reasoning: evalResult.stderr,
          })
          return outcome
        }

        // Parse metrics from output
        const metrics = parseMetrics(evalResult.stdout, metricName)
        const diff = await sandbox.getDiff()

        updateSandboxStatus(db, dbSandboxId, "completed")
        const outcome: ExperimentOutcome = {
          sandboxId: dbSandboxId,
          hypothesis: hypothesis.description,
          metrics,
          decision: "discard", // Will be updated after ranking
          diff,
        }

        createResult(db, {
          sandbox_id: dbSandboxId,
          workspace_id: workspaceId,
          metrics,
          decision: "discard",
          diff,
        })

        return outcome
      } catch (err) {
        updateSandboxStatus(db, dbSandboxId, "failed")
        return {
          sandboxId: dbSandboxId,
          hypothesis: hypothesis.description,
          metrics: {} as Record<string, number>,
          decision: "crash" as const,
          diff: "",
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  // Collect results
  const results: ExperimentOutcome[] = outcomes.map((o) =>
    o.status === "fulfilled" ? o.value : {
      sandboxId: "",
      hypothesis: "unknown",
      metrics: {},
      decision: "crash" as const,
      diff: "",
      error: o.reason?.message ?? "Unknown error",
    },
  )

  // Find the winner
  const successfulResults = results.filter(
    (r) => r.decision !== "crash" && r.metrics[metricName] !== undefined,
  )

  let winner: ExperimentOutcome | null = null
  if (successfulResults.length > 0) {
    successfulResults.sort((a, b) => {
      const aVal = a.metrics[metricName] ?? 0
      const bVal = b.metrics[metricName] ?? 0
      return metricDirection === "lower" ? aVal - bVal : bVal - aVal
    })
    winner = successfulResults[0]!
    winner.decision = "keep"
  }

  // Cleanup all sandboxes
  for (const { sandbox } of experiments) {
    try {
      await sandboxRouter.release(sandbox.id)
    } catch {
      // Best effort cleanup
    }
  }

  return {
    total: hypotheses.length,
    completed: results.filter((r) => r.decision !== "crash").length,
    crashed: results.filter((r) => r.decision === "crash").length,
    results,
    winner,
  }
}

/**
 * Parse metrics from command output.
 * Looks for lines like "metric_name: value" or "metric_name=value".
 */
function parseMetrics(output: string, primaryMetric: string): Record<string, number> {
  const metrics: Record<string, number> = {}
  const lines = output.split("\n")

  for (const line of lines) {
    // Match "key: value" or "key=value" patterns
    const match = line.match(/^(\w+)[:\s=]+\s*([\d.eE+-]+)/)
    if (match) {
      const [, key, value] = match
      const num = parseFloat(value!)
      if (!isNaN(num) && key) {
        metrics[key] = num
      }
    }
  }

  return metrics
}

export { parseMetrics }
