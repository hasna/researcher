import { test, expect, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "../db/schema.ts"
import { createProject } from "../db/index.ts"
import { saveKnowledge } from "./knowledge.ts"
import {
  addRelationship,
  removeRelationship,
  getRelationships,
  getNeighbors,
  findPath,
  propagateConfidence,
  getSubgraph,
  transferKnowledge,
} from "./knowledge-graph.ts"

function setupDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  db.run("INSERT INTO schema_version (version) VALUES (2)")
  return db
}

// ─── addRelationship / removeRelationship ───────────────────────────────────

describe("addRelationship", () => {
  test("creates an edge between two knowledge entries", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Batch norm stabilizes training", confidence: 0.8 })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Layer norm works better for transformers", confidence: 0.7 })

    const edgeId = addRelationship(db, {
      source_id: k1,
      target_id: k2,
      relationship: "related_to",
    })

    expect(edgeId).toBeTruthy()
    const edges = getRelationships(db, k1)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.source_id).toBe(k1)
    expect(edges[0]!.target_id).toBe(k2)
    expect(edges[0]!.relationship).toBe("related_to")
    expect(edges[0]!.weight).toBe(1.0)
    db.close()
  })

  test("stores custom weight and metadata", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Insight A" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Insight B" })

    addRelationship(db, {
      source_id: k1,
      target_id: k2,
      relationship: "supports",
      weight: 0.8,
      metadata: { reason: "experimental evidence" },
    })

    const edges = getRelationships(db, k1)
    expect(edges[0]!.weight).toBe(0.8)
    expect(edges[0]!.metadata).toEqual({ reason: "experimental evidence" })
    db.close()
  })

  test("enforces UNIQUE constraint on (source, target, relationship)", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "A" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "B" })

    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    expect(() =>
      addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" }),
    ).toThrow()
    db.close()
  })
})

describe("removeRelationship", () => {
  test("deletes an edge by ID", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "A" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "B" })
    const edgeId = addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })

    const removed = removeRelationship(db, edgeId)
    expect(removed).toBe(true)
    expect(getRelationships(db, k1)).toHaveLength(0)
    db.close()
  })

  test("returns false for non-existent ID", () => {
    const db = setupDb()
    expect(removeRelationship(db, "nonexistent")).toBe(false)
    db.close()
  })
})

// ─── getRelationships ───────────────────────────────────────────────────────

describe("getRelationships", () => {
  test("returns edges in both directions", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "A" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "B" })
    const k3 = saveKnowledge(db, { domain: "ml", insight: "C" })

    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    addRelationship(db, { source_id: k3, target_id: k1, relationship: "contradicts" })

    const edges = getRelationships(db, k1)
    expect(edges).toHaveLength(2)
    db.close()
  })
})

// ─── getNeighbors ───────────────────────────────────────────────────────────

describe("getNeighbors", () => {
  test("returns all neighbors by default (both directions)", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Center" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Out" })
    const k3 = saveKnowledge(db, { domain: "ml", insight: "In" })

    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    addRelationship(db, { source_id: k3, target_id: k1, relationship: "depends_on" })

    const neighbors = getNeighbors(db, k1)
    expect(neighbors).toHaveLength(2)
    const ids = neighbors.map((n) => n.id)
    expect(ids).toContain(k2)
    expect(ids).toContain(k3)
    db.close()
  })

  test("filters by direction=outgoing", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Center" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Out" })
    const k3 = saveKnowledge(db, { domain: "ml", insight: "In" })

    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    addRelationship(db, { source_id: k3, target_id: k1, relationship: "depends_on" })

    const outgoing = getNeighbors(db, k1, { direction: "outgoing" })
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]!.id).toBe(k2)
    db.close()
  })

  test("filters by direction=incoming", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Center" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Out" })
    const k3 = saveKnowledge(db, { domain: "ml", insight: "In" })

    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    addRelationship(db, { source_id: k3, target_id: k1, relationship: "depends_on" })

    const incoming = getNeighbors(db, k1, { direction: "incoming" })
    expect(incoming).toHaveLength(1)
    expect(incoming[0]!.id).toBe(k3)
    db.close()
  })

  test("filters by relationship type", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Center" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Supporter" })
    const k3 = saveKnowledge(db, { domain: "ml", insight: "Contradictor" })

    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    addRelationship(db, { source_id: k1, target_id: k3, relationship: "contradicts" })

    const supporters = getNeighbors(db, k1, { relationship: "supports" })
    expect(supporters).toHaveLength(1)
    expect(supporters[0]!.id).toBe(k2)
    db.close()
  })
})

// ─── findPath (BFS) ─────────────────────────────────────────────────────────

