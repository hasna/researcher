#!/usr/bin/env bun

/**
 * researcher MCP server — exposes researcher tools to AI agents.
 * The app is NOT agentic — an AI agent USES these tools to perform experiments.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { initDb, createProject, listProjects, getProject, getProjectByName, createWorkspace, listWorkspaces, getWorkspace, listResults, getBestResult } from "../db/index.ts"
import { createGraph, getGraph, listGraphs, deleteGraph } from "../graph/graph.ts"
import { getNodesByGraph, getNodesByLabel, getNodeEdges } from "../graph/nodes.ts"
import { getEdgesByGraph } from "../graph/edges.ts"
import { searchGraph } from "../graph/search.ts"
import { ingestText, ingestBatch } from "../graph/ingest.ts"
import { loadConfig, getDbPath } from "../config/index.ts"
import { CycleRegistry } from "../cycles/registry.ts"
import { queryKnowledge, saveKnowledge, exportKnowledgeMarkdown } from "../engine/knowledge.ts"
import { ResourceManager } from "../engine/resources.ts"
import { runCycle } from "../engine/cycle-runner.ts"
import { ProviderRouter } from "../providers/router.ts"
import { SandboxRouter } from "../sandbox/router.ts"
import { createDefaultRegistry } from "../skills/index.ts"

const server = new McpServer({
  name: "researcher",
  version: "0.0.1",
})

const db = initDb(getDbPath())
const config = loadConfig()
const cycleRegistry = new CycleRegistry()
await cycleRegistry.loadBuiltIn()

// ─── Tools ───────────────────────────────────────────────────────────────────

server.tool(
  "researcher_list_projects",
  "List all research projects",
  {},
  async () => {
    const projects = listProjects(db) as Record<string, unknown>[]
    return {
      content: [{
        type: "text" as const,
        text: projects.length === 0
          ? "No projects. Use researcher_create_project to create one."
          : projects.map(p => `${p.id} | ${p.name} | ${p.domain} | ${p.metric_name} (${p.metric_direction})`).join("\n"),
      }],
    }
  },
)

server.tool(
  "researcher_create_project",
  "Create a new research project",
  {
    name: z.string().describe("Project name"),
    type: z.enum(["git_repo", "directory", "virtual", "cloud"]).default("git_repo").describe("Project type"),
    path: z.string().optional().describe("Project path"),
    domain: z.string().default("general").describe("Research domain (code, marketing, finance, etc.)"),
    metric_name: z.string().default("score").describe("Primary metric to optimize"),
    metric_direction: z.enum(["lower", "higher"]).default("higher").describe("Optimization direction"),
  },
  async (params) => {
    const id = createProject(db, params)
    return {
      content: [{
        type: "text" as const,
        text: `Created project: ${params.name} (${id})\nDomain: ${params.domain}\nMetric: ${params.metric_name} (${params.metric_direction})`,
      }],
    }
  },
)

server.tool(
  "researcher_get_project",
  "Get details of a research project",
  { name_or_id: z.string().describe("Project name or ID") },
  async ({ name_or_id }) => {
    const project = (getProjectByName(db, name_or_id) ?? getProject(db, name_or_id)) as Record<string, unknown> | null
    if (!project) {
      return { content: [{ type: "text" as const, text: `Project not found: ${name_or_id}` }] }
    }
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(project, null, 2),
      }],
    }
  },
)

server.tool(
  "researcher_start_workspace",
  "Start a new research workspace with a cycle",
  {
    project: z.string().describe("Project name or ID"),
    cycle: z.string().default("pflk").describe("Cycle to use (pflk, gree, etc.)"),
    parallel: z.number().default(10).describe("Max parallel experiments"),
  },
  async (params) => {
    const project = (getProjectByName(db, params.project) ?? getProject(db, params.project)) as Record<string, unknown> | null
    if (!project) {
      return { content: [{ type: "text" as const, text: `Project not found: ${params.project}` }] }
    }
    const cycle = cycleRegistry.get(params.cycle)
    if (!cycle) {
      return { content: [{ type: "text" as const, text: `Cycle not found: ${params.cycle}. Available: ${cycleRegistry.list().map(c => c.id).join(", ")}` }] }
    }

    const wsId = createWorkspace(db, {
      project_id: project.id as string,
      cycle_id: cycle.id,
      config: { parallel: params.parallel },
    })

    return {
      content: [{
        type: "text" as const,
        text: `Workspace created: ${wsId}\nCycle: ${cycle.name}\nPhases: ${cycle.phases.map(p => p.name).join(" → ")}\n\nUse researcher_run_cycle to execute.`,
      }],
    }
  },
)

server.tool(
  "researcher_run_cycle",
  "Run a cycle on an existing workspace. Defaults to agentic mode (tool-calling loops per phase). Use mode='simple' for single LLM calls.",
  {
    workspace_id: z.string().describe("Workspace ID"),
    user_goal: z.string().optional().describe("What you're trying to achieve"),
    mode: z.enum(["agentic", "simple"]).default("agentic").describe("Execution mode: 'agentic' (default) uses tool-calling agent loops, 'simple' uses single LLM calls"),
    evaluation_command: z.string().optional().describe("Shell command to evaluate experiments in sandboxes"),
  },
  async (params) => {
    const ws = getWorkspace(db, params.workspace_id) as Record<string, unknown> | null
    if (!ws) {
      return { content: [{ type: "text" as const, text: `Workspace not found: ${params.workspace_id}` }] }
    }

    const project = getProject(db, ws.project_id as string) as Record<string, unknown> | null
    if (!project) {
      return { content: [{ type: "text" as const, text: "Project not found for this workspace" }] }
    }

    const cycle = cycleRegistry.get(ws.cycle_id as string)
    if (!cycle) {
      return { content: [{ type: "text" as const, text: `Cycle not found: ${ws.cycle_id}` }] }
    }

    const router = new ProviderRouter({
      anthropic: config.providers.anthropic ? { apiKey: config.providers.anthropic.api_key } : undefined,
      openai: config.providers.openai ? { apiKey: config.providers.openai.api_key } : undefined,
      cerebras: config.providers.cerebras ? { apiKey: config.providers.cerebras.api_key } : undefined,
      local: config.providers.local ? { baseUrl: config.providers.local.base_url, model: config.providers.local.default_model } : undefined,
    })

    // Create sandbox router for real experiment execution
    const sandboxRouter = new SandboxRouter()

    // Detect sandbox hints from project path
    const projectPath = project.path as string | undefined
    const sandboxHints = projectPath ? {
      isGitRepo: true,
      repoPath: projectPath,
    } : {}

    const result = await runCycle({
      db,
      router,
      workspaceId: params.workspace_id,
      projectId: project.id as string,
      cycle,
      mode: params.mode,
      sandboxRouter,
      sandboxHints,
      evaluationCommand: params.evaluation_command,
      context: {
        projectName: project.name as string,
        domain: project.domain as string,
        metricName: project.metric_name as string,
        metricDirection: project.metric_direction as string,
        userGoal: params.user_goal,
      },
    })

    return {
      content: [{
        type: "text" as const,
        text: `Cycle ${result.success ? "COMPLETED" : "FAILED"} (${params.mode} mode)\nPhases: ${result.phases.length}\nCost: $${result.totalCost.toFixed(4)}\n\n${result.phases.map(p => `${p.phaseName}: ${p.summary.slice(0, 300)}`).join("\n\n")}${result.error ? `\n\nError: ${result.error}` : ""}`,
      }],
    }
  },
)

server.tool(
  "researcher_get_status",
  "Get overall researcher status including active workspaces and costs",
  {},
  async () => {
    const rm = new ResourceManager()
    const status = rm.getStatus(db)
    const workspaces = listWorkspaces(db) as Record<string, unknown>[]

    let text = `Active sandboxes: ${status.activeSandboxes}/${status.maxSandboxes}\n`
    text += `Hourly cost: $${status.hourlyCost.toFixed(4)} / $${status.maxHourlyCost}\n`
    text += `Daily cost: $${status.dailyCost.toFixed(4)}\n`
    text += `Budget: ${status.withinBudget ? "OK" : "EXCEEDED"}\n\n`

    if (workspaces.length > 0) {
      text += `${workspaces.length} workspace(s):\n`
      for (const ws of workspaces) {
        text += `  ${ws.id} [${ws.status}] cycle:${ws.cycle_id} phase:${ws.current_phase ?? "-"} $${(ws.cost_total as number).toFixed(4)}\n`
      }
    }

    return { content: [{ type: "text" as const, text }] }
  },
)

server.tool(
  "researcher_query_knowledge",
  "Query the accumulated knowledge base",
  {
    search: z.string().optional().describe("Search query"),
    domain: z.string().optional().describe("Filter by domain"),
    project_id: z.string().optional().describe("Filter by project ID"),
  },
  async (params) => {
    const entries = queryKnowledge(db, params)
    if (entries.length === 0) {
      return { content: [{ type: "text" as const, text: "No knowledge entries found." }] }
    }
    return {
      content: [{
        type: "text" as const,
        text: entries.map(e => `[${(e.confidence * 100).toFixed(0)}%] ${e.insight}\n  Domain: ${e.domain} | Tags: ${e.tags.join(", ") || "none"}`).join("\n\n"),
      }],
    }
  },
)

server.tool(
  "researcher_save_knowledge",
  "Save a knowledge entry from research findings",
  {
    domain: z.string().describe("Knowledge domain"),
    insight: z.string().describe("The insight to save"),
    confidence: z.number().min(0).max(1).default(0.5).describe("Confidence level 0-1"),
    tags: z.array(z.string()).default([]).describe("Tags for discoverability"),
    project_id: z.string().optional().describe("Project ID (null for cross-project)"),
  },
  async (params) => {
    const id = saveKnowledge(db, params)
    return {
      content: [{
        type: "text" as const,
        text: `Knowledge saved: ${id}\nInsight: ${params.insight}\nConfidence: ${(params.confidence * 100).toFixed(0)}%`,
      }],
    }
  },
)

server.tool(
  "researcher_list_cycles",
  "List available research cycles",
  {},
  async () => {
    const cycles = cycleRegistry.list()
    return {
      content: [{
        type: "text" as const,
        text: cycles.map(c => `${c.id} — ${c.name} (${c.author})\n  Phases: ${c.phases.map(p => p.name).join(" → ")}\n  ${c.description.slice(0, 120)}`).join("\n\n"),
      }],
    }
  },
)

server.tool(
  "researcher_list_skills",
  "List available skills that can be used during research phases",
  {},
  async () => {
    const registry = createDefaultRegistry()
    const skills = registry.list()
    return {
      content: [{
        type: "text" as const,
        text: skills.map(s => `${s.name} — ${s.description}\n  Domains: ${s.domains.join(", ")} | Phases: ${s.phases.join(", ")} | Cost: ${s.cost_per_run}`).join("\n\n"),
      }],
    }
  },
)

server.tool(
  "researcher_get_workspace",
  "Get detailed workspace information including results",
  { workspace_id: z.string().describe("Workspace ID") },
  async ({ workspace_id }) => {
    const ws = getWorkspace(db, workspace_id) as Record<string, unknown> | null
    if (!ws) {
      return { content: [{ type: "text" as const, text: `Workspace not found: ${workspace_id}` }] }
    }
    const results = listResults(db, workspace_id) as Record<string, unknown>[]
    let text = JSON.stringify(ws, null, 2)
    if (results.length > 0) {
      text += `\n\n${results.length} results:\n`
      for (const r of results) {
        text += `  ${r.id} [${r.decision}] metrics:${r.metrics} cost:$${(r.cost as number).toFixed(4)}\n`
      }
    }
    return { content: [{ type: "text" as const, text }] }
  },
)

server.tool(
  "researcher_export_knowledge",
  "Export all knowledge as markdown",
  { project_id: z.string().optional().describe("Filter by project ID") },
  async ({ project_id }) => {
    const md = exportKnowledgeMarkdown(db, project_id)
    return { content: [{ type: "text" as const, text: md }] }
  },
)

// ─── Graph Tools ────────────────────────────────────────────────────────────

server.tool(
  "researcher_graph_create",
  "Create a knowledge graph for entity extraction and relationship mapping",
  {
    name: z.string().describe("Graph name"),
    description: z.string().default("").describe("Graph description"),
    project_id: z.string().optional().describe("Link to a research project"),
    ontology: z.object({
      entity_types: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
      edge_types: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
    }).optional().describe("Optional ontology to constrain entity/edge types"),
  },
  async (params) => {
    const id = createGraph(db, params)
    return {
      content: [{ type: "text" as const, text: `Created graph: ${params.name} (${id})` }],
    }
  },
)

server.tool(
  "researcher_graph_delete",
  "Delete a knowledge graph and all its nodes, edges, and episodes",
  { graph_id: z.string().describe("Graph ID to delete") },
  async ({ graph_id }) => {
    const deleted = deleteGraph(db, graph_id)
    return {
      content: [{ type: "text" as const, text: deleted ? `Deleted graph ${graph_id}` : `Graph not found: ${graph_id}` }],
    }
  },
)

server.tool(
  "researcher_graph_ingest",
  "Ingest text into a graph — automatically extracts entities and relationships via LLM",
  {
    graph_id: z.string().describe("Target graph ID"),
    text: z.string().describe("Text to ingest (article, report, document content)"),
    texts: z.array(z.string()).optional().describe("Multiple texts to ingest in batch"),
    model: z.string().optional().describe("LLM model for extraction (default: gpt-4.1-mini)"),
    skip_embeddings: z.boolean().default(false).describe("Skip embedding generation"),
  },
  async (params) => {
    if (params.texts?.length) {
      const results = await ingestBatch(db, params.graph_id, params.texts, {
        model: params.model,
        skip_embeddings: params.skip_embeddings,
      })
      const totalNodes = results.reduce((s, r) => s + r.nodes_created, 0)
      const totalEdges = results.reduce((s, r) => s + r.edges_created, 0)
      return {
        content: [{ type: "text" as const, text: `Ingested ${results.length} texts → ${totalNodes} new nodes, ${totalEdges} new edges` }],
      }
    }
    const result = await ingestText(db, params.graph_id, params.text, {
      model: params.model,
      skip_embeddings: params.skip_embeddings,
    })
    return {
      content: [{ type: "text" as const, text: `Ingested → ${result.nodes_created} new nodes (+${result.nodes_updated} updated), ${result.edges_created} new edges (episode: ${result.episode_id})` }],
    }
  },
)

server.tool(
  "researcher_graph_search",
  "Search a knowledge graph using hybrid keyword + semantic search",
  {
    graph_id: z.string().describe("Graph ID to search"),
    query: z.string().describe("Search query (natural language)"),
    limit: z.number().default(20).describe("Max results"),
    scope: z.enum(["nodes", "edges", "both"]).default("both").describe("Search scope"),
  },
  async (params) => {
    const result = await searchGraph(db, params.graph_id, params.query, {
      limit: params.limit,
      scope: params.scope,
    })
    const lines: string[] = []
    if (result.nodes.length > 0) {
      lines.push(`Nodes (${result.nodes.length}):`)
      for (const n of result.nodes) {
        lines.push(`  ${n.name} [${n.labels.join(", ")}] — ${n.summary.slice(0, 100)}`)
      }
    }
    if (result.edges.length > 0) {
      lines.push(`\nEdges (${result.edges.length}):`)
      for (const e of result.edges) {
        lines.push(`  ${e.name}: ${e.fact.slice(0, 120)}`)
      }
    }
    if (result.facts.length > 0) {
      lines.push(`\nFacts (${result.facts.length}):`)
      for (const f of result.facts) {
        lines.push(`  • ${f.slice(0, 150)}`)
      }
    }
    return {
      content: [{ type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "No results found." }],
    }
  },
)

server.tool(
  "researcher_graph_nodes",
  "List or filter nodes in a knowledge graph",
  {
    graph_id: z.string().describe("Graph ID"),
    label: z.string().optional().describe("Filter by label (e.g. 'person', 'organization')"),
    limit: z.number().default(50).describe("Max results"),
    cursor: z.string().optional().describe("Pagination cursor"),
  },
  async (params) => {
    if (params.label) {
      const nodes = getNodesByLabel(db, params.graph_id, params.label)
      const lines = nodes.map(n => `${n.id} | ${n.name} [${n.labels.join(", ")}] — ${n.summary.slice(0, 80)}`)
      return {
        content: [{ type: "text" as const, text: lines.length > 0 ? `${lines.length} nodes with label "${params.label}":\n${lines.join("\n")}` : `No nodes with label "${params.label}"` }],
      }
    }
    const result = getNodesByGraph(db, params.graph_id, { limit: params.limit, cursor: params.cursor })
    const lines = result.items.map(n => `${n.id} | ${n.name} [${n.labels.join(", ")}] — ${n.summary.slice(0, 80)}`)
    let text = `${result.items.length} nodes:\n${lines.join("\n")}`
    if (result.next_cursor) text += `\n\nNext cursor: ${result.next_cursor}`
    return { content: [{ type: "text" as const, text }] }
  },
)

server.tool(
  "researcher_graph_edges",
  "List edges (relationships) in a knowledge graph",
  {
    graph_id: z.string().describe("Graph ID"),
    node_id: z.string().optional().describe("Filter edges connected to a specific node"),
    limit: z.number().default(50).describe("Max results"),
    cursor: z.string().optional().describe("Pagination cursor"),
  },
  async (params) => {
    if (params.node_id) {
      const edges = getNodeEdges(db, params.node_id)
      const lines = edges.map(e => `${e.id} | ${e.name}: ${e.fact.slice(0, 100)}`)
      return {
        content: [{ type: "text" as const, text: lines.length > 0 ? `${lines.length} edges for node:\n${lines.join("\n")}` : "No edges for this node" }],
      }
    }
    const result = getEdgesByGraph(db, params.graph_id, { limit: params.limit, cursor: params.cursor })
    const lines = result.items.map(e => `${e.id} | ${e.name}: ${e.fact.slice(0, 100)}`)
    let text = `${result.items.length} edges:\n${lines.join("\n")}`
    if (result.next_cursor) text += `\n\nNext cursor: ${result.next_cursor}`
    return { content: [{ type: "text" as const, text }] }
  },
)

// ─── Start server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
