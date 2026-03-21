import { Database } from "bun:sqlite"
import type { GraphInfo, OntologyDef } from "./types.ts"

export function createGraph(
  db: Database,
  data: {
    name: string
    description?: string
    project_id?: string
    ontology?: OntologyDef
  },
): string {
  const id = crypto.randomUUID().slice(0, 16)
  db.run(
    `INSERT INTO graphs (id, name, description, project_id, ontology)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.description ?? "",
      data.project_id ?? null,
      JSON.stringify(data.ontology ?? {}),
    ],
  )
  return id
}

function parseGraph(row: Record<string, unknown> | null): GraphInfo | null {
  if (!row) return null
  return {
    ...row,
    ontology: JSON.parse((row.ontology as string) ?? "{}"),
  } as GraphInfo
}

export function getGraph(db: Database, graphId: string): GraphInfo | null {
  const row = db.query("SELECT * FROM graphs WHERE id = ?").get(graphId) as Record<string, unknown> | null
  return parseGraph(row)
}

export function listGraphs(db: Database, projectId?: string): GraphInfo[] {
  let rows: Record<string, unknown>[]
  if (projectId) {
    rows = db
      .query("SELECT * FROM graphs WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as Record<string, unknown>[]
  } else {
    rows = db.query("SELECT * FROM graphs ORDER BY created_at DESC").all() as Record<string, unknown>[]
  }
  return rows.map((r) => parseGraph(r)!)
}

export function deleteGraph(db: Database, graphId: string): boolean {
  const result = db.run("DELETE FROM graphs WHERE id = ?", [graphId])
  return result.changes > 0
}

export function updateGraphCounts(db: Database, graphId: string): void {
  const nodeCount = db
    .query("SELECT COUNT(*) as c FROM graph_nodes WHERE graph_id = ?")
    .get(graphId) as { c: number }
  const edgeCount = db
    .query("SELECT COUNT(*) as c FROM graph_edges WHERE graph_id = ?")
    .get(graphId) as { c: number }
  const episodeCount = db
    .query("SELECT COUNT(*) as c FROM graph_episodes WHERE graph_id = ?")
    .get(graphId) as { c: number }

  db.run(
    `UPDATE graphs SET node_count = ?, edge_count = ?, episode_count = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [nodeCount.c, edgeCount.c, episodeCount.c, graphId],
  )
}