describe("findPath", () => {
  test("finds direct path between adjacent nodes", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "A" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "B" })
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })

    const path = findPath(db, k1, k2)
    expect(path).toEqual([k1, k2])
    db.close()
  })

  test("finds multi-hop path", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "A" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "B" })
    const k3 = saveKnowledge(db, { domain: "ml", insight: "C" })
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    addRelationship(db, { source_id: k2, target_id: k3, relationship: "depends_on" })

    const path = findPath(db, k1, k3)
    expect(path).toEqual([k1, k2, k3])
    db.close()
  })

  test("returns empty array when no path exists", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "A" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "B" })
    // No edge between them

    const path = findPath(db, k1, k2)
    expect(path).toEqual([])
    db.close()
  })

  test("returns single-element path for same node", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "A" })
    expect(findPath(db, k1, k1)).toEqual([k1])
    db.close()
  })

  test("respects maxDepth", () => {
    const db = setupDb()
    const nodes: string[] = []
    for (let i = 0; i < 5; i++) {
      nodes.push(saveKnowledge(db, { domain: "ml", insight: `Node ${i}` }))
    }
    for (let i = 0; i < 4; i++) {
      addRelationship(db, { source_id: nodes[i]!, target_id: nodes[i + 1]!, relationship: "supports" })
    }

    // Path of length 4 should be found with depth 4+
    expect(findPath(db, nodes[0]!, nodes[4]!, 4)).toHaveLength(5)
    // But not with depth 2
    expect(findPath(db, nodes[0]!, nodes[4]!, 2)).toEqual([])
    db.close()
  })

  test("traverses edges in both directions", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "A" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "B" })
    const k3 = saveKnowledge(db, { domain: "ml", insight: "C" })
    // k1 -> k2 (outgoing)
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    // k3 -> k2 (k2 is target, so to reach k3 from k2 we follow incoming edge)
    addRelationship(db, { source_id: k3, target_id: k2, relationship: "supports" })

    // Should find k1 -> k2 -> k3 (traversing second edge backwards)
    const path = findPath(db, k1, k3)
    expect(path).toEqual([k1, k2, k3])
    db.close()
  })
})

// ─── propagateConfidence ────────────────────────────────────────────────────

describe("propagateConfidence", () => {
  test("supports: high source confidence raises target", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Strong finding", confidence: 0.9 })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Related finding", confidence: 0.5 })
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })

    const updated = propagateConfidence(db, k1)
    expect(updated).toBe(1)

    const row = db.query("SELECT confidence FROM knowledge WHERE id = ?").get(k2) as { confidence: number }
    // delta = (0.9 - 0.5) * 1.0 * 0.1 = 0.04, so 0.5 + 0.04 = 0.54
    expect(row.confidence).toBeCloseTo(0.54, 2)
    db.close()
  })

  test("contradicts: high source confidence lowers target", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "New evidence", confidence: 0.9 })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Old claim", confidence: 0.6 })
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "contradicts" })

    propagateConfidence(db, k1)

    const row = db.query("SELECT confidence FROM knowledge WHERE id = ?").get(k2) as { confidence: number }
    // delta = (0.9 - 0.5) * 1.0 * 0.2 = 0.08, contradicts => 0.6 - 0.08 = 0.52
    expect(row.confidence).toBeCloseTo(0.52, 2)
    db.close()
  })

  test("depends_on: proportional propagation like supports", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Foundation", confidence: 0.8 })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Dependent", confidence: 0.5 })
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "depends_on" })

    propagateConfidence(db, k1)

    const row = db.query("SELECT confidence FROM knowledge WHERE id = ?").get(k2) as { confidence: number }
    // delta = (0.8 - 0.5) * 1.0 * 0.1 = 0.03, so 0.5 + 0.03 = 0.53
    expect(row.confidence).toBeCloseTo(0.53, 2)
    db.close()
  })

  test("low source confidence decreases supported targets", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Weak finding", confidence: 0.2 })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Supported", confidence: 0.6 })
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })

    propagateConfidence(db, k1)

    const row = db.query("SELECT confidence FROM knowledge WHERE id = ?").get(k2) as { confidence: number }
    // delta = (0.2 - 0.5) * 1.0 * 0.1 = -0.03, so 0.6 + (-0.03) = 0.57
    expect(row.confidence).toBeCloseTo(0.57, 2)
    db.close()
  })

  test("clamps confidence to [0, 1]", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Very high", confidence: 1.0 })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Already near max", confidence: 0.99 })
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })

    propagateConfidence(db, k1)

    const row = db.query("SELECT confidence FROM knowledge WHERE id = ?").get(k2) as { confidence: number }
    expect(row.confidence).toBeLessThanOrEqual(1.0)
    expect(row.confidence).toBeGreaterThanOrEqual(0)
    db.close()
  })

  test("returns 0 for non-existent node", () => {
    const db = setupDb()
    expect(propagateConfidence(db, "nonexistent")).toBe(0)
    db.close()
  })

  test("does not propagate for related_to edges", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "A", confidence: 0.9 })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "B", confidence: 0.5 })
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "related_to" })

    const updated = propagateConfidence(db, k1)
    expect(updated).toBe(0)

    const row = db.query("SELECT confidence FROM knowledge WHERE id = ?").get(k2) as { confidence: number }
    expect(row.confidence).toBe(0.5) // unchanged
    db.close()
  })

  test("weight affects propagation magnitude", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Strong", confidence: 0.9 })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Weak link", confidence: 0.5 })
    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports", weight: 0.5 })

    propagateConfidence(db, k1)

    const row = db.query("SELECT confidence FROM knowledge WHERE id = ?").get(k2) as { confidence: number }
    // delta = (0.9 - 0.5) * 0.5 * 0.1 = 0.02, so 0.5 + 0.02 = 0.52
    expect(row.confidence).toBeCloseTo(0.52, 2)
    db.close()
  })
})

