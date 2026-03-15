/**
 * Knowledge system — accumulate, query, and export research knowledge.
 * Knowledge is the REAL output of the system — experiments are transient, knowledge is permanent.
 */

import type { Database } from "bun:sqlite"
import { saveKnowledge as dbSaveKnowledge, queryKnowledge as dbQueryKnowledge } from "../db/index.ts"

export interface KnowledgeEntry {
  id: string
  project_id: string | null
  domain: string
  insight: string
  evidence: KnowledgeEvidence[]
  confidence: number
  tags: string[]
  created_at: string
  updated_at: string
}

export interface KnowledgeEvidence {
  experiment_id: string
  metric_value: number
  description: string
}

/**
 * Save a knowledge entry with evidence from experiments.
 */
export function saveKnowledge(
  db: Database,
  data: {
    project_id?: string
    domain: string
    insight: string
    evidence?: KnowledgeEvidence[]
    confidence?: number
    tags?: string[]
  },
): string {
  return dbSaveKnowledge(db, {
    project_id: data.project_id,
    domain: data.domain,
    insight: data.insight,
    evidence: data.evidence,
    confidence: data.confidence,
    tags: data.tags,
  })
}

/**
 * Query knowledge with filters.
 */
export function queryKnowledge(
  db: Database,
  opts?: {
    domain?: string
    search?: string
    project_id?: string
  },
): KnowledgeEntry[] {
  const rows = dbQueryKnowledge(db, opts) as Record<string, unknown>[]
  return rows.map((row) => ({
    id: row.id as string,
    project_id: row.project_id as string | null,
    domain: row.domain as string,
    insight: row.insight as string,
    evidence: JSON.parse((row.evidence as string) ?? "[]"),
    confidence: row.confidence as number,
    tags: JSON.parse((row.tags as string) ?? "[]"),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }))
}

/**
 * Get cross-project knowledge patterns — insights that apply across domains.
 */
export function getCrossProjectKnowledge(db: Database): KnowledgeEntry[] {
  const rows = db
    .query("SELECT * FROM knowledge WHERE project_id IS NULL ORDER BY confidence DESC")
    .all() as Record<string, unknown>[]

  return rows.map((row) => ({
    id: row.id as string,
    project_id: null,
    domain: row.domain as string,
    insight: row.insight as string,
    evidence: JSON.parse((row.evidence as string) ?? "[]"),
    confidence: row.confidence as number,
    tags: JSON.parse((row.tags as string) ?? "[]"),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }))
}

/**
 * Update confidence of a knowledge entry based on new evidence.
 */
export function updateKnowledgeConfidence(
  db: Database,
  knowledgeId: string,
  newEvidence: KnowledgeEvidence,
  confirmsInsight: boolean,
): void {
  const row = db.query("SELECT confidence, evidence FROM knowledge WHERE id = ?").get(knowledgeId) as {
    confidence: number
    evidence: string
  } | null

  if (!row) return

  const evidence: KnowledgeEvidence[] = JSON.parse(row.evidence ?? "[]")
  evidence.push(newEvidence)

  // Bayesian-ish confidence update
  const currentConfidence = row.confidence
  const delta = confirmsInsight ? 0.05 : -0.1
  const newConfidence = Math.max(0, Math.min(1, currentConfidence + delta))

  db.run(
    "UPDATE knowledge SET confidence = ?, evidence = ?, updated_at = datetime('now') WHERE id = ?",
    [newConfidence, JSON.stringify(evidence), knowledgeId],
  )
}

/**
 * Export knowledge as markdown for a project or globally.
 */
export function exportKnowledgeMarkdown(db: Database, projectId?: string): string {
  const entries = queryKnowledge(db, projectId ? { project_id: projectId } : undefined)

  let md = "# Research Knowledge Base\n\n"

  // Group by domain
  const byDomain = new Map<string, KnowledgeEntry[]>()
  for (const entry of entries) {
    const group = byDomain.get(entry.domain) ?? []
    group.push(entry)
    byDomain.set(entry.domain, group)
  }

  for (const [domain, domainEntries] of byDomain) {
    md += `## ${domain}\n\n`
    for (const entry of domainEntries.sort((a, b) => b.confidence - a.confidence)) {
      md += `### ${entry.insight}\n`
      md += `- **Confidence**: ${(entry.confidence * 100).toFixed(0)}%\n`
      md += `- **Tags**: ${entry.tags.join(", ") || "none"}\n`
      if (entry.evidence.length > 0) {
        md += `- **Evidence**: ${entry.evidence.length} experiments\n`
      }
      md += "\n"
    }
  }

  return md
}

/**
 * Apply confidence decay to knowledge entries that haven't been confirmed recently.
 * Entries lose ~1% confidence per day without new evidence.
 */
export function applyConfidenceDecay(db: Database): number {
  // Decay entries not updated in the last 7 days
  const result = db.run(
    `UPDATE knowledge
     SET confidence = MAX(0.05, confidence * 0.99),
         updated_at = datetime('now')
     WHERE updated_at < datetime('now', '-7 days')
     AND confidence > 0.05`,
  )
  return result.changes
}

/**
 * Get stale knowledge — entries with low confidence due to decay.
 */
export function getStaleKnowledge(db: Database, threshold: number = 0.2): KnowledgeEntry[] {
  const rows = db
    .query("SELECT * FROM knowledge WHERE confidence <= ? ORDER BY confidence ASC")
    .all(threshold) as Record<string, unknown>[]

  return rows.map((row) => ({
    id: row.id as string,
    project_id: row.project_id as string | null,
    domain: row.domain as string,
    insight: row.insight as string,
    evidence: JSON.parse((row.evidence as string) ?? "[]"),
    confidence: row.confidence as number,
    tags: JSON.parse((row.tags as string) ?? "[]"),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }))
}
