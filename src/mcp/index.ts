#!/usr/bin/env bun

/**
 * researcher MCP server — exposes researcher tools to AI agents.
 * The app is NOT agentic — an AI agent USES these tools to perform experiments.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { initDb, createProject, listProjects, getProject, getProjectByName, createWorkspace, listWorkspaces, getWorkspace, listResults, getBestResult } from "../db/index.ts"
import { loadConfig, getDbPath } from "../config/index.ts"
import { CycleRegistry } from "../cycles/registry.ts"
import { queryKnowledge, saveKnowledge, exportKnowledgeMarkdown } from "../engine/knowledge.ts"
import { ResourceManager } from "../engine/resources.ts"
import { runCycle } from "../engine/cycle-runner.ts"
import { ProviderRouter } from "../providers/router.ts"
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
  "Run a cycle on an existing workspace. This executes all phases sequentially.",
  {
    workspace_id: z.string().describe("Workspace ID"),
    user_goal: z.string().optional().describe("What you're trying to achieve"),
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

    const result = await runCycle({
      db,
      router,
      workspaceId: params.workspace_id,
      projectId: project.id as string,
      cycle,
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
        text: `Cycle ${result.success ? "COMPLETED" : "FAILED"}\nPhases: ${result.phases.length}\nCost: $${result.totalCost.toFixed(4)}\n\n${result.phases.map(p => `${p.phaseName}: ${p.summary.slice(0, 300)}`).join("\n\n")}${result.error ? `\n\nError: ${result.error}` : ""}`,
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

// ─── Start server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
