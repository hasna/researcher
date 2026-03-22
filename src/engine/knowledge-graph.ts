/**
 * Knowledge graph — relationships between knowledge entries stored in SQLite.
 *
 * Enables traversal, confidence propagation, cross-project transfer,
 * and LLM-powered automatic linking of new knowledge.
 */

import type { Database } from "bun:sqlite"
import type { ProviderRouter } from "../providers/router.ts"
import type { KnowledgeEntry } from "./knowledge.ts"
import { queryKnowledge } from "./knowledge.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export type EdgeRelationship =
  | "contradicts"
  | "depends_on"
  | "supersedes"
  | "supports"
  | "derives_from"
  | "related_to"

export interface KnowledgeEdge {
  id: string
  source_id: string
  target_id: string
  relationship: EdgeRelationship
  weight: number
  metadata: Record<string, unknown>
  created_at: string
}

export interface SubgraphResult {
  nodes: KnowledgeEntry[]
  edges: KnowledgeEdge[]
}

// ─── Edge CRUD ──────────────────────────────────────────────────────────────

/**
 * Create an edge between two knowledge entries.
 */
export function addRelationship(
  db: Database,
  data: {
    source_id: string
    target_id: string
    relationship: EdgeRelationship
    weight?: number
    metadata?: Record<string, unknown>
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO knowledge_edges (id, source_id, target_id, relationship, weight, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.source_id,
      data.target_id,
      data.relationship,
      data.weight ?? 1.0,
      JSON.stringify(data.metadata ?? {}),
    ],
  )
  return id
}

/**
 * Delete an edge by its ID.
 */
export function removeRelationship(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM knowledge_edges WHERE id = ?", [id])
  return result.changes > 0
}

/**
 * Get all edges connected to a knowledge node (both directions).
 */
export function getRelationships(db: Database, knowledgeId: string): KnowledgeEdge[] {
  const rows = db
    .query(
      `SELECT * FROM knowledge_edges
       WHERE source_id = ? OR target_id = ?
       ORDER BY created_at DESC`,
    )
    .all(knowledgeId, knowledgeId) as Record<string, unknown>[]

  return rows.map(parseEdgeRow)
}

// ─── Graph traversal ────────────────────────────────────────────────────────

/**
 * Get knowledge nodes directly connected to the given node.
 */
export function getNeighbors(
  db: Database,
  knowledgeId: string,
  opts?: { relationship?: EdgeRelationship; direction?: "outgoing" | "incoming" | "both" },
): KnowledgeEntry[] {
  const direction = opts?.direction ?? "both"
  const relationship = opts?.relationship

  let sql: string
  const params: string[] = []

  if (direction === "outgoing") {
    sql = `SELECT k.* FROM knowledge k
           JOIN knowledge_edges e ON e.target_id = k.id
           WHERE e.source_id = ?`
    params.push(knowledgeId)
    if (relationship) {
      sql += " AND e.relationship = ?"
      params.push(relationship)
    }
  } else if (direction === "incoming") {
    sql = `SELECT k.* FROM knowledge k
           JOIN knowledge_edges e ON e.source_id = k.id
           WHERE e.target_id = ?`
    params.push(knowledgeId)
    if (relationship) {
      sql += " AND e.relationship = ?"
      params.push(relationship)
    }
  } else {
    // Use UNION to properly handle both directions with optional relationship filter
    let relFilter = ""
    if (relationship) {
      relFilter = " AND e.relationship = ?"
      params.push(knowledgeId, relationship, knowledgeId, relationship)
    } else {
      params.push(knowledgeId, knowledgeId)
    }
    sql = `SELECT DISTINCT k.* FROM knowledge k WHERE k.id IN (
             SELECT e.target_id FROM knowledge_edges e WHERE e.source_id = ?${relFilter}
             UNION
             SELECT e.source_id FROM knowledge_edges e WHERE e.target_id = ?${relFilter}
           )`
  }

  sql += " ORDER BY k.confidence DESC"

  const rows = db.query(sql).all(...params) as Record<string, unknown>[]
  return rows.map(parseKnowledgeRow)
}

/**
 * BFS to find shortest path between two knowledge nodes.
 * Returns array of knowledge IDs forming the path, or empty array if no path.
 */
export function findPath(
  db: Database,
  fromId: string,
  toId: string,
  maxDepth: number = 10,
): string[] {
  if (fromId === toId) return [fromId]

  const visited = new Set<string>([fromId])
  // parent map: child -> parent
  const parent = new Map<string, string>()
  let frontier = [fromId]

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = []

    for (const nodeId of frontier) {
      // Get all neighbors (both directions)
      const edgeRows = db
        .query(
          `SELECT source_id, target_id FROM knowledge_edges
           WHERE source_id = ? OR target_id = ?`,
        )
        .all(nodeId, nodeId) as { source_id: string; target_id: string }[]

      for (const row of edgeRows) {
        const neighbor = row.source_id === nodeId ? row.target_id : row.source_id
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        parent.set(neighbor, nodeId)

        if (neighbor === toId) {
          // Reconstruct path
          const path: string[] = [toId]
          let current = toId
          while (parent.has(current)) {
            current = parent.get(current)!
            path.unshift(current)
          }
          return path
        }

        nextFrontier.push(neighbor)
      }
    }

    frontier = nextFrontier
  }

  return [] // no path found
}

