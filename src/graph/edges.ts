import { Database } from "bun:sqlite"
import type { EdgeData, PaginationOptions, PaginatedResult } from "./types.ts"
import { updateGraphCounts } from "./graph.ts"

function parseEdge(row: Record<string, unknown> | null): EdgeData | null {
  if (!row) return null
  return {
    ...row,
    attributes: JSON.parse((row.attributes as string) ?? "{}"),
  } as EdgeData
}

export function createEdge(
  db: Database,
  graphId: string,
  edge: {
    name: string
    fact: string
    source_node_id: string
    target_node_id: string
    attributes?: Record<string, unknown>
    valid_at?: string
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO graph_edges (id, graph_id, name, fact, source_node_id, target_node_id, attributes, valid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      graphId,
      edge.name,
      edge.fact,
      edge.source_node_id,
      edge.target_node_id,
      JSON.stringify(edge.attributes ?? {}),
      edge.valid_at ?? null,
    ],
  )
  updateGraphCounts(db, graphId)
  return id
}

export function getEdge(db: Database, edgeId: string): EdgeData | null {
  const row = db.query("SELECT * FROM graph_edges WHERE id = ?").get(edgeId) as Record<string, unknown> | null
  return parseEdge(row)
}

export function getEdgesByGraph(
  db: Database,
  graphId: string,
  opts?: PaginationOptions & { include_temporal?: boolean },
): PaginatedResult<EdgeData> {
  const limit = opts?.limit ?? 50
  const totalRow = db
    .query("SELECT COUNT(*) as c FROM graph_edges WHERE graph_id = ?")
    .get(graphId) as { c: number }

  const temporalFilter = opts?.include_temporal === false
    ? " AND expired_at IS NULL"
    : ""

  let rows: Record<string, unknown>[]
  if (opts?.cursor) {
    rows = db
      .query(
        `SELECT * FROM graph_edges WHERE graph_id = ? AND id > ?${temporalFilter}
         ORDER BY id LIMIT ?`,
      )
      .all(graphId, opts.cursor, limit + 1) as Record<string, unknown>[]
  } else {
    rows = db
      .query(
        `SELECT * FROM graph_edges WHERE graph_id = ?${temporalFilter}
         ORDER BY id LIMIT ?`,
      )
      .all(graphId, limit + 1) as Record<string, unknown>[]
  }

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  return {
    items: rows.map((r) => parseEdge(r)!),
    next_cursor: hasMore ? (rows[rows.length - 1].id as string) : null,
    total: totalRow.c,
  }
}

export function getEdgesByNode(db: Database, nodeId: string): EdgeData[] {
  const rows = db
    .query(
      `SELECT * FROM graph_edges
       WHERE source_node_id = ? OR target_node_id = ?
       ORDER BY created_at DESC`,
    )
    .all(nodeId, nodeId) as Record<string, unknown>[]
  return rows.map((r) => parseEdge(r)!)
}

export function deleteEdge(db: Database, edgeId: string): boolean {
  const edge = db.query("SELECT graph_id FROM graph_edges WHERE id = ?").get(edgeId) as { graph_id: string } | null
  const result = db.run("DELETE FROM graph_edges WHERE id = ?", [edgeId])
  if (result.changes > 0 && edge) {
    updateGraphCounts(db, edge.graph_id)
  }
  return result.changes > 0
}
