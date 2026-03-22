// Training data gatherer for @hasna/researcher
// Implements the GatherTrainingDataFn protocol from @hasna/brains.

import { initDb, listProjects, listWorkspaces, listResults, getBestResult } from "../db/index.ts"

// ── Inline types (mirrors @hasna/brains protocol) ────────────────────────────

export interface TrainingExample {
  messages: Array<{
    role: "system" | "user" | "assistant"
    content: string
  }>
}

export interface GatherResult {
  source: string
  examples: TrainingExample[]
  count: number
}

export interface GathererOptions {
  limit?: number
  since?: Date
  outputDir?: string
}

// GatherTrainingDataFn — matches @hasna/brains protocol.ts
export type GatherTrainingDataFn = (
  options?: GathererOptions
) => Promise<GatherResult>

// ── Implementation ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a scientific research assistant that designs experiments, forms hypotheses, and interprets results. You help plan research cycles and extract actionable insights from experiment outcomes."

export const gatherTrainingData: GatherTrainingDataFn = async (
  options: GathererOptions = {}
): Promise<GatherResult> => {
  const limit = options.limit ?? 500
  const examples: TrainingExample[] = []

  let db: ReturnType<typeof initDb>
  try {
    db = initDb()
  } catch {
    return { source: "researcher", examples: [], count: 0 }
  }

  // ── 1. Projects → research summaries ─────────────────────────────────────
  try {
    const projects = listProjects(db) as Array<Record<string, unknown>>
    for (const proj of projects.slice(0, Math.floor(limit / 3))) {
      const name = String(proj["name"] ?? proj["id"])
      const domain = String(proj["domain"] ?? "general")
      const metric = String(proj["metric_name"] ?? "score")
      const direction = String(proj["metric_direction"] ?? "higher")

      examples.push({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Summarize the research project "${name}" and its optimization goal.`,
          },
          {
            role: "assistant",
            content:
              `Research project: "${name}"\n` +
              `Domain: ${domain}\n` +
              `Optimization target: ${metric} (${direction} is better)\n` +
              (proj["path"] ? `Location: ${String(proj["path"])}\n` : ""),
          },
        ],
      })

      examples.push({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `How should I design an experiment to improve ${metric} for the "${name}" project?`,
          },
          {
            role: "assistant",
            content:
              `For the "${name}" project (domain: ${domain}), to improve ${metric}:\n\n` +
              `1. Define a clear hypothesis about what change will improve ${metric}\n` +
              `2. Create a controlled experiment that isolates the variable\n` +
              `3. Run the experiment and measure ${metric} before and after\n` +
              `4. Compare results — you want ${metric} to go ${direction === "higher" ? "up" : "down"}\n` +
              `5. If successful, keep the change; otherwise revert and try a different hypothesis`,
          },
        ],
      })
    }
  } catch {
    // partial results are fine
  }

  // ── 2. Workspaces → cycle context ─────────────────────────────────────────
  try {
    const workspaces = listWorkspaces(db) as Array<Record<string, unknown>>
    for (const ws of workspaces.slice(0, Math.floor(limit / 3))) {
      const cycleId = String(ws["cycle_id"] ?? "unknown")
      const status = String(ws["status"] ?? "unknown")
      const costTotal = Number(ws["cost_total"] ?? 0)

      examples.push({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `What happened in the experiment workspace running the "${cycleId}" cycle?`,
          },
          {
            role: "assistant",
            content:
              `Workspace ran cycle: ${cycleId}\n` +
              `Final status: ${status}\n` +
              `Total AI cost: $${costTotal.toFixed(4)}\n` +
              (ws["current_phase"] ? `Last phase: ${String(ws["current_phase"])}` : ""),
          },
        ],
      })

      // Pull results for this workspace
      try {
        const results = listResults(db, String(ws["id"])) as Array<Record<string, unknown>>
        for (const result of results.slice(0, 2)) {
          const hypothesis = String(result["hypothesis"] ?? "")
          const decision = String(result["decision"] ?? "unknown")
          const metrics = result["metrics"]
            ? (typeof result["metrics"] === "string"
                ? JSON.parse(result["metrics"])
                : result["metrics"]) as Record<string, unknown>
            : {}
          const metricsStr = Object.entries(metrics)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")

          if (hypothesis) {
            examples.push({
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                {
                  role: "user",
                  content: `I tested the hypothesis: "${hypothesis}". What were the results?`,
                },
                {
                  role: "assistant",
                  content:
                    `Experiment result for hypothesis: "${hypothesis}"\n` +
                    (metricsStr ? `Metrics: ${metricsStr}\n` : "") +
                    `Decision: ${decision}\n` +
                    (result["reasoning"] ? `Reasoning: ${String(result["reasoning"])}` : ""),
                },
              ],
            })
          }
        }
      } catch {
        // partial results are fine
      }
    }
  } catch {
    // partial results are fine
  }

  // ── 3. Knowledge entries ──────────────────────────────────────────────────
  try {
    const knowledgeRows = db
      .query("SELECT * FROM knowledge ORDER BY confidence DESC LIMIT ?")
      .all(Math.floor(limit / 6)) as Array<Record<string, unknown>>

    for (const k of knowledgeRows) {
      const domain = String(k["domain"] ?? "research")
      const insight = String(k["insight"] ?? "")
      const confidence = Number(k["confidence"] ?? 0.5)

      if (!insight) continue

      examples.push({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `What do we know about "${domain}" from past experiments?`,
          },
          {
            role: "assistant",
            content:
              `Knowledge (domain: ${domain}, confidence: ${(confidence * 100).toFixed(0)}%):\n` +
              insight,
          },
        ],
      })
    }
  } catch {
    // knowledge table may not exist — partial results are fine
  }

  const finalExamples = examples.slice(0, limit)
  return { source: "researcher", examples: finalExamples, count: finalExamples.length }
}
