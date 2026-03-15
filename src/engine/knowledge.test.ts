import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { SCHEMA_SQL } from "../db/schema.ts"
import { createProject } from "../db/index.ts"
import {
  saveKnowledge,
  queryKnowledge,
  getCrossProjectKnowledge,
  updateKnowledgeConfidence,
  exportKnowledgeMarkdown,
} from "./knowledge.ts"

function setupDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA_SQL)
  db.run("INSERT INTO schema_version (version) VALUES (1)")
  return db
}

test("save and query knowledge", () => {
  const db = setupDb()
  saveKnowledge(db, { domain: "code", insight: "Depth > Width", confidence: 0.9, tags: ["architecture"] })
  const results = queryKnowledge(db)
  expect(results).toHaveLength(1)
  expect(results[0]!.insight).toBe("Depth > Width")
  expect(results[0]!.confidence).toBe(0.9)
  db.close()
})

test("query by domain", () => {
  const db = setupDb()
  saveKnowledge(db, { domain: "code", insight: "Insight 1" })
  saveKnowledge(db, { domain: "marketing", insight: "Insight 2" })
  expect(queryKnowledge(db, { domain: "code" })).toHaveLength(1)
  expect(queryKnowledge(db, { domain: "marketing" })).toHaveLength(1)
  db.close()
})

test("query by search term", () => {
  const db = setupDb()
  saveKnowledge(db, { domain: "code", insight: "Deeper models beat wider at same param count" })
  saveKnowledge(db, { domain: "code", insight: "LR warmup prevents early instability" })
  const results = queryKnowledge(db, { search: "deeper" })
  expect(results).toHaveLength(1)
  expect(results[0]!.insight).toContain("Deeper")
  db.close()
})

test("cross-project knowledge", () => {
  const db = setupDb()
  const projId = createProject(db, { name: "proj", type: "git_repo" })
  saveKnowledge(db, { project_id: projId, domain: "code", insight: "Project-specific" })
  saveKnowledge(db, { domain: "general", insight: "Cross-project" })
  const crossProject = getCrossProjectKnowledge(db)
  expect(crossProject).toHaveLength(1)
  expect(crossProject[0]!.insight).toBe("Cross-project")
  db.close()
})

test("update knowledge confidence", () => {
  const db = setupDb()
  const id = saveKnowledge(db, { domain: "code", insight: "Test insight", confidence: 0.5 })

  updateKnowledgeConfidence(db, id, { experiment_id: "exp1", metric_value: 0.9, description: "Confirmed" }, true)
  let entries = queryKnowledge(db)
  expect(entries[0]!.confidence).toBeCloseTo(0.55)

  updateKnowledgeConfidence(db, id, { experiment_id: "exp2", metric_value: 1.1, description: "Denied" }, false)
  entries = queryKnowledge(db)
  expect(entries[0]!.confidence).toBeCloseTo(0.45)
  expect(entries[0]!.evidence).toHaveLength(2)
  db.close()
})

test("export knowledge as markdown", () => {
  const db = setupDb()
  saveKnowledge(db, { domain: "code", insight: "Code insight", confidence: 0.8, tags: ["arch"] })
  saveKnowledge(db, { domain: "marketing", insight: "Marketing insight", confidence: 0.7 })
  const md = exportKnowledgeMarkdown(db)
  expect(md).toContain("# Research Knowledge Base")
  expect(md).toContain("code")
  expect(md).toContain("marketing")
  expect(md).toContain("Code insight")
  expect(md).toContain("80%")
  db.close()
})
