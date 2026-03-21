/**
 * LLM-based entity and relationship extraction from text.
 * Uses structured output (JSON mode) with a cheap model for cost efficiency.
 */

import OpenAI from "openai"
import type { ExtractionResult, NodeInput, EdgeInput, OntologyDef } from "./types.ts"

const DEFAULT_MODEL = "gpt-4.1-mini"
const CHUNK_SIZE = 3000
const CHUNK_OVERLAP = 200

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (_client) return _client
  _client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL,
  })
  return _client
}

export function setExtractionClient(client: OpenAI): void {
  _client = client
}

function buildSystemPrompt(ontology?: OntologyDef): string {
  let prompt = `You are an expert entity and relationship extractor. Given text, extract all named entities and relationships between them.

Return valid JSON with this exact schema:
{
  "nodes": [
    {"name": "Entity Name", "labels": ["person"], "summary": "Brief description of this entity based on the text"}
  ],
  "edges": [
    {"name": "RELATIONSHIP_TYPE", "fact": "Natural language description of the relationship", "source_name": "Source Entity", "target_name": "Target Entity"}
  ]
}

Rules:
- Extract people, organizations, locations, events, products, concepts
- Use UPPERCASE_SNAKE_CASE for relationship names (CEO_OF, LOCATED_IN, PARTNERED_WITH, etc.)
- The "fact" field should be a natural language sentence describing the relationship
- Deduplicate: if the same entity appears with different spellings, use the most common form
- Labels should be lowercase: person, organization, location, event, product, concept, technology
- Summary should capture what the text says about this entity, not generic knowledge
- Extract ALL entities and relationships, even minor ones`

  if (ontology?.entity_types?.length) {
    const types = ontology.entity_types.map((t) => t.name).join(", ")
    prompt += `\n\nPreferred entity types: ${types}`
    if (ontology.entity_types.some((t) => t.description)) {
      prompt += "\nType descriptions:"
      for (const t of ontology.entity_types) {
        if (t.description) prompt += `\n- ${t.name}: ${t.description}`
      }
    }
  }

  if (ontology?.edge_types?.length) {
    const types = ontology.edge_types.map((t) => t.name).join(", ")
    prompt += `\n\nPreferred relationship types: ${types}`
  }

  return prompt
}

export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= chunkSize) return [text]

  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start + chunkSize
    if (end < text.length) {
      // Try to break at a sentence or paragraph boundary
      const lastPeriod = text.lastIndexOf(".", end)
      const lastNewline = text.lastIndexOf("\n", end)
      const breakPoint = Math.max(lastPeriod, lastNewline)
      if (breakPoint > start + chunkSize / 2) {
        end = breakPoint + 1
      }
    }
    chunks.push(text.slice(start, end))
    start = end - overlap
  }
  return chunks
}

async function extractFromChunk(
  text: string,
  ontology?: OntologyDef,
  model?: string,
): Promise<ExtractionResult> {
  const client = getClient()
  const response = await client.chat.completions.create({
    model: model ?? DEFAULT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSystemPrompt(ontology) },
      { role: "user", content: text },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  })

  const content = response.choices[0]?.message?.content
  if (!content) return { nodes: [], edges: [] }

  try {
    const parsed = JSON.parse(content)
    const nodes: NodeInput[] = (parsed.nodes ?? []).map((n: Record<string, unknown>) => ({
      name: String(n.name ?? "").trim(),
      labels: Array.isArray(n.labels) ? n.labels.map(String) : [],
      summary: String(n.summary ?? ""),
      attributes: {},
    }))
    const edges: EdgeInput[] = (parsed.edges ?? []).map((e: Record<string, unknown>) => ({
      name: String(e.name ?? "").toUpperCase().replace(/\s+/g, "_"),
      fact: String(e.fact ?? ""),
      source_name: String(e.source_name ?? "").trim(),
      target_name: String(e.target_name ?? "").trim(),
    }))
    return { nodes: nodes.filter((n) => n.name), edges: edges.filter((e) => e.source_name && e.target_name) }
  } catch {
    return { nodes: [], edges: [] }
  }
}

function deduplicateNodes(nodes: NodeInput[]): NodeInput[] {
  const map = new Map<string, NodeInput>()
  for (const node of nodes) {
    const key = node.name.toLowerCase()
    const existing = map.get(key)
    if (existing) {
      // Merge: union labels, keep longer summary, merge attributes
      const labelSet = new Set([...(existing.labels ?? []), ...(node.labels ?? [])])
      existing.labels = [...labelSet]
      if ((node.summary?.length ?? 0) > (existing.summary?.length ?? 0)) {
        existing.summary = node.summary
      }
      existing.attributes = { ...(existing.attributes ?? {}), ...(node.attributes ?? {}) }
    } else {
      map.set(key, { ...node })
    }
  }
  return [...map.values()]
}

function deduplicateEdges(edges: EdgeInput[]): EdgeInput[] {
  const map = new Map<string, EdgeInput>()
  for (const edge of edges) {
    const key = `${edge.source_name.toLowerCase()}|${edge.name}|${edge.target_name.toLowerCase()}`
    if (!map.has(key)) {
      map.set(key, edge)
    } else {
      // Keep the one with the longer fact
      const existing = map.get(key)!
      if (edge.fact.length > existing.fact.length) {
        map.set(key, edge)
      }
    }
  }
  return [...map.values()]
}

export async function extractEntities(
  text: string,
  options?: {
    ontology?: OntologyDef
    model?: string
    chunk_size?: number
  },
): Promise<ExtractionResult> {
  const chunks = chunkText(text, options?.chunk_size ?? CHUNK_SIZE)

  // Process chunks (sequentially to respect rate limits; could parallelize for speed)
  const allNodes: NodeInput[] = []
  const allEdges: EdgeInput[] = []

  for (const chunk of chunks) {
    const result = await extractFromChunk(chunk, options?.ontology, options?.model)
    allNodes.push(...result.nodes)
    allEdges.push(...result.edges)
  }

  return {
    nodes: deduplicateNodes(allNodes),
    edges: deduplicateEdges(allEdges),
  }
}
