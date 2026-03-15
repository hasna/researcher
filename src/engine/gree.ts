/**
 * GREE cycle tracking — Gather, Refine, Experiment, Evolve.
 * Handles provider escalation (cheap → balanced → smart → best).
 */

import type { Database } from "bun:sqlite"
import { logGREEPhase } from "../db/index.ts"

/**
 * Record a GREE phase execution with provider and cost details.
 */
export function trackGREEPhase(
  db: Database,
  workspaceId: string,
  phase: "gather" | "refine" | "experiment" | "evolve",
  data: {
    providerUsed: string
    modelUsed: string
    inputSummary: string
    outputSummary: string
    tokensIn: number
    tokensOut: number
    cost: number
  },
): string {
  return logGREEPhase(db, {
    workspace_id: workspaceId,
    phase,
    provider_used: data.providerUsed,
    model_used: data.modelUsed,
    input_summary: data.inputSummary,
    output_summary: data.outputSummary,
    tokens_in: data.tokensIn,
    tokens_out: data.tokensOut,
    cost: data.cost,
  })
}

/**
 * Get cost breakdown per GREE phase for a workspace.
 */
export function getGREECostBreakdown(
  db: Database,
  workspaceId: string,
): { phase: string; provider: string; model: string; cost: number; tokens_in: number; tokens_out: number }[] {
  return db
    .query(
      `SELECT phase, provider_used as provider, model_used as model,
              SUM(cost) as cost, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out
       FROM gree_phases WHERE workspace_id = ?
       GROUP BY phase, provider_used, model_used
       ORDER BY cost DESC`,
    )
    .all(workspaceId) as { phase: string; provider: string; model: string; cost: number; tokens_in: number; tokens_out: number }[]
}

/**
 * Get provider efficiency across all GREE runs — which provider gives best results per dollar.
 */
export function getProviderEfficiency(
  db: Database,
): { provider: string; phase: string; avg_cost: number; total_runs: number }[] {
  return db
    .query(
      `SELECT provider_used as provider, phase,
              AVG(cost) as avg_cost, COUNT(*) as total_runs
       FROM gree_phases
       GROUP BY provider_used, phase
       ORDER BY phase, avg_cost`,
    )
    .all() as { provider: string; phase: string; avg_cost: number; total_runs: number }[]
}
