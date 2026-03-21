/**
 * Types for the graph module — entity extraction, knowledge graphs, and search.
 * Designed as a drop-in replacement for Zep Cloud's graph API.
 */

// ─── Graph ──────────────────────────────────────────────────────────────────

export interface GraphInfo {
  id: string
  project_id: string | null
  name: string
  description: string
  ontology: OntologyDef
  node_count: number
  edge_count: number
  episode_count: number
  created_at: string
  updated_at: string
}

export interface OntologyDef {
  entity_types?: EntityTypeDef[]
  edge_types?: EdgeTypeDef[]
}

export interface EntityTypeDef {
  name: string
  description?: string
}

export interface EdgeTypeDef {
  name: string
  description?: string
  source_types?: string[]
  target_types?: string[]
}

// ─── Nodes ──────────────────────────────────────────────────────────────────

export interface NodeData {
  id: string
  graph_id: string
  name: string
  labels: string[]
  summary: string
  attributes: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface NodeInput {
  name: string
  labels?: string[]
  summary?: string
  attributes?: Record<string, unknown>
}

// ─── Edges ──────────────────────────────────────────────────────────────────

export interface EdgeData {
  id: string
  graph_id: string
  name: string
  fact: string
  source_node_id: string
  target_node_id: string
  attributes: Record<string, unknown>
  created_at: string
  valid_at: string | null
  invalid_at: string | null
  expired_at: string | null
}

export interface EdgeInput {
  name: string
  fact: string
  source_name: string
  target_name: string
  attributes?: Record<string, unknown>
  valid_at?: string
}

// ─── Episodes ───────────────────────────────────────────────────────────────

export interface EpisodeData {
  id: string
  graph_id: string
  data: string
  type: string
  processed: boolean
  node_count: number
  edge_count: number
  created_at: string
}

export interface EpisodeResult {
  episode_id: string
  nodes_created: number
  nodes_updated: number
  edges_created: number
}

// ─── Extraction ─────────────────────────────────────────────────────────────

export interface ExtractionResult {
  nodes: NodeInput[]
  edges: EdgeInput[]
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface SearchOptions {
  limit?: number
  scope?: "nodes" | "edges" | "both"
  rerank?: boolean
  use_vector?: boolean
}

export interface SearchResult {
  nodes: NodeData[]
  edges: EdgeData[]
  facts: string[]
}

// ─── Vector ─────────────────────────────────────────────────────────────────

export interface EmbeddingResult {
  id: string
  embedding: Float32Array
}

// ─── Pagination ─────────────────────────────────────────────────────────────

export interface PaginationOptions {
  limit?: number
  cursor?: string
}

export interface PaginatedResult<T> {
  items: T[]
  next_cursor: string | null
  total?: number
}