// ─── Confidence propagation ─────────────────────────────────────────────────

/**
 * When a node's confidence changes, propagate the effect to connected nodes.
 *
 * Rules:
 * - supports: proportional change (same direction)
 * - contradicts: inverse change (opposite direction)
 * - depends_on: proportional change (same direction)
 * - supersedes/derives_from/related_to: no propagation
 */
export function propagateConfidence(db: Database, knowledgeId: string): number {
  const sourceRow = db.query("SELECT confidence FROM knowledge WHERE id = ?").get(knowledgeId) as {
    confidence: number
  } | null
  if (!sourceRow) return 0

  const sourceConfidence = sourceRow.confidence
  let updated = 0

  // Get outgoing edges that trigger propagation
  const edges = db
    .query(
      `SELECT * FROM knowledge_edges
       WHERE source_id = ? AND relationship IN ('supports', 'contradicts', 'depends_on')`,
    )
    .all(knowledgeId) as Record<string, unknown>[]

  for (const edgeRow of edges) {
    const edge = parseEdgeRow(edgeRow)
    const targetRow = db
      .query("SELECT confidence FROM knowledge WHERE id = ?")
      .get(edge.target_id) as { confidence: number } | null
    if (!targetRow) continue

    const currentTargetConf = targetRow.confidence
    let newTargetConf: number

    if (edge.relationship === "contradicts") {
      // Inverse: high source confidence pushes target down
      const delta = (sourceConfidence - 0.5) * edge.weight * 0.2
      newTargetConf = currentTargetConf - delta
    } else {
      // supports / depends_on: proportional
      const delta = (sourceConfidence - 0.5) * edge.weight * 0.1
      newTargetConf = currentTargetConf + delta
    }

    newTargetConf = Math.max(0, Math.min(1, newTargetConf))

    if (Math.abs(newTargetConf - currentTargetConf) > 0.001) {
      db.run(
        "UPDATE knowledge SET confidence = ?, updated_at = datetime('now') WHERE id = ?",
        [newTargetConf, edge.target_id],
      )
      updated++
    }
  }

  return updated
}

// ─── Subgraph extraction ────────────────────────────────────────────────────

/**
 * Get N-level neighborhood around a knowledge node.
 */
export function getSubgraph(
  db: Database,
  knowledgeId: string,
  depth: number = 2,
): SubgraphResult {
  const nodeIds = new Set<string>([knowledgeId])
  const edgeIds = new Set<string>()
  let frontier = [knowledgeId]

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: string[] = []

    for (const nodeId of frontier) {
      const edgeRows = db
        .query(
          `SELECT * FROM knowledge_edges
           WHERE source_id = ? OR target_id = ?`,
        )
        .all(nodeId, nodeId) as Record<string, unknown>[]

      for (const row of edgeRows) {
        const edge = parseEdgeRow(row)
        edgeIds.add(edge.id)
        const neighbor = edge.source_id === nodeId ? edge.target_id : edge.source_id
        if (!nodeIds.has(neighbor)) {
          nodeIds.add(neighbor)
          nextFrontier.push(neighbor)
        }
      }
    }

    frontier = nextFrontier
  }

  // Fetch full node data
  const nodes: KnowledgeEntry[] = []
  for (const nid of nodeIds) {
    const row = db.query("SELECT * FROM knowledge WHERE id = ?").get(nid) as Record<string, unknown> | null
    if (row) nodes.push(parseKnowledgeRow(row))
  }

  // Collect all edges between the collected nodes
  const edges: KnowledgeEdge[] = []
  for (const eid of edgeIds) {
    const row = db.query("SELECT * FROM knowledge_edges WHERE id = ?").get(eid) as Record<string, unknown> | null
    if (row) edges.push(parseEdgeRow(row))
  }

  return { nodes, edges }
}

// ─── Auto-linking via LLM ───────────────────────────────────────────────────

/**
 * Use LLM to detect relationships between new knowledge and existing knowledge,
 * then create edges automatically.
 */
