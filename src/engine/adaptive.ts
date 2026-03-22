/**
 * Adaptive execution engine — dynamic parallelism, early stopping,
 * experiment lineage tracking, and resource-aware scheduling.
 *
 * Enhances the standard parallel runner with intelligent resource management:
 * - Dynamic parallelism: adjust experiment count based on result variance
 * - Early stopping: terminate when a clear winner emerges
 * - Experiment lineage: track parent-child relationships between experiments
 * - Resource-aware scheduling: balance cost vs quality
 */

import type { Database } from "bun:sqlite"
import type { ProviderRouter } from "../providers/router.ts"
import type { SandboxRouter, ResolveHints } from "../sandbox/router.ts"
import type { SandboxInstance } from "../sandbox/base.ts"
import { createSandbox, updateSandboxStatus, createResult } from "../db/index.ts"
import { parseMetrics, type ExperimentHypothesis, type ExperimentOutcome } from "./parallel.ts"

// ─── Experiment Lineage ─────────────────────────────────────────────────────

export interface ExperimentLineageEntry {
  id: string
  parentId: string | null
  workspaceId: string
  hypothesis: string
  metrics: Record<string, number>
  generation: number
  decision: "keep" | "discard" | "crash"
  createdAt: string
}

/** Ensure the experiment_lineage table exists */
export function ensureLineageTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS experiment_lineage (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES experiment_lineage(id),
      workspace_id TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      metrics TEXT DEFAULT '{}',
      generation INTEGER DEFAULT 0,
      decision TEXT DEFAULT 'discard' CHECK(decision IN ('keep','discard','crash')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_lineage_parent ON experiment_lineage(parent_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_lineage_workspace ON experiment_lineage(workspace_id)`)
}

/** Record an experiment in the lineage tree */
export function recordLineage(
  db: Database,
  entry: { id: string; parentId?: string; workspaceId: string; hypothesis: string; metrics: Record<string, number>; generation: number; decision: string },
): void {
  ensureLineageTable(db)
  db.run(
    `INSERT OR REPLACE INTO experiment_lineage (id, parent_id, workspace_id, hypothesis, metrics, generation, decision) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.parentId ?? null, entry.workspaceId, entry.hypothesis, JSON.stringify(entry.metrics), entry.generation, entry.decision],
  )
}

/** Get all descendants of an experiment */
export function getLineageDescendants(db: Database, experimentId: string): ExperimentLineageEntry[] {
  ensureLineageTable(db)
  const results: ExperimentLineageEntry[] = []
  const queue = [experimentId]

  while (queue.length > 0) {
    const parentId = queue.shift()!
    const children = db.query(
      `SELECT id, parent_id, workspace_id, hypothesis, metrics, generation, decision, created_at FROM experiment_lineage WHERE parent_id = ?`,
    ).all(parentId) as Array<{ id: string; parent_id: string | null; workspace_id: string; hypothesis: string; metrics: string; generation: number; decision: string; created_at: string }>

    for (const child of children) {
      const entry: ExperimentLineageEntry = {
        id: child.id,
        parentId: child.parent_id,
        workspaceId: child.workspace_id,
        hypothesis: child.hypothesis,
        metrics: JSON.parse(child.metrics),
        generation: child.generation,
        decision: child.decision as "keep" | "discard" | "crash",
        createdAt: child.created_at,
      }
      results.push(entry)
      queue.push(child.id)
    }
  }

  return results
}

/** Get the full ancestry chain for an experiment */
export function getLineageAncestors(db: Database, experimentId: string): ExperimentLineageEntry[] {
  ensureLineageTable(db)
  const ancestors: ExperimentLineageEntry[] = []
  let currentId: string | null = experimentId

  while (currentId) {
    const row = db.query(
      `SELECT id, parent_id, workspace_id, hypothesis, metrics, generation, decision, created_at FROM experiment_lineage WHERE id = ?`,
    ).get(currentId) as { id: string; parent_id: string | null; workspace_id: string; hypothesis: string; metrics: string; generation: number; decision: string; created_at: string } | null

    if (!row || row.id === experimentId) {
      currentId = row?.parent_id ?? null
      continue
    }

    ancestors.push({
      id: row.id,
      parentId: row.parent_id,
      workspaceId: row.workspace_id,
      hypothesis: row.hypothesis,
      metrics: JSON.parse(row.metrics),
      generation: row.generation,
      decision: row.decision as "keep" | "discard" | "crash",
      createdAt: row.created_at,
    })
    currentId = row.parent_id
  }

  return ancestors.reverse()
}

// ─── Dynamic Parallelism ────────────────────────────────────────────────────

