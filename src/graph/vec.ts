/**
 * sqlite-vec integration for vector search in the graph module.
 * Provides embedding generation and similarity search.
 */

import { Database } from "bun:sqlite"
import OpenAI from "openai"

const EMBEDDING_MODEL = "text-embedding-3-small"
const EMBEDDING_DIMENSIONS = 1536

let _client: OpenAI | null = null

function getEmbeddingClient(): OpenAI {
  if (_client) return _client
  _client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL ?? process.env.LLM_BASE_URL,
  })
  return _client
}

export function setEmbeddingClient(client: OpenAI): void {
  _client = client
}

export function loadVecExtension(db: Database): boolean {
  try {
    const sqliteVec = require("sqlite-vec")
    sqliteVec.load(db)
    return true
  } catch {
    // sqlite-vec not installed — vector search disabled, FTS5 still works
    return false
  }
}

export function createVecTables(db: Database): void {
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_graph_nodes USING vec0(
      node_id TEXT,
      graph_id TEXT,
      embedding float[${EMBEDDING_DIMENSIONS}]
    )
  `)
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_graph_edges USING vec0(
      edge_id TEXT,
      graph_id TEXT,
      embedding float[${EMBEDDING_DIMENSIONS}]
    )
  `)
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const client = getEmbeddingClient()
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000), // Truncate to model limit
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return new Float32Array(response.data[0].embedding)
}

export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const client = getEmbeddingClient()
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map((t) => t.slice(0, 8000)),
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => new Float32Array(d.embedding))
}

export function storeNodeEmbedding(
  db: Database,
  nodeId: string,
  graphId: string,
  embedding: Float32Array,
): void {
  db.run(
    "INSERT OR REPLACE INTO vec_graph_nodes (node_id, graph_id, embedding) VALUES (?, ?, ?)",
    [nodeId, graphId, Buffer.from(embedding.buffer)],
  )
}

export function storeEdgeEmbedding(
  db: Database,
  edgeId: string,
  graphId: string,
  embedding: Float32Array,
): void {
  db.run(
    "INSERT OR REPLACE INTO vec_graph_edges (edge_id, graph_id, embedding) VALUES (?, ?, ?)",
    [edgeId, graphId, Buffer.from(embedding.buffer)],
  )
}

export function searchSimilarNodes(
  db: Database,
  graphId: string,
  queryEmbedding: Float32Array,
  limit = 10,
): Array<{ node_id: string; distance: number }> {
  return db
    .query(
      `SELECT node_id, distance
       FROM vec_graph_nodes
       WHERE graph_id = ? AND embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    )
    .all(graphId, Buffer.from(queryEmbedding.buffer), limit) as Array<{
    node_id: string
    distance: number
  }>
}

export function searchSimilarEdges(
  db: Database,
  graphId: string,
  queryEmbedding: Float32Array,
  limit = 10,
): Array<{ edge_id: string; distance: number }> {
  return db
    .query(
      `SELECT edge_id, distance
       FROM vec_graph_edges
       WHERE graph_id = ? AND embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    )
    .all(graphId, Buffer.from(queryEmbedding.buffer), limit) as Array<{
    edge_id: string
    distance: number
  }>
}

export function deleteNodeEmbedding(db: Database, nodeId: string): void {
  db.run("DELETE FROM vec_graph_nodes WHERE node_id = ?", [nodeId])
}

export function deleteEdgeEmbedding(db: Database, edgeId: string): void {
  db.run("DELETE FROM vec_graph_edges WHERE edge_id = ?", [edgeId])
}

export function deleteGraphEmbeddings(db: Database, graphId: string): void {
  db.run("DELETE FROM vec_graph_nodes WHERE graph_id = ?", [graphId])
  db.run("DELETE FROM vec_graph_edges WHERE graph_id = ?", [graphId])
}
