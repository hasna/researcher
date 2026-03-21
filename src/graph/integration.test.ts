/**
 * Integration test for graph module.
 * Tests the full pipeline with mocked LLM extraction.
 * Run with: bun test src/graph/integration.test.ts
 *
 * For real LLM tests, set OPENAI_API_KEY and run with:
 *   GRAPH_INTEGRATION=1 bun test src/graph/integration.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "../db/schema.ts"
import { createGraph, getGraph } from "./graph.ts"
import { upsertNode, getNodesByGraph, getNodesByLabel, getNodeEdges } from "./nodes.ts"
import { createEdge, getEdgesByGraph } from "./edges.ts"
import { searchGraph } from "./search.ts"
import { chunkText } from "./extract.ts"
import { updateGraphCounts } from "./graph.ts"

let db: Database

beforeEach(() => {
  db = new Database(":memory:")
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA_SQL)
})

describe("Full pipeline simulation (mocked extraction)", () => {
  test("ingest article → entities → relationships → search", async () => {
    // 1. Create graph
    const graphId = createGraph(db, {
      name: "test-article-graph",
      description: "Testing MiroFish-compatible pipeline",
      ontology: {
        entity_types: [
          { name: "person" },
          { name: "organization" },
          { name: "technology" },
        ],
      },
    })

    // 2. Simulate extracted entities (what the LLM would return)
    const entities = [
      { name: "Tim Cook", labels: ["person"], summary: "CEO of Apple, announced partnership with NVIDIA at GTC 2026" },
      { name: "Jensen Huang", labels: ["person"], summary: "CEO of NVIDIA, presented NemoClaw at GTC 2026" },
      { name: "Apple", labels: ["organization"], summary: "Technology company led by Tim Cook" },
      { name: "NVIDIA", labels: ["organization"], summary: "GPU and AI company led by Jensen Huang" },
      { name: "NemoClaw", labels: ["technology"], summary: "Open-source security stack for OpenClaw AI agents" },
      { name: "GTC 2026", labels: ["event"], summary: "NVIDIA's GPU Technology Conference held in March 2026" },
    ]

    // 3. Upsert nodes
    const nodeIds = new Map<string, string>()
    for (const e of entities) {
      const result = upsertNode(db, graphId, e)
      nodeIds.set(e.name, result.id)
      expect(result.created).toBe(true)
    }

    // 4. Create edges
    createEdge(db, graphId, {
      name: "CEO_OF",
      fact: "Tim Cook is the CEO of Apple",
      source_node_id: nodeIds.get("Tim Cook")!,
      target_node_id: nodeIds.get("Apple")!,
    })
    createEdge(db, graphId, {
      name: "CEO_OF",
      fact: "Jensen Huang is the CEO of NVIDIA",
      source_node_id: nodeIds.get("Jensen Huang")!,
      target_node_id: nodeIds.get("NVIDIA")!,
    })
    createEdge(db, graphId, {
      name: "PARTNERED_WITH",
      fact: "Apple announced a partnership with NVIDIA at GTC 2026",
      source_node_id: nodeIds.get("Apple")!,
      target_node_id: nodeIds.get("NVIDIA")!,
    })
    createEdge(db, graphId, {
      name: "PRESENTED_AT",
      fact: "Jensen Huang presented NemoClaw at GTC 2026",
      source_node_id: nodeIds.get("Jensen Huang")!,
      target_node_id: nodeIds.get("GTC 2026")!,
    })
    createEdge(db, graphId, {
      name: "DEVELOPED_BY",
      fact: "NemoClaw was developed by NVIDIA as an open-source security stack",
      source_node_id: nodeIds.get("NemoClaw")!,
      target_node_id: nodeIds.get("NVIDIA")!,
    })

    updateGraphCounts(db, graphId)

    // 5. Verify graph stats
    const graph = getGraph(db, graphId)!
    expect(graph.node_count).toBe(6)
    expect(graph.edge_count).toBe(5)

    // 6. Search by keyword
    const searchResult = await searchGraph(db, graphId, "NVIDIA CEO")
    expect(searchResult.nodes.length).toBeGreaterThan(0)
    const nvidiaNnames = searchResult.nodes.map((n) => n.name)
    expect(nvidiaNnames.some((n) => n === "NVIDIA" || n === "Jensen Huang")).toBe(true)

    // 7. Search for facts
    const factResult = await searchGraph(db, graphId, "partnership", { scope: "edges" })
    expect(factResult.facts.length).toBeGreaterThan(0)
    expect(factResult.facts.some((f) => f.includes("partnership"))).toBe(true)

    // 8. Filter by label
    const people = getNodesByLabel(db, graphId, "person")
    expect(people.length).toBe(2)
    expect(people.map((p) => p.name).sort()).toEqual(["Jensen Huang", "Tim Cook"])

    const orgs = getNodesByLabel(db, graphId, "organization")
    expect(orgs.length).toBe(2)

    // 9. Get node edges (like Zep's get_entity_edges)
    const jensenEdges = getNodeEdges(db, nodeIds.get("Jensen Huang")!)
    expect(jensenEdges.length).toBe(2) // CEO_OF + PRESENTED_AT

    // 10. Pagination
    const page1 = getNodesByGraph(db, graphId, { limit: 3 })
    expect(page1.items.length).toBe(3)
    expect(page1.next_cursor).toBeTruthy()

    const page2 = getNodesByGraph(db, graphId, { limit: 3, cursor: page1.next_cursor! })
    expect(page2.items.length).toBe(3)
    expect(page2.next_cursor).toBeNull()
  })

  test("entity merging across multiple ingestions", () => {
    const graphId = createGraph(db, { name: "merge-test" })

    // First ingestion
    const r1 = upsertNode(db, graphId, {
      name: "NVIDIA",
      labels: ["organization"],
      summary: "GPU company",
    })
    expect(r1.created).toBe(true)

    // Second ingestion — same entity, more info
    const r2 = upsertNode(db, graphId, {
      name: "NVIDIA",
      labels: ["organization", "technology"],
      summary: "GPU and AI company led by Jensen Huang, maker of NemoClaw and Nemotron models",
    })
    expect(r2.created).toBe(false)
    expect(r2.id).toBe(r1.id) // Same node

    // Verify merge
    const nodes = getNodesByGraph(db, graphId)
    expect(nodes.items.length).toBe(1)
    const nvidia = nodes.items[0]
    expect(nvidia.labels).toContain("organization")
    expect(nvidia.labels).toContain("technology")
    // Longer summary should win
    expect(nvidia.summary).toContain("Jensen Huang")
  })

  test("cross-graph isolation", async () => {
    const g1 = createGraph(db, { name: "graph-1" })
    const g2 = createGraph(db, { name: "graph-2" })

    upsertNode(db, g1, { name: "Apple", labels: ["org"], summary: "Tech company" })
    upsertNode(db, g2, { name: "Apple", labels: ["fruit"], summary: "A fruit" })

    const g1Nodes = getNodesByGraph(db, g1)
    const g2Nodes = getNodesByGraph(db, g2)
    expect(g1Nodes.items.length).toBe(1)
    expect(g2Nodes.items.length).toBe(1)
    expect(g1Nodes.items[0].labels).toContain("org")
    expect(g2Nodes.items[0].labels).toContain("fruit")

    // Search is scoped
    const r1 = await searchGraph(db, g1, "Apple")
    const r2 = await searchGraph(db, g2, "Apple")
    expect(r1.nodes[0].labels).toContain("org")
    expect(r2.nodes[0].labels).toContain("fruit")
  })

  test("temporal edges", () => {
    const graphId = createGraph(db, { name: "temporal-test" })
    const n1 = upsertNode(db, graphId, { name: "Entity A" })
    const n2 = upsertNode(db, graphId, { name: "Entity B" })

    const edgeId = createEdge(db, graphId, {
      name: "WORKS_FOR",
      fact: "Entity A works for Entity B since 2020",
      source_node_id: n1.id,
      target_node_id: n2.id,
      valid_at: "2020-01-01",
    })

    const edges = getEdgesByGraph(db, graphId)
    expect(edges.items.length).toBe(1)
    expect(edges.items[0].valid_at).toBe("2020-01-01")
    expect(edges.items[0].expired_at).toBeNull()
  })
})

describe("Text chunking for large documents", () => {
  test("handles large document", () => {
    const longText = "This is a sentence about AI. ".repeat(200) // ~5800 chars
    const chunks = chunkText(longText, 1000, 100)
    expect(chunks.length).toBeGreaterThan(1)
    // All text should be covered
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1100) // chunk_size + some boundary overflow
    }
  })
})

// Real LLM integration test — only runs with GRAPH_INTEGRATION=1
if (process.env.GRAPH_INTEGRATION === "1") {
  const { ingestText } = await import("./ingest.ts")

  describe("Real LLM integration", () => {
    test("ingest real text and extract entities", async () => {
      const db = new Database(":memory:")
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA foreign_keys = ON")
      db.exec(SCHEMA_SQL)

      const graphId = createGraph(db, { name: "real-test" })
      const result = await ingestText(db, graphId,
        "Apple CEO Tim Cook announced a partnership with NVIDIA's Jensen Huang at GTC 2026. " +
        "NVIDIA unveiled NemoClaw, an open-source security stack for AI agents. " +
        "The partnership will integrate Apple Silicon with NVIDIA's Nemotron models.",
        { skip_embeddings: true },
      )

      expect(result.nodes_created).toBeGreaterThan(0)
      expect(result.edges_created).toBeGreaterThan(0)

      const graph = getGraph(db, graphId)!
      expect(graph.node_count).toBeGreaterThan(0)
      console.log(`Real LLM: ${graph.node_count} nodes, ${graph.edge_count} edges`)
    }, 30000)
  })
}
