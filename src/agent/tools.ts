/**
 * Built-in tools for research agents.
 * Each phase gets a different subset of tools based on what it needs.
 */

import type { Database } from "bun:sqlite"
import type { AgentTool } from "./loop.ts"
import type { SandboxInstance } from "../sandbox/base.ts"
import { searchWeb } from "../providers/web-search.ts"
import { searchDirectArxiv } from "../skills/core/paper-search.ts"

// ─── Thinking tools ──────────────────────────────────────────────────────────

export function noteToSelf(): AgentTool {
  return {
    name: "note",
    description: "Write a note to yourself for later iterations. Use this to track your reasoning, hypotheses, and findings.",
    parameters: {
      content: { type: "string", description: "The note content", required: true },
    },
    execute: async (params) => `Noted: ${params.content}`,
  }
}

// ─── Paper search tools ─────────────────────────────────────────────────────

export function searchPapers(): AgentTool {
  return {
    name: "search_papers",
    description: "Search academic research papers on arXiv. Returns papers with titles, authors, abstracts, and PDF links. Uses @hasna/connectors arxiv connector when available, falls back to direct arXiv API.",
    parameters: {
      query: { type: "string", description: "Search query (keywords, topics)", required: true },
      category: { type: "string", description: "arXiv category filter (e.g., 'cs.AI', 'cs.LG', 'math.OC')" },
      author: { type: "string", description: "Author name to search for" },
      max_results: { type: "number", description: "Max papers to return (default 5)" },
    },
    execute: async (params) => {
      try {
        const papers = await searchDirectArxiv(params.query as string, {
          category: params.category as string | undefined,
          author: params.author as string | undefined,
          maxResults: (params.max_results as number) ?? 5,
        })

        if (papers.length === 0) {
          return `No papers found for "${params.query}".`
        }

        return `Found ${papers.length} papers:\n\n${papers.map((p, i) => `${i + 1}. ${p.title}\n   Authors: ${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? " et al." : ""}\n   ${p.arxivUrl}\n   ${p.abstract.slice(0, 300)}...`).join("\n\n")}`
      } catch (err) {
        return `Paper search failed: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}

// ─── Search & gather tools ───────────────────────────────────────────────────

export function webSearch(): AgentTool {
  return {
    name: "web_search",
    description: "Search the web for information. Uses Exa, OpenAI, or Anthropic web search with automatic fallback. Returns results with titles, URLs, and snippets.",
    parameters: {
      query: { type: "string", description: "Search query", required: true },
      max_results: { type: "number", description: "Max results (default 5)" },
      domains: { type: "string", description: "Comma-separated domains to filter (e.g., 'arxiv.org,github.com')" },
    },
    execute: async (params) => {
      try {
        const domains = (params.domains as string)?.split(",").map(d => d.trim()).filter(Boolean)
        const response = await searchWeb(params.query as string, {
          maxResults: (params.max_results as number) ?? 5,
          includeDomains: domains?.length ? domains : undefined,
        })

        if (response.results.length === 0) {
          return `No web search results found for "${params.query}". No search API keys configured (set EXA_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY).`
        }

        return `Web search results (${response.provider}, ${response.results.length} results):\n${response.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 300)}`).join("\n\n")}`
      } catch (err) {
        return `Web search failed: ${err instanceof Error ? err.message : String(err)}. Use your training knowledge instead.`
      }
    },
  }
}

export function queryKnowledgeBase(db: Database): AgentTool {
  return {
    name: "query_knowledge",
    description: "Search the researcher knowledge base for past findings from previous experiments.",
    parameters: {
      search: { type: "string", description: "Search query", required: true },
      domain: { type: "string", description: "Filter by domain (optional)" },
    },
    execute: async (params) => {
      const domain = params.domain as string | undefined
      const search = params.search as string
      let sql = "SELECT insight, confidence, domain FROM knowledge WHERE insight LIKE ?"
      const sqlParams: string[] = [`%${search}%`]
      if (domain) {
        sql += " AND domain = ?"
        sqlParams.push(domain)
      }
      sql += " ORDER BY confidence DESC LIMIT 10"
      const rows = db.query(sql).all(...sqlParams) as Record<string, unknown>[]
      if (rows.length === 0) return "No relevant knowledge found."
      return rows
        .map((r) => `[${((r.confidence as number) * 100).toFixed(0)}%] ${r.insight}`)
        .join("\n")
    },
  }
}

export function queryPastExperiments(db: Database): AgentTool {
  return {
    name: "query_experiments",
    description: "Query past experiment results from this project. See what was tried before and what worked.",
    parameters: {
      workspace_id: { type: "string", description: "Workspace ID to query (optional — queries all if omitted)" },
    },
    execute: async (params) => {
      const wsId = params.workspace_id as string | undefined
      let sql = "SELECT r.metrics, r.decision, r.reasoning, s.hypothesis FROM results r JOIN sandboxes s ON r.sandbox_id = s.id"
      const sqlParams: string[] = []
      if (wsId) {
        sql += " WHERE r.workspace_id = ?"
        sqlParams.push(wsId)
      }
      sql += " ORDER BY r.created_at DESC LIMIT 20"
      const rows = db.query(sql).all(...sqlParams) as Record<string, unknown>[]
      if (rows.length === 0) return "No past experiments found."
      return rows
        .map((r) => `[${r.decision}] ${r.hypothesis} → metrics: ${r.metrics}`)
        .join("\n")
    },
  }
}