// ─── getSubgraph ────────────────────────────────────────────────────────────

describe("getSubgraph", () => {
  test("returns single node when no edges", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Isolated" })
    const sub = getSubgraph(db, k1)
    expect(sub.nodes).toHaveLength(1)
    expect(sub.edges).toHaveLength(0)
    db.close()
  })

  test("returns 1-level neighborhood", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Center" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Neighbor 1" })
    const k3 = saveKnowledge(db, { domain: "ml", insight: "Neighbor 2" })
    const k4 = saveKnowledge(db, { domain: "ml", insight: "Far away" })

    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    addRelationship(db, { source_id: k1, target_id: k3, relationship: "contradicts" })
    addRelationship(db, { source_id: k3, target_id: k4, relationship: "depends_on" })

    const sub = getSubgraph(db, k1, 1)
    expect(sub.nodes).toHaveLength(3) // k1, k2, k3
    expect(sub.edges).toHaveLength(2) // k1->k2, k1->k3
    db.close()
  })

  test("returns 2-level neighborhood", () => {
    const db = setupDb()
    const k1 = saveKnowledge(db, { domain: "ml", insight: "Center" })
    const k2 = saveKnowledge(db, { domain: "ml", insight: "Level 1" })
    const k3 = saveKnowledge(db, { domain: "ml", insight: "Level 2" })

    addRelationship(db, { source_id: k1, target_id: k2, relationship: "supports" })
    addRelationship(db, { source_id: k2, target_id: k3, relationship: "depends_on" })

    const sub = getSubgraph(db, k1, 2)
    expect(sub.nodes).toHaveLength(3) // k1, k2, k3
    expect(sub.edges).toHaveLength(2)
    db.close()
  })
})

// ─── transferKnowledge ──────────────────────────────────────────────────────

describe("transferKnowledge", () => {
  test("copies knowledge between projects with derives_from edges", () => {
    const db = setupDb()
    const projA = createProject(db, { name: "Project A", type: "virtual" })
    const projB = createProject(db, { name: "Project B", type: "virtual" })

    saveKnowledge(db, { project_id: projA, domain: "ml", insight: "Transfer me", confidence: 0.8, tags: ["important"] })
    saveKnowledge(db, { project_id: projA, domain: "ml", insight: "Too low confidence", confidence: 0.3 })

    const result = transferKnowledge(db, {
      fromProjectId: projA,
      toProjectId: projB,
      minConfidence: 0.5,
    })

    expect(result.transferred).toBe(1)
    expect(result.edgeIds).toHaveLength(1)

    // Check the transferred knowledge exists in project B
    const projBKnowledge = db
      .query("SELECT * FROM knowledge WHERE project_id = ?")
      .all(projB) as Record<string, unknown>[]
    expect(projBKnowledge).toHaveLength(1)
    expect(projBKnowledge[0]!.insight).toBe("Transfer me")
    // Confidence is reduced by 20%
    expect(projBKnowledge[0]!.confidence as number).toBeCloseTo(0.64, 2)
    // Tags include "transferred"
    const tags = JSON.parse(projBKnowledge[0]!.tags as string)
    expect(tags).toContain("transferred")
    expect(tags).toContain("important")

    // Check derives_from edge exists
    const edgeRow = db
      .query("SELECT * FROM knowledge_edges WHERE id = ?")
      .get(result.edgeIds[0]!) as Record<string, unknown>
    expect(edgeRow.relationship).toBe("derives_from")
    db.close()
  })

  test("filters by domain", () => {
    const db = setupDb()
    const projA = createProject(db, { name: "Project A", type: "virtual" })
    const projB = createProject(db, { name: "Project B", type: "virtual" })

    saveKnowledge(db, { project_id: projA, domain: "ml", insight: "ML insight", confidence: 0.8 })
    saveKnowledge(db, { project_id: projA, domain: "web", insight: "Web insight", confidence: 0.8 })

    const result = transferKnowledge(db, {
      fromProjectId: projA,
      toProjectId: projB,
      domain: "ml",
    })

    expect(result.transferred).toBe(1)
    db.close()
  })

  test("transfers nothing when no knowledge meets criteria", () => {
    const db = setupDb()
    const projA = createProject(db, { name: "Project A", type: "virtual" })
    const projB = createProject(db, { name: "Project B", type: "virtual" })

    saveKnowledge(db, { project_id: projA, domain: "ml", insight: "Low", confidence: 0.1 })

    const result = transferKnowledge(db, {
      fromProjectId: projA,
      toProjectId: projB,
      minConfidence: 0.5,
    })

    expect(result.transferred).toBe(0)
    expect(result.edgeIds).toHaveLength(0)
    db.close()
  })
})
