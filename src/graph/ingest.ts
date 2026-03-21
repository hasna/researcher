/**
 * Text ingestion pipeline: text → entity extraction → graph population.
 * Orchestrates extract.ts, nodes.ts, edges.ts, and vec.ts.
 */

import { Database } from "bun:sqlite"
import type { EpisodeResult, OntologyDef } from "./types.ts"
import { extractEntities } from "./extract.ts"
import { upsertNode } from "./nodes.ts"
import { createEdge } from "./edges.ts"
import { getGraph, updateGraphCounts } from "./graph.ts"
import {
  generateEmbeddings,
  storeNodeEmbedding,
  storeEdgeEmbedding,
  loadVecExtension,
  createVecTables,
} from "./vec.ts"

export async function ingestText(
  db: Database,
  graphId: string,
  text: string,
  options?: {
    type?: string
    model?: string
    skip_embeddings?: boolean
  },
): Promise<EpisodeResult> {
  const graph = getGraph(db, graphId)
  if (!graph) throw new Error(`Graph not found: ${graphId}`)

  const ontology = graph.ontology as OntologyDef

  // 1. Store episode
  const episodeId = crypto.randomUUID().slice(0, 16)
  db.run(
    "INSERT INTO graph_episodes (id, graph_id, data, type) VALUES (?, ?, ?, ?)",
    [episodeId, graphId, text, options?.type ?? "text"],
  )

  // 2. Extract entities and relationships via LLM
  const extraction = await extractEntities(text, { ontology, model: options?.model })

  // 3. Upsert nodes
  let nodesCreated = 0
  let nodesUpdated = 0
  const nodeNameToId = new Map<string, string>()

  for (const node of extraction.nodes) {
    const result = upsertNode(db, graphId, node)
    nodeNameToId.set(node.name.toLowerCase(), result.id)
    if (result.created) nodesCreated++
    else nodesUpdated++
  }

  // 4. Resolve node IDs for edges and create them
  let edgesCreated = 0
  const newEdgeIds: string[] = []
  const newNodeIds: string[] = []

  // Collect new node IDs for embedding generation
  for (const node of extraction.nodes) {
    const id = nodeNameToId.get(node.name.toLowerCase())
    if (id) newNodeIds.push(id)
  }

  for (const edge of extraction.edges) {
    let sourceId = nodeNameToId.get(edge.source_name.toLowerCase())
    let targetId = nodeNameToId.get(edge.target_name.toLowerCase())

    // If source/target not found in this extraction, look up in existing graph
    if (!sourceId) {
      const existing = db
        .query("SELECT id FROM graph_nodes WHERE graph_id = ? AND LOWER(name) = ?")
        .get(graphId, edge.source_name.toLowerCase()) as { id: string } | null
      if (existing) sourceId = existing.id
    }
    if (!targetId) {
      const existing = db
        .query("SELECT id FROM graph_nodes WHERE graph_id = ? AND LOWER(name) = ?")
        .get(graphId, edge.target_name.toLowerCase()) as { id: string } | null
      if (existing) targetId = existing.id
    }

    if (!sourceId || !targetId) continue

    // Check for duplicate edge
    const existingEdge = db
      .query(
        "SELECT id FROM graph_edges WHERE graph_id = ? AND source_node_id = ? AND target_node_id = ? AND name = ?",
      )
      .get(graphId, sourceId, targetId, edge.name) as { id: string } | null

    if (existingEdge) continue

    const edgeId = createEdge(db, graphId, {
      name: edge.name,
      fact: edge.fact,
      source_node_id: sourceId,
      target_node_id: targetId,
      attributes: edge.attributes,
      valid_at: edge.valid_at,
    })
    newEdgeIds.push(edgeId)
    edgesCreated++
  }

  // 5. Generate and store embeddings (if sqlite-vec available)
  if (!options?.skip_embeddings) {
    try {
      const vecLoaded = loadVecExtension(db)
      if (vecLoaded) {
        createVecTables(db)
        await generateAndStoreEmbeddings(db, graphId, newNodeIds, newEdgeIds)
      }
    } catch {
      // Vector search unavailable — FTS5 still works
    }
  }

  // 6. Mark episode as processed and update counts
  db.run(
    "UPDATE graph_episodes SET processed = 1, node_count = ?, edge_count = ? WHERE id = ?",
    [nodesCreated, edgesCreated, episodeId],
  )
  updateGraphCounts(db, graphId)

  return {
    episode_id: episodeId,
    nodes_created: nodesCreated,
    nodes_updated: nodesUpdated,
    edges_created: edgesCreated,
  }
}

export async function ingestBatch(
  db: Database,
  graphId: string,
  texts: string[],
  options?: {
    type?: string
    model?: string
    skip_embeddings?: boolean
  },
): Promise<EpisodeResult[]> {
  const results: EpisodeResult[] = []
  for (const text of texts) {
    const result = await ingestText(db, graphId, text, options)
    results.push(result)
  }
  return results
}

async function generateAndStoreEmbeddings(
  db: Database,
  graphId: string,
  nodeIds: string[],
  edgeIds: string[],
): Promise<void> {
  // Generate node embeddings
  if (nodeIds.length > 0) {
    const nodes = nodeIds
      .map((id) => {
        const row = db.query("SELECT id, name, summary FROM graph_nodes WHERE id = ?").get(id) as {
          id: string
          name: string
          summary: string
        } | null
        return row
      })
      .filter(Boolean) as Array<{ id: string; name: string; summary: string }>

    const texts = nodes.map((n) => `${n.name}: ${n.summary}`)
    if (texts.length > 0) {
      const embeddings = await generateEmbeddings(texts)
      for (let i = 0; i < nodes.length; i++) {
        storeNodeEmbedding(db, nodes[i].id, graphId, embeddings[i])
      }
    }
  }

  // Generate edge embeddings
  if (edgeIds.length > 0) {
    const edges = edgeIds
      .map((id) => {
        const row = db.query("SELECT id, name, fact FROM graph_edges WHERE id = ?").get(id) as {
          id: string
          name: string
          fact: string
        } | null
        return row
      })
      .filter(Boolean) as Array<{ id: string; name: string; fact: string }>

    const texts = edges.map((e) => `${e.name}: ${e.fact}`)
    if (texts.length > 0) {
      const embeddings = await generateEmbeddings(texts)
      for (let i = 0; i < edges.length; i++) {
        storeEdgeEmbedding(db, edges[i].id, graphId, embeddings[i])
      }
    }
  }
}
