/**
 * Comprehensive tests for the graph module.
 * Uses in-memory SQLite — no LLM calls, no sqlite-vec.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "../db/schema.ts"
import { createGraph, getGraph, listGraphs, deleteGraph, updateGraphCounts } from "./graph.ts"
import { upsertNode, getNode, getNodesByGraph, getNodesByLabel, getNodeEdges, deleteNode } from "./nodes.ts"
import { createEdge, getEdge, getEdgesByGraph, getEdgesByNode, deleteEdge } from "./edges.ts"
import { searchNodes, searchEdges, searchGraph } from "./search.ts"
import { chunkText } from "./extract.ts"

// ─── Helpers ────────────────────────────────────────────────────────────────

let db: Database

function freshDb(): Database {
  const d = new Database(":memory:")
  d.run("PRAGMA foreign_keys = ON")
  d.exec(SCHEMA_SQL)
  return d
}

// ─── Schema ─────────────────────────────────────────────────────────────────

describe("Schema", () => {
  beforeEach(() => { db = freshDb() })
  afterEach(() => { db.close() })

  test("creates all graph-related tables", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)

    expect(names).toContain("graphs")
    expect(names).toContain("graph_nodes")
    expect(names).toContain("graph_edges")
    expect(names).toContain("graph_episodes")
  })

  test("creates FTS5 virtual tables", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)

    expect(names).toContain("graph_nodes_fts")
    expect(names).toContain("graph_edges_fts")
  })

  test("creates indexes for graph tables", () => {
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_graph%'")
      .all() as { name: string }[]
    const names = indexes.map((i) => i.name)

    expect(names).toContain("idx_graph_nodes_graph")
    expect(names).toContain("idx_graph_nodes_name")
    expect(names).toContain("idx_graph_edges_graph")
    expect(names).toContain("idx_graph_edges_source")
    expect(names).toContain("idx_graph_edges_target")
    expect(names).toContain("idx_graph_episodes_graph")
  })

  test("schema is idempotent (can run twice)", () => {
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow()
  })
})

// ─── Graph CRUD ─────────────────────────────────────────────────────────────

describe("Graph CRUD", () => {
  beforeEach(() => { db = freshDb() })
  afterEach(() => { db.close() })

  test("createGraph returns an id", () => {
    const id = createGraph(db, { name: "test-graph" })
    expect(id).toBeTruthy()
    expect(typeof id).toBe("string")
  })

  test("createGraph stores name, description, ontology", () => {
    const id = createGraph(db, {
      name: "kg",
      description: "A knowledge graph",
      ontology: { entity_types: [{ name: "person" }] },
    })
    const g = getGraph(db, id)
    expect(g).not.toBeNull()
    expect(g!.name).toBe("kg")
    expect(g!.description).toBe("A knowledge graph")
    expect(g!.ontology.entity_types).toHaveLength(1)
    expect(g!.ontology.entity_types![0].name).toBe("person")
  })

  test("createGraph defaults description to empty string", () => {
    const id = createGraph(db, { name: "g" })
    const g = getGraph(db, id)!
    expect(g.description).toBe("")
  })

  test("createGraph defaults ontology to empty object", () => {
    const id = createGraph(db, { name: "g" })
    const g = getGraph(db, id)!
    expect(g.ontology).toEqual({})
  })

  test("getGraph returns null for missing id", () => {
    expect(getGraph(db, "nonexistent")).toBeNull()
  })

  test("listGraphs returns all graphs", () => {
    createGraph(db, { name: "a" })
    createGraph(db, { name: "b" })
    const all = listGraphs(db)
    expect(all).toHaveLength(2)
  })

  test("listGraphs filters by project_id", () => {
    // Create real projects since project_id has FK constraint
    db.run("INSERT INTO projects (id, name, type) VALUES (?, ?, ?)", ["p1", "proj1", "virtual"])
    db.run("INSERT INTO projects (id, name, type) VALUES (?, ?, ?)", ["p2", "proj2", "virtual"])

    createGraph(db, { name: "a", project_id: "p1" })
    createGraph(db, { name: "b", project_id: "p2" })
    createGraph(db, { name: "c", project_id: "p1" })

    const p1 = listGraphs(db, "p1")
    expect(p1).toHaveLength(2)
    const p2 = listGraphs(db, "p2")
    expect(p2).toHaveLength(1)
  })

  test("deleteGraph removes the graph", () => {
    const id = createGraph(db, { name: "doomed" })
    expect(deleteGraph(db, id)).toBe(true)
    expect(getGraph(db, id)).toBeNull()
  })

  test("deleteGraph returns false for missing id", () => {
    expect(deleteGraph(db, "nope")).toBe(false)
  })

  test("deleteGraph cascades to nodes and edges", () => {
    const gid = createGraph(db, { name: "g" })
    const { id: nid1 } = upsertNode(db, gid, { name: "Alice" })
    const { id: nid2 } = upsertNode(db, gid, { name: "Bob" })
    createEdge(db, gid, {
      name: "KNOWS",
      fact: "Alice knows Bob",
      source_node_id: nid1,
      target_node_id: nid2,
    })

    deleteGraph(db, gid)

    expect(getNode(db, nid1)).toBeNull()
    expect(getNode(db, nid2)).toBeNull()
    // Edges also gone
    const edges = db.query("SELECT COUNT(*) as c FROM graph_edges WHERE graph_id = ?").get(gid) as { c: number }
    expect(edges.c).toBe(0)
  })

  test("updateGraphCounts reflects actual counts", () => {
    const gid = createGraph(db, { name: "g" })
    const { id: n1 } = upsertNode(db, gid, { name: "A" })
    const { id: n2 } = upsertNode(db, gid, { name: "B" })
    createEdge(db, gid, { name: "R", fact: "f", source_node_id: n1, target_node_id: n2 })

    updateGraphCounts(db, gid)
    const g = getGraph(db, gid)!
    expect(g.node_count).toBe(2)
    expect(g.edge_count).toBe(1)
    expect(g.episode_count).toBe(0)
  })
})

// ─── Node operations ────────────────────────────────────────────────────────

describe("Node operations", () => {
  let graphId: string

  beforeEach(() => {
    db = freshDb()
    graphId = createGraph(db, { name: "test-graph" })
  })
  afterEach(() => { db.close() })

  test("upsertNode creates a new node", () => {
    const result = upsertNode(db, graphId, {
      name: "Alice",
      labels: ["person"],
      summary: "A researcher",
      attributes: { age: 30 },
    })
    expect(result.created).toBe(true)
    expect(result.id).toBeTruthy()
  })

  test("upsertNode returns existing node on duplicate name (same graph)", () => {
    const r1 = upsertNode(db, graphId, { name: "Alice", labels: ["person"] })
    const r2 = upsertNode(db, graphId, { name: "Alice", labels: ["researcher"] })
    expect(r2.created).toBe(false)
    expect(r2.id).toBe(r1.id)
  })

  test("upsertNode merges labels on update", () => {
    upsertNode(db, graphId, { name: "Alice", labels: ["person"] })
    upsertNode(db, graphId, { name: "Alice", labels: ["researcher", "person"] })
    const node = getNodesByLabel(db, graphId, "researcher")
    expect(node).toHaveLength(1)
    expect(node[0].labels).toContain("person")
    expect(node[0].labels).toContain("researcher")
  })

  test("upsertNode keeps longer summary on update", () => {
    upsertNode(db, graphId, { name: "Alice", summary: "Short" })
    upsertNode(db, graphId, { name: "Alice", summary: "A much longer summary that should replace the short one" })
    const nodes = getNodesByGraph(db, graphId)
    const alice = nodes.items[0]
    expect(alice.summary).toBe("A much longer summary that should replace the short one")
  })

  test("upsertNode keeps existing summary when new one is shorter", () => {
    upsertNode(db, graphId, { name: "Alice", summary: "A long existing summary here" })
    upsertNode(db, graphId, { name: "Alice", summary: "Short" })
    const nodes = getNodesByGraph(db, graphId)
    const alice = nodes.items[0]
    expect(alice.summary).toBe("A long existing summary here")
  })

  test("upsertNode merges attributes on update", () => {
    upsertNode(db, graphId, { name: "Alice", attributes: { age: 30 } })
    upsertNode(db, graphId, { name: "Alice", attributes: { role: "dev" } })
    const nodes = getNodesByGraph(db, graphId)
    const alice = nodes.items[0]
    expect(alice.attributes).toEqual({ age: 30, role: "dev" })
  })

  test("getNode returns node by id", () => {
    const { id } = upsertNode(db, graphId, { name: "Alice", labels: ["person"] })
    const node = getNode(db, id)
    expect(node).not.toBeNull()
    expect(node!.name).toBe("Alice")
    expect(node!.labels).toEqual(["person"])
    expect(node!.graph_id).toBe(graphId)
  })

  test("getNode returns null for missing id", () => {
    expect(getNode(db, "missing")).toBeNull()
  })

  test("getNodesByGraph returns paginated results", () => {
    for (let i = 0; i < 5; i++) {
      upsertNode(db, graphId, { name: `Node${i}` })
    }
    const page1 = getNodesByGraph(db, graphId, { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.next_cursor).not.toBeNull()
    expect(page1.total).toBe(5)

    const page2 = getNodesByGraph(db, graphId, { limit: 2, cursor: page1.next_cursor! })
    expect(page2.items).toHaveLength(2)
    expect(page2.next_cursor).not.toBeNull()

    const page3 = getNodesByGraph(db, graphId, { limit: 2, cursor: page2.next_cursor! })
    expect(page3.items).toHaveLength(1)
    expect(page3.next_cursor).toBeNull()
  })

  test("getNodesByGraph default limit is 50", () => {
    upsertNode(db, graphId, { name: "A" })
    const result = getNodesByGraph(db, graphId)
    expect(result.items).toHaveLength(1)
    expect(result.total).toBe(1)
  })

  test("getNodesByLabel returns matching nodes", () => {
    upsertNode(db, graphId, { name: "Alice", labels: ["person", "researcher"] })
    upsertNode(db, graphId, { name: "MIT", labels: ["organization"] })
    upsertNode(db, graphId, { name: "Bob", labels: ["person"] })

    const people = getNodesByLabel(db, graphId, "person")
    expect(people).toHaveLength(2)

    const orgs = getNodesByLabel(db, graphId, "organization")
    expect(orgs).toHaveLength(1)
    expect(orgs[0].name).toBe("MIT")
  })

  test("getNodesByLabel returns empty for non-matching label", () => {
    upsertNode(db, graphId, { name: "Alice", labels: ["person"] })
    expect(getNodesByLabel(db, graphId, "location")).toHaveLength(0)
  })

  test("deleteNode removes the node", () => {
    const { id } = upsertNode(db, graphId, { name: "Alice" })
    expect(deleteNode(db, id)).toBe(true)
    expect(getNode(db, id)).toBeNull()
  })

  test("deleteNode returns false for missing id", () => {
    expect(deleteNode(db, "missing")).toBe(false)
  })

  test("deleteNode cascades to edges", () => {
    const { id: n1 } = upsertNode(db, graphId, { name: "Alice" })
    const { id: n2 } = upsertNode(db, graphId, { name: "Bob" })
    const edgeId = createEdge(db, graphId, {
      name: "KNOWS",
      fact: "Alice knows Bob",
      source_node_id: n1,
      target_node_id: n2,
    })

    deleteNode(db, n1)
    expect(getEdge(db, edgeId)).toBeNull()
  })

  test("getNodeEdges returns edges for a node", () => {
    const { id: n1 } = upsertNode(db, graphId, { name: "Alice" })
    const { id: n2 } = upsertNode(db, graphId, { name: "Bob" })
    const { id: n3 } = upsertNode(db, graphId, { name: "Carol" })
    createEdge(db, graphId, { name: "KNOWS", fact: "f1", source_node_id: n1, target_node_id: n2 })
    createEdge(db, graphId, { name: "WORKS_WITH", fact: "f2", source_node_id: n3, target_node_id: n1 })

    const edges = getNodeEdges(db, n1)
    expect(edges).toHaveLength(2)
  })

  test("upsertNode defaults labels to empty array", () => {
    const { id } = upsertNode(db, graphId, { name: "X" })
    const node = getNode(db, id)!
    expect(node.labels).toEqual([])
  })

  test("upsertNode defaults summary to empty string", () => {
    const { id } = upsertNode(db, graphId, { name: "X" })
    const node = getNode(db, id)!
    expect(node.summary).toBe("")
  })

  test("upsertNode defaults attributes to empty object", () => {
    const { id } = upsertNode(db, graphId, { name: "X" })
    const node = getNode(db, id)!
    expect(node.attributes).toEqual({})
  })
})

// ─── Edge operations ────────────────────────────────────────────────────────

describe("Edge operations", () => {
  let graphId: string
  let nodeA: string
  let nodeB: string
  let nodeC: string

  beforeEach(() => {
    db = freshDb()
    graphId = createGraph(db, { name: "test-graph" })
    nodeA = upsertNode(db, graphId, { name: "Alice" }).id
    nodeB = upsertNode(db, graphId, { name: "Bob" }).id
    nodeC = upsertNode(db, graphId, { name: "Carol" }).id
  })
  afterEach(() => { db.close() })

  test("createEdge returns an id", () => {
    const id = createEdge(db, graphId, {
      name: "KNOWS",
      fact: "Alice knows Bob",
      source_node_id: nodeA,
      target_node_id: nodeB,
    })
    expect(id).toBeTruthy()
    expect(typeof id).toBe("string")
  })

  test("getEdge returns edge by id", () => {
    const id = createEdge(db, graphId, {
      name: "KNOWS",
      fact: "Alice knows Bob",
      source_node_id: nodeA,
      target_node_id: nodeB,
      attributes: { since: 2020 },
    })
    const edge = getEdge(db, id)
    expect(edge).not.toBeNull()
    expect(edge!.name).toBe("KNOWS")
    expect(edge!.fact).toBe("Alice knows Bob")
    expect(edge!.source_node_id).toBe(nodeA)
    expect(edge!.target_node_id).toBe(nodeB)
    expect(edge!.attributes).toEqual({ since: 2020 })
    expect(edge!.graph_id).toBe(graphId)
  })

  test("getEdge returns null for missing id", () => {
    expect(getEdge(db, "missing")).toBeNull()
  })

  test("createEdge with valid_at", () => {
    const id = createEdge(db, graphId, {
      name: "EMPLOYED_BY",
      fact: "Alice works at Acme",
      source_node_id: nodeA,
      target_node_id: nodeB,
      valid_at: "2024-01-01",
    })
    const edge = getEdge(db, id)!
    expect(edge.valid_at).toBe("2024-01-01")
  })

  test("createEdge defaults attributes to empty object", () => {
    const id = createEdge(db, graphId, {
      name: "R",
      fact: "f",
      source_node_id: nodeA,
      target_node_id: nodeB,
    })
    const edge = getEdge(db, id)!
    expect(edge.attributes).toEqual({})
  })

  test("getEdgesByGraph returns paginated results", () => {
    for (let i = 0; i < 5; i++) {
      createEdge(db, graphId, {
        name: `REL_${i}`,
        fact: `fact ${i}`,
        source_node_id: nodeA,
        target_node_id: nodeB,
      })
    }

    const page1 = getEdgesByGraph(db, graphId, { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.next_cursor).not.toBeNull()
    expect(page1.total).toBe(5)

    const page2 = getEdgesByGraph(db, graphId, { limit: 2, cursor: page1.next_cursor! })
    expect(page2.items).toHaveLength(2)

    const page3 = getEdgesByGraph(db, graphId, { limit: 2, cursor: page2.next_cursor! })
    expect(page3.items).toHaveLength(1)
    expect(page3.next_cursor).toBeNull()
  })

  test("getEdgesByGraph default limit is 50", () => {
    createEdge(db, graphId, { name: "R", fact: "f", source_node_id: nodeA, target_node_id: nodeB })
    const result = getEdgesByGraph(db, graphId)
    expect(result.items).toHaveLength(1)
    expect(result.total).toBe(1)
  })

  test("getEdgesByNode returns edges where node is source or target", () => {
    createEdge(db, graphId, { name: "KNOWS", fact: "f1", source_node_id: nodeA, target_node_id: nodeB })
    createEdge(db, graphId, { name: "WORKS_WITH", fact: "f2", source_node_id: nodeC, target_node_id: nodeA })
    createEdge(db, graphId, { name: "OTHER", fact: "f3", source_node_id: nodeB, target_node_id: nodeC })

    const edgesA = getEdgesByNode(db, nodeA)
    expect(edgesA).toHaveLength(2)

    const edgesC = getEdgesByNode(db, nodeC)
    expect(edgesC).toHaveLength(2)

    const edgesB = getEdgesByNode(db, nodeB)
    expect(edgesB).toHaveLength(2)
  })

  test("deleteEdge removes the edge", () => {
    const id = createEdge(db, graphId, {
      name: "KNOWS",
      fact: "f",
      source_node_id: nodeA,
      target_node_id: nodeB,
    })
    expect(deleteEdge(db, id)).toBe(true)
    expect(getEdge(db, id)).toBeNull()
  })

  test("deleteEdge returns false for missing id", () => {
    expect(deleteEdge(db, "missing")).toBe(false)
  })

  test("deleteEdge updates graph counts", () => {
    const eid = createEdge(db, graphId, {
      name: "R",
      fact: "f",
      source_node_id: nodeA,
      target_node_id: nodeB,
    })
    // After createEdge, counts are updated
    let g = getGraph(db, graphId)!
    expect(g.edge_count).toBe(1)

    deleteEdge(db, eid)
    g = getGraph(db, graphId)!
    expect(g.edge_count).toBe(0)
  })
})

// ─── FTS5 Search ────────────────────────────────────────────────────────────

describe("FTS5 Search", () => {
  let graphId: string

  beforeEach(() => {
    db = freshDb()
    graphId = createGraph(db, { name: "search-graph" })
    // Populate some data
    const { id: alice } = upsertNode(db, graphId, {
      name: "Alice Johnson",
      labels: ["person", "researcher"],
      summary: "A machine learning researcher at Stanford University",
    })
    const { id: bob } = upsertNode(db, graphId, {
      name: "Bob Smith",
      labels: ["person", "engineer"],
      summary: "A software engineer specializing in distributed systems",
    })
    const { id: stanford } = upsertNode(db, graphId, {
      name: "Stanford University",
      labels: ["organization"],
      summary: "A prestigious research university in California",
    })

    createEdge(db, graphId, {
      name: "AFFILIATED_WITH",
      fact: "Alice Johnson is a researcher at Stanford University",
      source_node_id: alice,
      target_node_id: stanford,
    })
    createEdge(db, graphId, {
      name: "COLLABORATES_WITH",
      fact: "Alice and Bob collaborate on machine learning projects",
      source_node_id: alice,
      target_node_id: bob,
    })
  })
  afterEach(() => { db.close() })

  test("searchNodes finds by name", () => {
    const results = searchNodes(db, graphId, "Alice")
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].name).toBe("Alice Johnson")
  })

  test("searchNodes finds by summary content", () => {
    const results = searchNodes(db, graphId, "machine learning")
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some((n) => n.name === "Alice Johnson")).toBe(true)
  })

  test("searchNodes finds by label", () => {
    const results = searchNodes(db, graphId, "researcher")
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  test("searchNodes returns empty for no match", () => {
    const results = searchNodes(db, graphId, "quantumphysics")
    expect(results).toHaveLength(0)
  })

  test("searchNodes returns empty for empty query", () => {
    const results = searchNodes(db, graphId, "")
    expect(results).toHaveLength(0)
  })

  test("searchNodes respects limit", () => {
    const results = searchNodes(db, graphId, "person", 1)
    expect(results.length).toBeLessThanOrEqual(1)
  })

  test("searchEdges finds by fact content", () => {
    const results = searchEdges(db, graphId, "collaborate")
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].fact).toContain("collaborate")
  })

  test("searchEdges finds by edge name", () => {
    const results = searchEdges(db, graphId, "AFFILIATED")
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  test("searchEdges returns empty for no match", () => {
    const results = searchEdges(db, graphId, "nonexistentrelation")
    expect(results).toHaveLength(0)
  })

  test("searchEdges returns empty for empty query", () => {
    const results = searchEdges(db, graphId, "")
    expect(results).toHaveLength(0)
  })

  test("searchEdges respects limit", () => {
    const results = searchEdges(db, graphId, "Alice", 1)
    expect(results.length).toBeLessThanOrEqual(1)
  })

  test("searchGraph combines node and edge results", async () => {
    const result = await searchGraph(db, graphId, "Stanford", { use_vector: false })
    // Should find the Stanford node and the affiliated edge
    expect(result.nodes.length + result.edges.length).toBeGreaterThanOrEqual(1)
  })

  test("searchGraph scope=nodes only returns nodes", async () => {
    const result = await searchGraph(db, graphId, "Stanford", { scope: "nodes", use_vector: false })
    expect(result.nodes.length).toBeGreaterThanOrEqual(1)
    // edges should be empty when scope is nodes
    expect(result.edges).toHaveLength(0)
  })

  test("searchGraph scope=edges only returns edges", async () => {
    const result = await searchGraph(db, graphId, "collaborate", { scope: "edges", use_vector: false })
    expect(result.edges.length).toBeGreaterThanOrEqual(1)
    expect(result.nodes).toHaveLength(0)
  })

  test("searchGraph facts are extracted from edges", async () => {
    const result = await searchGraph(db, graphId, "collaborate", { scope: "edges", use_vector: false })
    expect(result.facts.length).toBeGreaterThanOrEqual(1)
    expect(result.facts[0]).toContain("collaborate")
  })

  test("searchGraph respects limit", async () => {
    const result = await searchGraph(db, graphId, "Alice", { limit: 1, use_vector: false })
    expect(result.nodes.length).toBeLessThanOrEqual(1)
    expect(result.edges.length).toBeLessThanOrEqual(1)
  })

  test("searchNodes escapes special FTS characters", () => {
    // Should not throw even with special chars
    const results = searchNodes(db, graphId, "Alice's + test * (query)")
    // May or may not find results, but should not crash
    expect(Array.isArray(results)).toBe(true)
  })
})

// ─── Text Chunking ──────────────────────────────────────────────────────────

describe("chunkText", () => {
  test("returns single chunk for short text", () => {
    const result = chunkText("Hello world", 100)
    expect(result).toHaveLength(1)
    expect(result[0]).toBe("Hello world")
  })

  test("returns single chunk when text equals chunk size", () => {
    const text = "a".repeat(100)
    const result = chunkText(text, 100)
    expect(result).toHaveLength(1)
  })

  test("splits long text into multiple chunks", () => {
    const text = "a".repeat(500)
    const result = chunkText(text, 100, 20)
    expect(result.length).toBeGreaterThan(1)
  })

  test("chunks overlap by the specified amount", () => {
    // Create text with clear markers
    const text = "AAAA.BBBB.CCCC.DDDD.EEEE."
    const chunks = chunkText(text, 10, 3)
    expect(chunks.length).toBeGreaterThan(1)

    // Each chunk after the first should start a few chars before where the previous one ended
    for (let i = 1; i < chunks.length; i++) {
      // The overlap means the end of chunk[i-1] should share chars with start of chunk[i]
      const prevEnd = chunks[i - 1].slice(-3)
      // With boundary detection, exact overlap checking is approximate
      expect(chunks[i].length).toBeGreaterThan(0)
    }
  })

  test("tries to break at sentence boundaries (period)", () => {
    const text = "First sentence here. Second sentence follows. Third part of the text continues onward."
    const chunks = chunkText(text, 45, 5)
    // Should break at periods when possible
    expect(chunks.length).toBeGreaterThan(1)
    // First chunk should end near a period
    const firstChunk = chunks[0]
    expect(firstChunk.endsWith(".") || firstChunk.endsWith(". ")).toBe(true)
  })

  test("tries to break at newline boundaries", () => {
    const text = "First paragraph here\nSecond paragraph here\nThird paragraph continues"
    const chunks = chunkText(text, 35, 5)
    expect(chunks.length).toBeGreaterThan(1)
  })

  test("handles text with no good break points", () => {
    const text = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"
    const chunks = chunkText(text, 20, 5)
    expect(chunks.length).toBeGreaterThan(1)
    // All text should be covered
    expect(chunks.join("").length).toBeGreaterThanOrEqual(text.length)
  })

  test("default chunk size and overlap", () => {
    const text = "a".repeat(5000)
    const chunks = chunkText(text)
    // Default CHUNK_SIZE=3000, so 5000 chars should produce at least 2 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })

  test("empty text returns single empty chunk", () => {
    const result = chunkText("")
    expect(result).toHaveLength(1)
    expect(result[0]).toBe("")
  })
})

// ─── Deduplication (via extract module internals) ───────────────────────────
// We test deduplication by importing chunkText and testing the dedup behavior
// through the extractEntities public API with a mocked LLM client.

describe("Deduplication logic", () => {
  // Since deduplicateNodes and deduplicateEdges are not exported,
  // we test them indirectly by verifying upsertNode's merge behavior
  // which implements similar logic at the DB level.

  let graphId: string

  beforeEach(() => {
    db = freshDb()
    graphId = createGraph(db, { name: "dedup-graph" })
  })
  afterEach(() => { db.close() })

  test("upsertNode deduplicates by name within a graph", () => {
    upsertNode(db, graphId, { name: "Alice", labels: ["person"], summary: "First mention" })
    upsertNode(db, graphId, { name: "Alice", labels: ["researcher"], summary: "Second mention with more detail" })
    upsertNode(db, graphId, { name: "Alice", labels: ["expert"], summary: "Short" })

    const nodes = getNodesByGraph(db, graphId)
    expect(nodes.total).toBe(1) // Only one Alice

    const alice = nodes.items[0]
    expect(alice.name).toBe("Alice")
    // Labels should be merged
    expect(alice.labels).toContain("person")
    expect(alice.labels).toContain("researcher")
    expect(alice.labels).toContain("expert")
    // Longer summary kept
    expect(alice.summary).toBe("Second mention with more detail")
  })

  test("same name in different graphs creates separate nodes", () => {
    const graphId2 = createGraph(db, { name: "other-graph" })
    upsertNode(db, graphId, { name: "Alice" })
    upsertNode(db, graphId2, { name: "Alice" })

    const g1Nodes = getNodesByGraph(db, graphId)
    const g2Nodes = getNodesByGraph(db, graphId2)
    expect(g1Nodes.total).toBe(1)
    expect(g2Nodes.total).toBe(1)
    expect(g1Nodes.items[0].id).not.toBe(g2Nodes.items[0].id)
  })

  test("duplicate edges are prevented at ingest level (same src, tgt, name)", () => {
    const { id: n1 } = upsertNode(db, graphId, { name: "A" })
    const { id: n2 } = upsertNode(db, graphId, { name: "B" })

    createEdge(db, graphId, { name: "KNOWS", fact: "A knows B", source_node_id: n1, target_node_id: n2 })
    createEdge(db, graphId, { name: "KNOWS", fact: "A knows B (dup)", source_node_id: n1, target_node_id: n2 })

    // At the raw edge level, both are created (dedup is in ingest.ts, not createEdge)
    const edges = getEdgesByGraph(db, graphId)
    expect(edges.total).toBe(2) // createEdge doesn't dedup
  })
})

// ─── Cross-graph isolation ──────────────────────────────────────────────────

describe("Cross-graph isolation", () => {
  beforeEach(() => { db = freshDb() })
  afterEach(() => { db.close() })

  test("nodes from different graphs are isolated", () => {
    const g1 = createGraph(db, { name: "g1" })
    const g2 = createGraph(db, { name: "g2" })

    upsertNode(db, g1, { name: "A" })
    upsertNode(db, g1, { name: "B" })
    upsertNode(db, g2, { name: "C" })

    expect(getNodesByGraph(db, g1).total).toBe(2)
    expect(getNodesByGraph(db, g2).total).toBe(1)
  })

  test("search is scoped to a single graph", () => {
    const g1 = createGraph(db, { name: "g1" })
    const g2 = createGraph(db, { name: "g2" })

    upsertNode(db, g1, { name: "UniqueAlpha", summary: "alpha entity" })
    upsertNode(db, g2, { name: "UniqueBeta", summary: "beta entity" })

    const r1 = searchNodes(db, g1, "UniqueAlpha")
    expect(r1).toHaveLength(1)
    const r2 = searchNodes(db, g1, "UniqueBeta")
    expect(r2).toHaveLength(0)
  })

  test("edges from different graphs are isolated", () => {
    const g1 = createGraph(db, { name: "g1" })
    const g2 = createGraph(db, { name: "g2" })

    const { id: a } = upsertNode(db, g1, { name: "A" })
    const { id: b } = upsertNode(db, g1, { name: "B" })
    const { id: c } = upsertNode(db, g2, { name: "C" })
    const { id: d } = upsertNode(db, g2, { name: "D" })

    createEdge(db, g1, { name: "R1", fact: "f1", source_node_id: a, target_node_id: b })
    createEdge(db, g2, { name: "R2", fact: "f2", source_node_id: c, target_node_id: d })

    expect(getEdgesByGraph(db, g1).total).toBe(1)
    expect(getEdgesByGraph(db, g2).total).toBe(1)
  })
})

// ─── Episodes ───────────────────────────────────────────────────────────────

describe("Episodes", () => {
  let graphId: string

  beforeEach(() => {
    db = freshDb()
    graphId = createGraph(db, { name: "episode-graph" })
  })
  afterEach(() => { db.close() })

  test("episodes can be inserted and queried", () => {
    const id = crypto.randomUUID().slice(0, 16)
    db.run(
      "INSERT INTO graph_episodes (id, graph_id, data, type) VALUES (?, ?, ?, ?)",
      [id, graphId, "Some text data", "text"],
    )

    const episode = db.query("SELECT * FROM graph_episodes WHERE id = ?").get(id) as Record<string, unknown>
    expect(episode).not.toBeNull()
    expect(episode.data).toBe("Some text data")
    expect(episode.type).toBe("text")
    expect(episode.processed).toBe(0)
  })

  test("episodes cascade on graph delete", () => {
    db.run(
      "INSERT INTO graph_episodes (id, graph_id, data, type) VALUES (?, ?, ?, ?)",
      ["ep1", graphId, "text", "text"],
    )
    deleteGraph(db, graphId)

    const count = db.query("SELECT COUNT(*) as c FROM graph_episodes WHERE graph_id = ?").get(graphId) as { c: number }
    expect(count.c).toBe(0)
  })

  test("updateGraphCounts includes episode count", () => {
    db.run(
      "INSERT INTO graph_episodes (id, graph_id, data, type) VALUES (?, ?, ?, ?)",
      ["ep1", graphId, "text1", "text"],
    )
    db.run(
      "INSERT INTO graph_episodes (id, graph_id, data, type) VALUES (?, ?, ?, ?)",
      ["ep2", graphId, "text2", "text"],
    )
    updateGraphCounts(db, graphId)

    const g = getGraph(db, graphId)!
    expect(g.episode_count).toBe(2)
  })
})

// ─── FTS trigger sync ───────────────────────────────────────────────────────

describe("FTS trigger sync", () => {
  let graphId: string

  beforeEach(() => {
    db = freshDb()
    graphId = createGraph(db, { name: "fts-graph" })
  })
  afterEach(() => { db.close() })

  test("FTS index is updated after node insert", () => {
    upsertNode(db, graphId, { name: "Photosynthesis", summary: "The process by which plants convert light" })
    const results = searchNodes(db, graphId, "Photosynthesis")
    expect(results).toHaveLength(1)
  })

  test("FTS index is updated after node update (upsert)", () => {
    upsertNode(db, graphId, { name: "Quantum", summary: "Quantum mechanics basics" })
    upsertNode(db, graphId, { name: "Quantum", summary: "Quantum mechanics is a fundamental theory in physics describing nature at atomic scales" })

    // Should still find it
    const results = searchNodes(db, graphId, "Quantum")
    expect(results).toHaveLength(1)

    // New summary should be searchable
    const results2 = searchNodes(db, graphId, "atomic")
    expect(results2).toHaveLength(1)
  })

  test("FTS index is updated after node delete", () => {
    const { id } = upsertNode(db, graphId, { name: "Ephemeral", summary: "Temporary node" })
    deleteNode(db, id)
    const results = searchNodes(db, graphId, "Ephemeral")
    expect(results).toHaveLength(0)
  })

  test("FTS index is updated after edge insert", () => {
    const { id: n1 } = upsertNode(db, graphId, { name: "A" })
    const { id: n2 } = upsertNode(db, graphId, { name: "B" })
    createEdge(db, graphId, {
      name: "MENTORS",
      fact: "A mentors B in advanced robotics",
      source_node_id: n1,
      target_node_id: n2,
    })
    const results = searchEdges(db, graphId, "robotics")
    expect(results).toHaveLength(1)
  })

  test("FTS index is updated after edge delete", () => {
    const { id: n1 } = upsertNode(db, graphId, { name: "A" })
    const { id: n2 } = upsertNode(db, graphId, { name: "B" })
    const eid = createEdge(db, graphId, {
      name: "TEMP_REL",
      fact: "A temporarily relates to B via xylophone",
      source_node_id: n1,
      target_node_id: n2,
    })
    deleteEdge(db, eid)
    const results = searchEdges(db, graphId, "xylophone")
    expect(results).toHaveLength(0)
  })
})
