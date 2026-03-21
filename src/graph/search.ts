/**
 * Hybrid graph search: FTS5 keyword search + sqlite-vec vector search.
 * Merges and deduplicates results from both sources.
 */

import { Database } from "bun:sqlite"
import type { NodeData, EdgeData, SearchOptions, SearchResult } from "./types.ts"
import { getNode } from "./nodes.ts"
import { getEdge } from "./edges.ts"
import {
  generateEmbedding,
  searchSimilarNodes,
  searchSimilarEdges,
  loadVecExtension,
} from "./vec.ts"

function parseNode(row: Record<string, unknown>): NodeData {
  return {
    ...row,
    labels: JSON.parse((row.labels as string) ?? "[]"),
    attributes: JSON.parse((row.attributes as string) ?? "{}"),
  } as NodeData
}

function parseEdge(row: Record<string, unknown>): EdgeData {
  return {
    ...row,
    attributes: JSON.parse((row.attributes as string) ?? "{}"),
  } as EdgeData
}

function escapeFts(query: string): string {
  return query.replace(/['"]/g, "").replace(/[-+*()~^]/g, " ").trim()
}

export function searchNodes(db: Database, graphId: string, query: string, limit?: number): NodeData[] {
  const escaped = escapeFts(query)
  if (!escaped) return []

  const rows = db
    .query(
      `SELECT n.* FROM graph_nodes n
       JOIN graph_nodes_fts fts ON fts.rowid = n.rowid
       WHERE fts.graph_nodes_fts MATCH ? AND n.graph_id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(escaped, graphId, limit ?? 20) as Record<string, unknown>[]
  return rows.map(parseNode)
}

export function searchEdges(db: Database, graphId: string, query: string, limit?: number): EdgeData[] {
  const escaped = escapeFts(query)
  if (!escaped) return []

  const rows = db
    .query(
      `SELECT e.* FROM graph_edges e
       JOIN graph_edges_fts fts ON fts.rowid = e.rowid
       WHERE fts.graph_edges_fts MATCH ? AND e.graph_id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(escaped, graphId, limit ?? 20) as Record<string, unknown>[]
  return rows.map(parseEdge)
}

async function vectorSearchNodes(
  db: Database,
  graphId: string,
  query: string,
  limit: number,
): Promise<NodeData[]> {
  const embedding = await generateEmbedding(query)
  const results = searchSimilarNodes(db, graphId, embedding, limit)
  return results
    .map((r) => getNode(db, r.node_id))
    .filter(Boolean) as NodeData[]
}

async function vectorSearchEdges(
  db: Database,
  graphId: string,
  query: string,
  limit: number,
): Promise<EdgeData[]> {
  const embedding = await generateEmbedding(query)
  const results = searchSimilarEdges(db, graphId, embedding, limit)
  return results
    .map((r) => getEdge(db, r.edge_id))
    .filter(Boolean) as EdgeData[]
}

function isVecAvailable(db: Database): boolean {
  try {
    return loadVecExtension(db)
  } catch {
    return false
  }
}

export async function searchGraph(
  db: Database,
  graphId: string,
  query: string,
  opts?: SearchOptions,
): Promise<SearchResult> {
  const limit = opts?.limit ?? 20
  const scope = opts?.scope ?? "both"
  const useVector = opts?.use_vector !== false && isVecAvailable(db)

  const nodeMap = new Map<string, NodeData>()
  const edgeMap = new Map<string, EdgeData>()

  // FTS5 keyword search
  if (scope === "nodes" || scope === "both") {
    for (const node of searchNodes(db, graphId, query, limit)) {
      nodeMap.set(node.id, node)
    }
  }
  if (scope === "edges" || scope === "both") {
    for (const edge of searchEdges(db, graphId, query, limit)) {
      edgeMap.set(edge.id, edge)
    }
  }

  // Vector similarity search (if available)
  if (useVector) {
    try {
      if (scope === "nodes" || scope === "both") {
        for (const node of await vectorSearchNodes(db, graphId, query, limit)) {
          if (!nodeMap.has(node.id)) nodeMap.set(node.id, node)
        }
      }
      if (scope === "edges" || scope === "both") {
        for (const edge of await vectorSearchEdges(db, graphId, query, limit)) {
          if (!edgeMap.has(edge.id)) edgeMap.set(edge.id, edge)
        }
      }
    } catch {
      // Vector search failed — FTS5 results are still valid
    }
  }

  const nodes = [...nodeMap.values()].slice(0, limit)
  const edges = [...edgeMap.values()].slice(0, limit)
  const facts = edges.map((e) => e.fact).filter((f) => f.length > 0)

  return { nodes, edges, facts }
}
