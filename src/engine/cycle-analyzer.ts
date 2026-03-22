/**
 * Cycle Performance Analyzer — analyzes which cycles work best and recommends
 * the optimal cycle for a given domain.
 *
 * Queries model_calls, knowledge, results, and workspaces tables to compute
 * performance metrics per cycle. Powers the AI cycle discovery engine.
 */

import type { Database } from "bun:sqlite"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CyclePerformanceMetrics {
  cycleId: string
  runCount: number
  avgConfidence: number
  costEfficiency: number
  timeEfficiency: number
  experimentSuccessRate: number
  avgPhaseDuration: Record<string, number>
  totalCost: number
  totalKnowledge: number
}

export interface CycleComparison {
  rankings: Array<{
    rank: number
    cycleId: string
    metrics: CyclePerformanceMetrics
    /** Composite score (0-1) combining all metrics */
    compositeScore: number
  }>
  best: string
  worst: string
}

export interface PhaseTypeEffectiveness {
  phaseType: string
  avgDuration: number
  avgCost: number
  /** How often this phase type appears in successful cycles */
  successCorrelation: number
}

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Analyze performance metrics for a single cycle.
 * Queries workspaces, model_calls, results, and knowledge tables.
 */
export function analyzeCyclePerformance(db: Database, cycleId: string): CyclePerformanceMetrics {
  // Count workspaces that used this cycle
  const workspaceRows = db
    .query("SELECT id, cost_total, created_at, updated_at FROM workspaces WHERE cycle_id = ?")
    .all(cycleId) as Array<{ id: string; cost_total: number; created_at: string; updated_at: string }>

  const runCount = workspaceRows.length

  if (runCount === 0) {
    return {
      cycleId,
      runCount: 0,
      avgConfidence: 0,
      costEfficiency: 0,
      timeEfficiency: 0,
      experimentSuccessRate: 0,
      avgPhaseDuration: {},
      totalCost: 0,
      totalKnowledge: 0,
    }
  }

  const workspaceIds = workspaceRows.map((w) => w.id)
  const placeholders = workspaceIds.map(() => "?").join(",")

  // Total cost across all runs of this cycle
  const totalCost = workspaceRows.reduce((sum, w) => sum + (w.cost_total ?? 0), 0)

  // Count knowledge entries produced by projects that used this cycle
  // Knowledge is linked via project_id, and workspaces link to projects
  const knowledgeRow = db
    .query(
      `SELECT COUNT(DISTINCT k.id) as count, AVG(k.confidence) as avg_confidence
       FROM knowledge k
       INNER JOIN workspaces w ON w.project_id = k.project_id
       WHERE w.cycle_id = ?`,
    )
    .get(cycleId) as { count: number; avg_confidence: number | null } | null

  const totalKnowledge = knowledgeRow?.count ?? 0
  const avgConfidence = knowledgeRow?.avg_confidence ?? 0

  // Cost efficiency: knowledge entries per dollar
  const costEfficiency = totalCost > 0 ? totalKnowledge / totalCost : 0

  // Time efficiency: compute total duration in minutes, knowledge per minute
  let totalDurationMinutes = 0
  for (const w of workspaceRows) {
    const start = new Date(w.created_at).getTime()
    const end = new Date(w.updated_at).getTime()
    const durationMs = end - start
    totalDurationMinutes += Math.max(durationMs / 60000, 0.001) // avoid zero
  }
  const timeEfficiency = totalDurationMinutes > 0 ? totalKnowledge / totalDurationMinutes : 0

  // Experiment success rate: % of results with decision='keep'
  const resultRow = db
    .query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN decision = 'keep' THEN 1 ELSE 0 END) as kept
       FROM results
       WHERE workspace_id IN (${placeholders})`,
    )
    .get(...workspaceIds) as { total: number; kept: number } | null

  const experimentSuccessRate =
    resultRow && resultRow.total > 0 ? resultRow.kept / resultRow.total : 0

  // Average phase duration: from model_calls grouped by phase
  const phaseDurationRows = db
    .query(
      `SELECT phase, AVG(latency_ms) as avg_latency
       FROM model_calls
       WHERE workspace_id IN (${placeholders}) AND phase IS NOT NULL
       GROUP BY phase`,
    )
    .all(...workspaceIds) as Array<{ phase: string; avg_latency: number }>

  const avgPhaseDuration: Record<string, number> = {}
  for (const row of phaseDurationRows) {
    avgPhaseDuration[row.phase] = row.avg_latency
  }

  return {
    cycleId,
    runCount,
    avgConfidence,
    costEfficiency,
    timeEfficiency,
    experimentSuccessRate,
    avgPhaseDuration,
    totalCost,
    totalKnowledge,
  }
}

/**
 * Compare multiple cycles side-by-side and rank them by a composite score.
 *
 * Composite score weighs:
 *   - avgConfidence (30%) — quality of knowledge produced
 *   - costEfficiency (25%) — bang for buck
 *   - experimentSuccessRate (25%) — how often experiments work
 *   - timeEfficiency (20%) — speed of knowledge production
 */
export function compareCycles(db: Database, cycleIds: string[]): CycleComparison {
  const metricsArr = cycleIds.map((id) => analyzeCyclePerformance(db, id))

  // Find max values for normalization
  const maxConfidence = Math.max(...metricsArr.map((m) => m.avgConfidence), 0.001)
  const maxCostEff = Math.max(...metricsArr.map((m) => m.costEfficiency), 0.001)
  const maxTimeEff = Math.max(...metricsArr.map((m) => m.timeEfficiency), 0.001)
  const maxSuccessRate = Math.max(...metricsArr.map((m) => m.experimentSuccessRate), 0.001)

  const scored = metricsArr.map((m) => {
    // Normalize each metric to 0-1 relative to the best
    const normConf = m.avgConfidence / maxConfidence
    const normCost = m.costEfficiency / maxCostEff
    const normTime = m.timeEfficiency / maxTimeEff
    const normSuccess = m.experimentSuccessRate / maxSuccessRate

    const compositeScore =
      normConf * 0.3 + normCost * 0.25 + normSuccess * 0.25 + normTime * 0.2

    return { metrics: m, compositeScore }
  })

  // Sort by composite score descending
  scored.sort((a, b) => b.compositeScore - a.compositeScore)

  const rankings = scored.map((s, i) => ({
    rank: i + 1,
    cycleId: s.metrics.cycleId,
    metrics: s.metrics,
    compositeScore: s.compositeScore,
  }))

  return {
    rankings,
    best: rankings[0]?.cycleId ?? "",
    worst: rankings[rankings.length - 1]?.cycleId ?? "",
  }
}

/**
 * Recommend the best performing cycle for a given domain.
 * Looks at workspaces grouped by cycle_id where the project's domain matches.
 */
export function getBestCycleForDomain(db: Database, domain: string): string | null {
  // Find all cycle IDs used for projects in this domain
  const cycleRows = db
    .query(
      `SELECT DISTINCT w.cycle_id
       FROM workspaces w
       INNER JOIN projects p ON w.project_id = p.id
       WHERE p.domain = ?`,
    )
    .all(domain) as Array<{ cycle_id: string }>

  if (cycleRows.length === 0) return null

  const cycleIds = cycleRows.map((r) => r.cycle_id)

  if (cycleIds.length === 1) return cycleIds[0]!

  const comparison = compareCycles(db, cycleIds)
  return comparison.best || null
}

// ─── Domain Meta-Learning ───────────────────────────────────────────────────

/**
 * Get recommendations for all domains: which cycle works best for each.
 */
export function getDomainRecommendations(db: Database): Record<string, string> {
  const domains = db
    .query("SELECT DISTINCT domain FROM projects")
    .all() as Array<{ domain: string }>

  const recommendations: Record<string, string> = {}

  for (const { domain } of domains) {
    const best = getBestCycleForDomain(db, domain)
    if (best) {
      recommendations[domain] = best
    }
  }

  return recommendations
}

/**
 * Analyze which phase types are most effective for a given domain.
 * Looks at model_calls grouped by phase type, correlated with successful outcomes.
 */
export function getPhaseTypeEffectiveness(
  db: Database,
  domain: string,
): PhaseTypeEffectiveness[] {
  // Get workspace IDs for this domain
  const workspaceRows = db
    .query(
      `SELECT w.id
       FROM workspaces w
       INNER JOIN projects p ON w.project_id = p.id
       WHERE p.domain = ?`,
    )
    .all(domain) as Array<{ id: string }>

  if (workspaceRows.length === 0) return []

  const workspaceIds = workspaceRows.map((w) => w.id)
  const placeholders = workspaceIds.map(() => "?").join(",")

  // Phase stats from model_calls
  const phaseRows = db
    .query(
      `SELECT
         phase,
         AVG(latency_ms) as avg_duration,
         AVG(cost) as avg_cost,
         COUNT(*) as call_count
       FROM model_calls
       WHERE workspace_id IN (${placeholders}) AND phase IS NOT NULL
       GROUP BY phase`,
    )
    .all(...workspaceIds) as Array<{
    phase: string
    avg_duration: number
    avg_cost: number
    call_count: number
  }>

  // Successful workspace IDs (completed status)
  const successfulIds = db
    .query(
      `SELECT w.id
       FROM workspaces w
       INNER JOIN projects p ON w.project_id = p.id
       WHERE p.domain = ? AND w.status = 'completed'`,
    )
    .all(domain) as Array<{ id: string }>

  const successfulIdSet = new Set(successfulIds.map((w) => w.id))

  // For each phase type, compute how often it appears in successful vs all cycles
  return phaseRows.map((row) => {
    // Count how many successful workspaces had calls to this phase
    let successCount = 0
    for (const wid of workspaceIds) {
      if (!successfulIdSet.has(wid)) continue
      const hasPhase = db
        .query(
          "SELECT 1 FROM model_calls WHERE workspace_id = ? AND phase = ? LIMIT 1",
        )
        .get(wid, row.phase)
      if (hasPhase) successCount++
    }

    const successCorrelation =
      workspaceIds.length > 0 ? successCount / workspaceIds.length : 0

    return {
      phaseType: row.phase,
      avgDuration: row.avg_duration,
      avgCost: row.avg_cost,
      successCorrelation,
    }
  })
}
