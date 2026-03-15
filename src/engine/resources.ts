/**
 * Resource manager — concurrency limits, cost tracking, budget enforcement.
 */

import type { Database } from "bun:sqlite"
import { getCostSummary } from "../db/index.ts"

export interface ResourceLimits {
  max_parallel_sandboxes: number
  max_parallel_per_workspace: number
  max_cost_per_hour: number
  max_container_sandboxes: number
  max_cloud_sandboxes: number
}

export const DEFAULT_LIMITS: ResourceLimits = {
  max_parallel_sandboxes: 20,
  max_parallel_per_workspace: 10,
  max_cost_per_hour: 5,
  max_container_sandboxes: 5,
  max_cloud_sandboxes: 2,
}

export class ResourceManager {
  private limits: ResourceLimits

  constructor(limits?: Partial<ResourceLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  /**
   * Check if we're within budget for the current hour.
   */
  isWithinBudget(db: Database): boolean {
    const hourCost = this.getHourlyCost(db)
    return hourCost < this.limits.max_cost_per_hour
  }

  /**
   * Get total cost in the last hour.
   */
  getHourlyCost(db: Database): number {
    const row = db
      .query(
        `SELECT COALESCE(SUM(cost), 0) as total_cost
         FROM model_calls
         WHERE created_at >= datetime('now', '-1 hour')`,
      )
      .get() as { total_cost: number }
    return row.total_cost
  }

  /**
   * Get total cost for today.
   */
  getDailyCost(db: Database): number {
    const row = db
      .query(
        `SELECT COALESCE(SUM(cost), 0) as total_cost
         FROM model_calls
         WHERE created_at >= datetime('now', 'start of day')`,
      )
      .get() as { total_cost: number }
    return row.total_cost
  }

  /**
   * Get full cost summary grouped by provider and model.
   */
  getCostSummary(db: Database, workspaceId?: string) {
    return getCostSummary(db, workspaceId)
  }

  /**
   * Get active sandbox count from DB.
   */
  getActiveSandboxCount(db: Database): number {
    const row = db
      .query("SELECT COUNT(*) as count FROM sandboxes WHERE status IN ('creating', 'running')")
      .get() as { count: number }
    return row.count
  }

  /**
   * Check if a new sandbox can be created.
   */
  canCreateSandbox(db: Database, workspaceId?: string): { allowed: boolean; reason?: string } {
    const totalActive = this.getActiveSandboxCount(db)
    if (totalActive >= this.limits.max_parallel_sandboxes) {
      return { allowed: false, reason: `Max parallel sandboxes (${this.limits.max_parallel_sandboxes}) reached` }
    }

    if (workspaceId) {
      const row = db
        .query("SELECT COUNT(*) as count FROM sandboxes WHERE workspace_id = ? AND status IN ('creating', 'running')")
        .get(workspaceId) as { count: number }
      if (row.count >= this.limits.max_parallel_per_workspace) {
        return { allowed: false, reason: `Max per-workspace sandboxes (${this.limits.max_parallel_per_workspace}) reached` }
      }
    }

    if (!this.isWithinBudget(db)) {
      return { allowed: false, reason: `Hourly budget ($${this.limits.max_cost_per_hour}) exceeded` }
    }

    return { allowed: true }
  }

  /**
   * Get a dashboard-friendly status summary.
   */
  getStatus(db: Database): {
    activeSandboxes: number
    maxSandboxes: number
    hourlyCost: number
    dailyCost: number
    maxHourlyCost: number
    withinBudget: boolean
  } {
    return {
      activeSandboxes: this.getActiveSandboxCount(db),
      maxSandboxes: this.limits.max_parallel_sandboxes,
      hourlyCost: this.getHourlyCost(db),
      dailyCost: this.getDailyCost(db),
      maxHourlyCost: this.limits.max_cost_per_hour,
      withinBudget: this.isWithinBudget(db),
    }
  }
}