export interface AdaptiveParallelConfig {
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
  timeout?: number
  /** Initial batch size (default: 3) */
  initialBatchSize?: number
  /** Max total experiments to run (default: max_parallel from phase) */
  maxExperiments?: number
  /** Variance threshold to trigger expansion (default: 0.3) */
  varianceThreshold?: number
  /** Enable early stopping (default: true) */
  earlyStopEnabled?: boolean
  /** Early stop ratio — stop if winner is N times better (default: 3.0) */
  earlyStopRatio?: number
  /** Parent experiment ID for lineage tracking */
  parentExperimentId?: string
  /** Generation number for lineage */
  generation?: number
}

export interface AdaptiveParallelResult {
  total: number
  completed: number
  crashed: number
  results: ExperimentOutcome[]
  winner: ExperimentOutcome | null
  batches: number
  earlyStopped: boolean
  varianceExpanded: boolean
}

/**
 * Run experiments with adaptive parallelism.
 *
 * Strategy:
 * 1. Run initial batch (default 3)
 * 2. If result variance is high → expand with more experiments
 * 3. If one experiment clearly dominates → early stop
 * 4. Track lineage for all experiments
 */
export async function runAdaptiveExperiments(config: AdaptiveParallelConfig): Promise<AdaptiveParallelResult> {
  const {
    db, sandboxRouter, workspaceId, hypotheses, sandboxHints,
    evaluationCommand, metricName, metricDirection,
    timeout = 300_000,
    initialBatchSize = 3,
    maxExperiments = hypotheses.length,
    varianceThreshold = 0.3,
    earlyStopEnabled = true,
    earlyStopRatio = 3.0,
    parentExperimentId,
    generation = 0,
  } = config

  ensureLineageTable(db)

  const allResults: ExperimentOutcome[] = []
  let batchCount = 0
  let earlyStopped = false
  let varianceExpanded = false
  let experimentIndex = 0

  // Run experiments in batches
  const batchSize = Math.min(initialBatchSize, hypotheses.length, maxExperiments)
  const firstBatch = hypotheses.slice(0, batchSize)
  experimentIndex = batchSize

  // Run first batch
  batchCount++
  const firstResults = await runBatch(
    db, sandboxRouter, workspaceId, firstBatch, sandboxHints,
    evaluationCommand, metricName, timeout, parentExperimentId, generation,
  )
  allResults.push(...firstResults)

  // Analyze first batch results
  const successMetrics = firstResults
    .filter(r => r.decision !== "crash" && r.metrics[metricName] !== undefined)
    .map(r => r.metrics[metricName]!)

  if (successMetrics.length >= 2 && experimentIndex < maxExperiments) {
    const variance = computeNormalizedVariance(successMetrics)

    // High variance → results are divergent, try more experiments
    if (variance > varianceThreshold) {
      varianceExpanded = true
      const expansionSize = Math.min(
        maxExperiments - experimentIndex,
        hypotheses.length - experimentIndex,
        initialBatchSize * 2, // double the batch
      )

      if (expansionSize > 0) {
        batchCount++
        const expansionBatch = hypotheses.slice(experimentIndex, experimentIndex + expansionSize)
        experimentIndex += expansionSize
        const expansionResults = await runBatch(
          db, sandboxRouter, workspaceId, expansionBatch, sandboxHints,
          evaluationCommand, metricName, timeout, parentExperimentId, generation,
        )
        allResults.push(...expansionResults)
      }
    }

    // Check for early stopping
    if (earlyStopEnabled) {
      const allSuccessMetrics = allResults
        .filter(r => r.decision !== "crash" && r.metrics[metricName] !== undefined)
        .map(r => ({ hypothesis: r.hypothesis, value: r.metrics[metricName]! }))
        .sort((a, b) => metricDirection === "lower" ? a.value - b.value : b.value - a.value)

      if (allSuccessMetrics.length >= 2) {
        const best = allSuccessMetrics[0]!.value
        const secondBest = allSuccessMetrics[1]!.value
        const ratio = metricDirection === "lower"
          ? (secondBest === 0 ? Infinity : best > 0 ? secondBest / best : 1)
          : (secondBest === 0 ? Infinity : best / secondBest)

        if (ratio >= earlyStopRatio) {
          earlyStopped = true
          // Skip remaining hypotheses — we have a clear winner
        }
      }
    }
  }

  // Continue with remaining if not early stopped
  if (!earlyStopped && experimentIndex < Math.min(hypotheses.length, maxExperiments)) {
    batchCount++
    const remainingBatch = hypotheses.slice(experimentIndex, maxExperiments)
    const remainingResults = await runBatch(
      db, sandboxRouter, workspaceId, remainingBatch, sandboxHints,
      evaluationCommand, metricName, timeout, parentExperimentId, generation,
    )
    allResults.push(...remainingResults)
  }

  // Find winner
  const successfulResults = allResults.filter(
    r => r.decision !== "crash" && r.metrics[metricName] !== undefined,
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

  return {
    total: allResults.length,
    completed: allResults.filter(r => r.decision !== "crash").length,
    crashed: allResults.filter(r => r.decision === "crash").length,
    results: allResults,
    winner,
    batches: batchCount,
    earlyStopped,
    varianceExpanded,
  }
}

// ─── Resource-Aware Scheduling ──────────────────────────────────────────────

export interface ResourceSchedule {
  sandboxType: "worktree" | "tempdir" | "e2b"
  maxParallel: number
  estimatedCostPerExperiment: number
}

/**
 * Determine optimal resource allocation based on budget and experiment count.
 */
export function planResourceSchedule(
  experimentCount: number,
  opts: {
    budgetRemaining: number
    hasGitRepo: boolean
    needsGpu: boolean
    untrustedCode: boolean
  },
): ResourceSchedule {
  // E2B for untrusted/GPU — expensive
  if (opts.needsGpu || opts.untrustedCode) {
    const maxParallel = Math.min(experimentCount, 2, Math.floor(opts.budgetRemaining / 0.10))
    return { sandboxType: "e2b", maxParallel: Math.max(1, maxParallel), estimatedCostPerExperiment: 0.10 }
  }

  // Worktree for git repos — free
  if (opts.hasGitRepo) {
    return { sandboxType: "worktree", maxParallel: Math.min(experimentCount, 20), estimatedCostPerExperiment: 0 }
  }

  // Tempdir — free
  return { sandboxType: "tempdir", maxParallel: Math.min(experimentCount, 20), estimatedCostPerExperiment: 0 }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

async function runBatch(
  db: Database,
  sandboxRouter: SandboxRouter,
  workspaceId: string,
  hypotheses: ExperimentHypothesis[],
  sandboxHints: ResolveHints,
  evaluationCommand: string,
  metricName: string,
  timeout: number,
  parentExperimentId: string | undefined,
  generation: number,
): Promise<ExperimentOutcome[]> {
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
    } catch {
      // Skip failed sandbox creation
    }
  }

  const outcomes = await Promise.allSettled(
    experiments.map(async ({ sandbox, hypothesis, dbSandboxId }) => {
      try {
        for (const change of hypothesis.changes) {
          await sandbox.writeFile(change.path, change.content)
        }
        const evalResult = await sandbox.execute(evaluationCommand, { timeout })

        if (evalResult.exitCode !== 0) {
          updateSandboxStatus(db, dbSandboxId, "failed")
          const outcome: ExperimentOutcome = {
            sandboxId: dbSandboxId, hypothesis: hypothesis.description,
            metrics: {}, decision: "crash", diff: await sandbox.getDiff(), error: evalResult.stderr,
          }
          createResult(db, { sandbox_id: dbSandboxId, workspace_id: workspaceId, metrics: {}, decision: "crash", diff: outcome.diff, reasoning: evalResult.stderr })
          recordLineage(db, { id: dbSandboxId, parentId: parentExperimentId, workspaceId, hypothesis: hypothesis.description, metrics: {}, generation, decision: "crash" })
          return outcome
        }

        const metrics = parseMetrics(evalResult.stdout, metricName)
        const diff = await sandbox.getDiff()
        updateSandboxStatus(db, dbSandboxId, "completed")
        const outcome: ExperimentOutcome = { sandboxId: dbSandboxId, hypothesis: hypothesis.description, metrics, decision: "discard", diff }
        createResult(db, { sandbox_id: dbSandboxId, workspace_id: workspaceId, metrics, decision: "discard", diff })
        recordLineage(db, { id: dbSandboxId, parentId: parentExperimentId, workspaceId, hypothesis: hypothesis.description, metrics, generation, decision: "discard" })
        return outcome
      } catch (err) {
        updateSandboxStatus(db, dbSandboxId, "failed")
        return { sandboxId: dbSandboxId, hypothesis: hypothesis.description, metrics: {} as Record<string, number>, decision: "crash" as const, diff: "", error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )

  // Cleanup sandboxes
  for (const { sandbox } of experiments) {
    try { await sandboxRouter.release(sandbox.id) } catch {}
  }

  return outcomes.map(o => o.status === "fulfilled" ? o.value : {
    sandboxId: "", hypothesis: "unknown", metrics: {}, decision: "crash" as const, diff: "", error: (o.reason as Error)?.message ?? "Unknown error",
  })
}

/** Compute normalized variance (coefficient of variation) */
function computeNormalizedVariance(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / Math.abs(mean) // coefficient of variation
}

export { computeNormalizedVariance }