// ─── File & code tools ───────────────────────────────────────────────────────

export function readFile(sandbox?: SandboxInstance): AgentTool {
  return {
    name: "read_file",
    description: "Read a file's contents. Use this to understand existing code, configs, or data.",
    parameters: {
      path: { type: "string", description: "File path to read", required: true },
    },
    execute: async (params) => {
      if (!sandbox) return "No sandbox available — cannot read files."
      try {
        return await sandbox.readFile(params.path as string)
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}

export function writeFile(sandbox?: SandboxInstance): AgentTool {
  return {
    name: "write_file",
    description: "Write content to a file. Use this to create or modify experiment files.",
    parameters: {
      path: { type: "string", description: "File path to write", required: true },
      content: { type: "string", description: "File content", required: true },
    },
    execute: async (params) => {
      if (!sandbox) return "No sandbox available — cannot write files."
      try {
        await sandbox.writeFile(params.path as string, params.content as string)
        return `Wrote ${(params.content as string).length} chars to ${params.path}`
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}

export function runCommand(sandbox?: SandboxInstance): AgentTool {
  return {
    name: "run_command",
    description: "Execute a shell command in the sandbox. Use this to run benchmarks, tests, or any evaluation.",
    parameters: {
      command: { type: "string", description: "Shell command to execute", required: true },
      timeout: { type: "number", description: "Timeout in ms (default 60000)" },
    },
    execute: async (params) => {
      if (!sandbox) return "No sandbox available — cannot run commands."
      try {
        const result = await sandbox.execute(params.command as string, {
          timeout: (params.timeout as number) ?? 60_000,
        })
        const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : "")
        return `Exit code: ${result.exitCode}\n${output.slice(0, 5000)}`
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}

export function getDiff(sandbox?: SandboxInstance): AgentTool {
  return {
    name: "get_diff",
    description: "Get a diff of all changes made in the current sandbox.",
    parameters: {},
    execute: async () => {
      if (!sandbox) return "No sandbox available."
      try {
        return await sandbox.getDiff()
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}

// ─── Knowledge tools ─────────────────────────────────────────────────────────

export function saveKnowledgeTool(db: Database, projectId: string, domain: string): AgentTool {
  return {
    name: "save_knowledge",
    description: "Save a research finding as permanent knowledge. Use this when you've discovered something valuable.",
    parameters: {
      insight: { type: "string", description: "The insight to save", required: true },
      confidence: { type: "number", description: "Confidence 0-1", required: true },
      tags: { type: "string", description: "Comma-separated tags" },
    },
    execute: async (params) => {
      const tags = (params.tags as string)?.split(",").map((t) => t.trim()) ?? []
      const id = crypto.randomUUID().slice(0, 16)
      db.run(
        `INSERT INTO knowledge (id, project_id, domain, insight, confidence, tags) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, projectId, domain, params.insight as string, params.confidence as number, JSON.stringify(tags)],
      )
      return `Knowledge saved (${id}): ${(params.insight as string).slice(0, 100)}`
    },
  }
}

// ─── Metric tools ────────────────────────────────────────────────────────────

export function reportMetric(): AgentTool {
  return {
    name: "report_metric",
    description: "Report a measured metric value from an experiment. Use this after running a benchmark.",
    parameters: {
      name: { type: "string", description: "Metric name", required: true },
      value: { type: "number", description: "Metric value", required: true },
      description: { type: "string", description: "What was measured" },
    },
    execute: async (params) => {
      return `Metric recorded: ${params.name} = ${params.value}${params.description ? ` (${params.description})` : ""}`
    },
  }
}

// ─── Tool set builders ───────────────────────────────────────────────────────

/** Tools for the PROBLEM phase — understanding the problem */
export function problemTools(db: Database): AgentTool[] {
  return [noteToSelf(), queryKnowledgeBase(db), queryPastExperiments(db)]
}

/** Tools for the FEEDBACK/GATHER phase — collecting information */
export function gatherTools(db: Database): AgentTool[] {
  return [noteToSelf(), webSearch(), searchPapers(), queryKnowledgeBase(db), queryPastExperiments(db)]
}

/** Tools for the LOOPHOLE/EXPERIMENT phase — running experiments */
export function experimentTools(db: Database, sandbox?: SandboxInstance, projectId?: string, domain?: string): AgentTool[] {
  return [
    noteToSelf(),
    readFile(sandbox),
    writeFile(sandbox),
    runCommand(sandbox),
    getDiff(sandbox),
    reportMetric(),
    queryKnowledgeBase(db),
    ...(projectId && domain ? [saveKnowledgeTool(db, projectId, domain)] : []),
  ]
}

/** Tools for the KNOWLEDGE/SYNTHESIZE phase — extracting insights */
export function synthesizeTools(db: Database, projectId: string, domain: string): AgentTool[] {
  return [noteToSelf(), queryKnowledgeBase(db), queryPastExperiments(db), saveKnowledgeTool(db, projectId, domain)]
}