export async function autoLinkKnowledge(
  db: Database,
  router: ProviderRouter,
  newKnowledgeId: string,
  projectId: string,
): Promise<string[]> {
  // Get the new knowledge entry
  const newRow = db.query("SELECT * FROM knowledge WHERE id = ?").get(newKnowledgeId) as Record<string, unknown> | null
  if (!newRow) return []
  const newEntry = parseKnowledgeRow(newRow)

  // Get existing knowledge for the same project (limit to keep prompt size manageable)
  const existingRows = db
    .query(
      `SELECT * FROM knowledge
       WHERE id != ? AND (project_id = ? OR project_id IS NULL)
       ORDER BY confidence DESC
       LIMIT 20`,
    )
    .all(newKnowledgeId, projectId) as Record<string, unknown>[]

  if (existingRows.length === 0) return []

  const existing = existingRows.map(parseKnowledgeRow)

  // Build LLM prompt
  const entriesList = existing
    .map((e, i) => `[${i}] (id=${e.id}) "${e.insight}" [confidence=${e.confidence.toFixed(2)}, domain=${e.domain}]`)
    .join("\n")

  const prompt = `You are analyzing relationships between research knowledge entries.

NEW ENTRY (id=${newEntry.id}):
"${newEntry.insight}" [confidence=${newEntry.confidence.toFixed(2)}, domain=${newEntry.domain}]

EXISTING ENTRIES:
${entriesList}

For each existing entry that has a meaningful relationship to the NEW ENTRY, output a line in this EXACT format:
LINK <index> <relationship>

Where <relationship> is one of: contradicts, depends_on, supersedes, supports, derives_from, related_to

Only output links that are clearly justified. Output nothing if no relationships exist.
Do NOT explain your reasoning — only output LINK lines.`

  try {
    const result = await router.generate(prompt, "cheap", {
      system: "You detect relationships between knowledge entries. Output only LINK lines, nothing else.",
      max_tokens: 500,
    })

    const createdEdgeIds: string[] = []
    const lines = result.content.split("\n")

    for (const line of lines) {
      const match = line.match(/^LINK\s+(\d+)\s+(contradicts|depends_on|supersedes|supports|derives_from|related_to)/i)
      if (!match) continue

      const idx = parseInt(match[1]!, 10)
      const rel = match[2]!.toLowerCase() as EdgeRelationship
      const target = existing[idx]
      if (!target) continue

      try {
        const edgeId = addRelationship(db, {
          source_id: newKnowledgeId,
          target_id: target.id,
          relationship: rel,
          metadata: { auto_linked: true },
        })
        createdEdgeIds.push(edgeId)
      } catch {
        // UNIQUE constraint violation — edge already exists, skip
      }
    }

    return createdEdgeIds
  } catch {
    // LLM failure is non-critical for auto-linking
    return []
  }
}

// ─── Cross-project transfer ─────────────────────────────────────────────────

/**
 * Copy relevant knowledge from one project to another,
 * creating derives_from edges to track provenance.
 */
export function transferKnowledge(
  db: Database,
  opts: {
    fromProjectId: string
    toProjectId: string
    domain?: string
    minConfidence?: number
  },
): { transferred: number; edgeIds: string[] } {
  const minConf = opts.minConfidence ?? 0.5

  let sql = `SELECT * FROM knowledge WHERE project_id = ? AND confidence >= ?`
  const params: (string | number)[] = [opts.fromProjectId, minConf]

  if (opts.domain) {
    sql += " AND domain = ?"
    params.push(opts.domain)
  }

  sql += " ORDER BY confidence DESC"

  const sourceRows = db.query(sql).all(...params) as Record<string, unknown>[]
  const edgeIds: string[] = []
  let transferred = 0

  for (const row of sourceRows) {
    const source = parseKnowledgeRow(row)

    // Create a copy in the target project
    const newId = crypto.randomUUID().slice(0, 16)
    db.run(
      `INSERT INTO knowledge (id, project_id, domain, insight, evidence, confidence, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newId,
        opts.toProjectId,
        source.domain,
        source.insight,
        JSON.stringify(source.evidence),
        source.confidence * 0.8, // Slightly lower confidence for transferred knowledge
        JSON.stringify([...source.tags, "transferred"]),
      ],
    )

    // Create derives_from edge
    try {
      const edgeId = addRelationship(db, {
        source_id: newId,
        target_id: source.id,
        relationship: "derives_from",
        metadata: {
          from_project: opts.fromProjectId,
          to_project: opts.toProjectId,
        },
      })
      edgeIds.push(edgeId)
    } catch {
      // Edge already exists — skip
    }

    transferred++
  }

  return { transferred, edgeIds }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function parseEdgeRow(row: Record<string, unknown>): KnowledgeEdge {
  return {
    id: row.id as string,
    source_id: row.source_id as string,
    target_id: row.target_id as string,
    relationship: row.relationship as EdgeRelationship,
    weight: row.weight as number,
    metadata: JSON.parse((row.metadata as string) ?? "{}"),
    created_at: row.created_at as string,
  }
}

function parseKnowledgeRow(row: Record<string, unknown>): KnowledgeEntry {
  return {
    id: row.id as string,
    project_id: row.project_id as string | null,
    domain: row.domain as string,
    insight: row.insight as string,
    evidence: JSON.parse((row.evidence as string) ?? "[]"),
    confidence: row.confidence as number,
    tags: JSON.parse((row.tags as string) ?? "[]"),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
