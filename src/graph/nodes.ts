import { Database } from "bun:sqlite"
import type { NodeData, NodeInput, EdgeData, PaginationOptions, PaginatedResult } from "./types.ts"
import { updateGraphCounts } from "./graph.ts"

function parseNode(row: Record<string, unknown> | null): NodeData | null {
  if (!row) return null
  return {
    ...row,
    labels: JSON.parse((row.labels as string) ?? "[]"),
    attributes: JSON.parse((row.attributes as string) ?? "{}"),
  } as NodeData
}

function parseEdge(row: Record<string, unknown> | null): EdgeData | null {
  if (!row) return null
  return {
    ...row,
    attributes: JSON.parse((row.attributes as string) ?? "{}"),
  } as EdgeData
}

export function upsertNode(
  db: Database,
  graphId: string,
  node: NodeInput,
): { id: string; created: boolean } {
  const existing = db
    .query("SELECT * FROM graph_nodes WHERE graph_id = ? AND name = ?")
    .get(graphId, node.name) as Record<string, unknown> | null

  if (existing) {
    const existingLabels: string[] = JSON.parse((existing.labels as string) ?? "[]")
    const existingAttrs: Record<string, unknown> = JSON.parse((existing.attributes as string) ?? "{}")
    const existingSummary = existing.summary as string

    const labelSet = new Set(existingLabels)
    for (const l of node.labels ?? []) labelSet.add(l)
    const mergedLabels = Array.from(labelSet)
    const mergedAttrs = { ...existingAttrs, ...(node.attributes ?? {}) }
    const summary =
      (node.summary ?? "").length > existingSummary.length
        ? node.summary!
        : existingSummary

    db.run(
      `UPDATE graph_nodes SET labels = ?, summary = ?, attributes = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        JSON.stringify(mergedLabels),
        summary,
        JSON.stringify(mergedAttrs),
        existing.id as string,
      ],
    )
    return { id: existing.id as string, created: false }
  }

  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO graph_nodes (id, graph_id, name, labels, summary, attributes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      graphId,
      node.name,
      JSON.stringify(node.labels ?? []),
      node.summary ?? "",
      JSON.stringify(node.attributes ?? {}),
    ],
  )
  updateGraphCounts(db, graphId)
  return { id, created: true }
}

export function getNode(db: Database, nodeId: string): NodeData | null {
  const row = db.query("SELECT * FROM graph_nodes WHERE id = ?").get(nodeId) as Record<string, unknown> | null
  return parseNode(row)
}

export function getNodesByGraph(
  db: Database,
  graphId: string,
  opts?: PaginationOptions,
): PaginatedResult<NodeData> {
  const limit = opts?.limit ?? 50
  const totalRow = db
    .query("SELECT COUNT(*) as c FROM graph_nodes WHERE graph_id = ?")
    .get(graphId) as { c: number }

  let rows: Record<string, unknown>[]
  if (opts?.cursor) {
    rows = db
      .query(
        `SELECT * FROM graph_nodes WHERE graph_id = ? AND id > ?
         ORDER BY id LIMIT ?`,
      )
      .all(graphId, opts.cursor, limit + 1) as Record<string, unknown>[]
  } else {
    rows = db
      .query("SELECT * FROM graph_nodes WHERE graph_id = ? ORDER BY id LIMIT ?")
      .all(graphId, limit + 1) as Record<string, unknown>[]
  }

  const hasMore = rows.length > limit
  if (hasMore) rows.pop()

  return {
    items: rows.map((r) => parseNode(r)!),
    next_cursor: hasMore ? (rows[rows.length - 1].id as string) : null,
    total: totalRow.c,
  }
}

export function getNodesByLabel(db: Database, graphId: string, label: string): NodeData[] {
  const rows = db
    .query(`SELECT * FROM graph_nodes WHERE graph_id = ? AND labels LIKE ?`)
    .all(graphId, `%"${label}"%`) as Record<string, unknown>[]
  return rows.map((r) => parseNode(r)!)
}

export function getNodeEdges(db: Database, nodeId: string): EdgeData[] {
  const rows = db
    .query(
      `SELECT * FROM graph_edges
       WHERE source_node_id = ? OR target_node_id = ?
       ORDER BY created_at DESC`,
    )
    .all(nodeId, nodeId) as Record<string, unknown>[]
  return rows.map((r) => parseEdge(r)!)
}

export function deleteNode(db: Database, nodeId: string): boolean {
  const node = db.query("SELECT graph_id FROM graph_nodes WHERE id = ?").get(nodeId) as { graph_id: string } | null
  const result = db.run("DELETE FROM graph_nodes WHERE id = ?", [nodeId])
  if (result.changes > 0 && node) {
    updateGraphCounts(db, node.graph_id)
  }
  return result.changes > 0
}
