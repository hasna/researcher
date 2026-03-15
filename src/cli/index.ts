#!/usr/bin/env bun

/**
 * researcher CLI — Universal autonomous experimentation framework.
 */

import { Command } from "commander"
import { initDb, createProject, listProjects, getProject, getProjectByName, deleteProject, createWorkspace, listWorkspaces, getWorkspace, listResults, updateWorkspaceStatus, deleteWorkspace } from "../db/index.ts"
import { loadConfig, saveConfig, ensureConfigDir, getDbPath } from "../config/index.ts"
import { CycleRegistry } from "../cycles/registry.ts"
import { exportKnowledgeMarkdown, queryKnowledge } from "../engine/knowledge.ts"
import { ResourceManager } from "../engine/resources.ts"
import { runCycle } from "../engine/cycle-runner.ts"
import { ProviderRouter } from "../providers/router.ts"

const program = new Command()

program
  .name("researcher")
  .description("Universal autonomous experimentation framework")
  .version("0.0.1")
  .option("--json", "Output as JSON for scripting/piping")

function isJson(): boolean {
  return program.opts().json === true
}

function output(data: unknown, formatted?: () => void): void {
  if (isJson()) {
    console.log(JSON.stringify(data, null, 2))
  } else if (formatted) {
    formatted()
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize researcher config at ~/.researcher/")
  .action(async () => {
    ensureConfigDir()
    const config = loadConfig()
    saveConfig(config)
    const db = initDb(getDbPath())
    db.close()
    console.log("Initialized ~/.researcher/")
    console.log("  Config: ~/.researcher/config.toml")
    console.log("  Database: ~/.researcher/researcher.db")
    console.log("\nSet API keys via env vars or edit config.toml:")
    console.log("  ANTHROPIC_API_KEY, OPENAI_API_KEY, CEREBRAS_API_KEY, E2B_API_KEY")
  })

// ─── Project ─────────────────────────────────────────────────────────────────

const projectCmd = program.command("project").description("Manage research projects")

projectCmd
  .command("new")
  .argument("<name>", "Project name")
  .option("--type <type>", "Project type (git_repo, directory, virtual, cloud)", "git_repo")
  .option("--path <path>", "Project path")
  .option("--domain <domain>", "Research domain", "general")
  .option("--metric <metric>", "Metric to optimize", "score")
  .option("--direction <dir>", "Metric direction (lower, higher)", "higher")
  .description("Create a new research project")
  .action(async (name, options) => {
    const db = initDb(getDbPath())
    try {
      const id = createProject(db, {
        name,
        type: options.type,
        path: options.path,
        domain: options.domain,
        metric_name: options.metric,
        metric_direction: options.direction,
      })
      console.log(`Created project: ${name} (${id})`)
      console.log(`  Type: ${options.type}`)
      console.log(`  Domain: ${options.domain}`)
      console.log(`  Metric: ${options.metric} (${options.direction})`)
    } finally {
      db.close()
    }
  })

projectCmd
  .command("list")
  .description("List all projects")
  .action(async () => {
    const db = initDb(getDbPath())
    try {
      const projects = listProjects(db) as Record<string, unknown>[]
      if (isJson()) { console.log(JSON.stringify(projects, null, 2)); return }
      if (projects.length === 0) {
        console.log("No projects. Create one with: researcher project new <name>")
        return
      }
      console.log(`${projects.length} project(s):\n`)
      for (const p of projects) {
        console.log(`  ${p.id}  ${p.name}  [${p.domain}]  ${p.metric_name} (${p.metric_direction})`)
      }
    } finally {
      db.close()
    }
  })

projectCmd
  .command("show")
  .argument("<name>", "Project name or ID")
  .description("Show project details")
  .action(async (name) => {
    const db = initDb(getDbPath())
    try {
      const project = (getProjectByName(db, name) ?? getProject(db, name)) as Record<string, unknown> | null
      if (!project) {
        console.error(`Project not found: ${name}`)
        process.exit(1)
      }
      if (isJson()) { console.log(JSON.stringify(project, null, 2)); return }
      console.log(`Project: ${project.name}`)
      console.log(`  ID: ${project.id}`)
      console.log(`  Type: ${project.type}`)
      console.log(`  Path: ${project.path ?? "none"}`)
      console.log(`  Domain: ${project.domain}`)
      console.log(`  Metric: ${project.metric_name} (${project.metric_direction})`)
      console.log(`  Created: ${project.created_at}`)
    } finally {
      db.close()
    }
  })

projectCmd
  .command("delete")
  .argument("<name>", "Project name or ID")
  .option("-y, --yes", "Skip confirmation")
  .description("Delete a project and all its data")
  .action(async (name, options) => {
    const db = initDb(getDbPath())
    try {
      const project = (getProjectByName(db, name) ?? getProject(db, name)) as Record<string, unknown> | null
      if (!project) {
        console.error(`Project not found: ${name}`)
        process.exit(1)
      }
      if (!options.yes) {
        process.stdout.write(`Delete project "${project.name}" and all its data? (y/n) `)
        const buf = Buffer.alloc(10)
        const n = require("fs").readSync(0, buf, 0, 10, null)
        const answer = buf.toString("utf-8", 0, n).trim().toLowerCase()
        if (answer !== "y" && answer !== "yes") {
          console.log("Cancelled.")
          return
        }
      }
      deleteProject(db, project.id as string)
      console.log(`Deleted project: ${project.name}`)
    } finally {
      db.close()
    }
  })

// ─── Run ─────────────────────────────────────────────────────────────────────

program
  .command("run")
  .argument("<project>", "Project name or ID")
  .option("--cycle <cycle>", "Cycle to use (pflk, gree, etc.)", "pflk")
  .option("--parallel <n>", "Max parallel experiments", "10")
  .option("--goal <description>", "Research goal — what you're trying to achieve")
  .option("--provider <name>", "Override provider for experiment phase (anthropic, openai, cerebras, local)")
  .option("--dry-run", "Preview which providers/models will be used without running")
  .description("Start a research workspace and run experiments")
  .action(async (projectName, options) => {
    const config = loadConfig()
    const db = initDb(getDbPath())
    try {
      const project = (getProjectByName(db, projectName) ?? getProject(db, projectName)) as Record<string, unknown> | null
      if (!project) {
        console.error(`Project not found: ${projectName}`)
        process.exit(1)
      }

      // Load cycle
      const registry = new CycleRegistry()
      await registry.loadBuiltIn()
      const cycle = registry.get(options.cycle)
      if (!cycle) {
        console.error(`Cycle not found: ${options.cycle}. Available: ${registry.list().map(c => c.id).join(", ")}`)
        process.exit(1)
      }

      // Create workspace
      const wsId = createWorkspace(db, {
        project_id: project.id as string,
        cycle_id: cycle.id,
        config: { parallel: parseInt(options.parallel) },
      })

      console.log(`Starting ${cycle.name} cycle on "${project.name}" (workspace: ${wsId})`)
      console.log(`Phases: ${cycle.phases.map(p => p.name).join(" → ")}\n`)

      // Set up provider router
      const router = new ProviderRouter({
        anthropic: config.providers.anthropic ? { apiKey: config.providers.anthropic.api_key } : undefined,
        openai: config.providers.openai ? { apiKey: config.providers.openai.api_key } : undefined,
        cerebras: config.providers.cerebras ? { apiKey: config.providers.cerebras.api_key } : undefined,
        local: config.providers.local ? { baseUrl: config.providers.local.base_url, model: config.providers.local.default_model } : undefined,
        ...(options.provider ? { default_hint: undefined } : {}),
      })

      if (options.provider && !router.hasProvider(options.provider)) {
        console.error(`Provider not available: ${options.provider}. Available: ${router.listProviders().join(", ")}`)
        process.exit(1)
      }

      console.log(`Providers: ${router.listProviders().join(", ")}${options.provider ? ` (experiment override: ${options.provider})` : ""}\n`)
      if (options.goal) console.log(`Goal: ${options.goal}\n`)

      // Dry run — preview only
      if (options.dryRun) {
        console.log("DRY RUN — no LLM calls will be made\n")
        for (let i = 0; i < cycle.phases.length; i++) {
          const phase = cycle.phases[i]!
          const resolved = router.resolve(phase.provider_hint)
          const estCost = phase.type === "parallel_experiment"
            ? `~$${(resolved.estimateCost(2000, 1000) * parseInt(options.parallel)).toFixed(4)}`
            : `~$${resolved.estimateCost(2000, 1000).toFixed(4)}`
          console.log(`  [${i + 1}] ${phase.name} (${phase.type})`)
          console.log(`      Provider: ${resolved.name} | Hint: ${phase.provider_hint} | Est. cost: ${estCost}`)
          if (phase.skills.length > 0) console.log(`      Skills: ${phase.skills.join(", ")}`)
          if (phase.max_parallel > 1) console.log(`      Parallel: ${phase.max_parallel} experiments`)
        }
        console.log(`\nTotal estimated cost: ~$${cycle.phases.reduce((sum, p) => {
          const r = router.resolve(p.provider_hint)
          const base = r.estimateCost(2000, 1000)
          return sum + (p.type === "parallel_experiment" ? base * parseInt(options.parallel) : base)
        }, 0).toFixed(4)}`)
        return
      }

      // Run cycle
      const result = await runCycle({
        db,
        router,
        workspaceId: wsId,
        projectId: project.id as string,
        cycle,
        context: {
          projectName: project.name as string,
          domain: project.domain as string,
          metricName: project.metric_name as string,
          metricDirection: project.metric_direction as string,
          userGoal: options.goal,
        },
        onPhaseStart: (phase, i) => {
          console.log(`[${i + 1}/${cycle.phases.length}] Starting phase: ${phase.name} (${phase.type}, ${phase.provider_hint})`)
        },
        onPhaseComplete: (phase, phaseResult, i) => {
          console.log(`[${i + 1}/${cycle.phases.length}] Completed: ${phase.name} — $${phaseResult.cost.toFixed(4)} (${phaseResult.provider}/${phaseResult.model})`)
          console.log(`  ${phaseResult.summary.slice(0, 200)}...\n`)
        },
      })

      console.log(`\n${"─".repeat(60)}`)
      console.log(`Cycle ${result.success ? "COMPLETED" : "FAILED"}`)
      console.log(`Phases: ${result.phases.length}`)
      console.log(`Total cost: $${result.totalCost.toFixed(4)}`)
      if (result.error) console.log(`Error: ${result.error}`)
    } finally {
      db.close()
    }
  })

// ─── Workspace ───────────────────────────────────────────────────────────────

const workspaceCmd = program.command("workspace").description("Manage research workspaces")

workspaceCmd
  .command("list")
  .option("--project <name>", "Filter by project name")
  .option("--status <status>", "Filter by status (running, paused, completed, failed)")
  .description("List workspaces")
  .action(async (options) => {
    const db = initDb(getDbPath())
    try {
      let workspaces = listWorkspaces(db, options.status) as Record<string, unknown>[]
      if (options.project) {
        const project = (getProjectByName(db, options.project) ?? getProject(db, options.project)) as Record<string, unknown> | null
        if (project) {
          workspaces = workspaces.filter((ws) => ws.project_id === project.id)
        }
      }
      if (workspaces.length === 0) {
        console.log("No workspaces found.")
        return
      }
      console.log(`${workspaces.length} workspace(s):\n`)
      for (const ws of workspaces) {
        console.log(`  ${ws.id}  [${ws.status}]  cycle:${ws.cycle_id}  phase:${ws.current_phase ?? "-"}  $${(ws.cost_total as number).toFixed(4)}`)
      }
    } finally {
      db.close()
    }
  })

workspaceCmd
  .command("delete")
  .argument("<id>", "Workspace ID")
  .description("Delete a workspace and all its data")
  .action(async (id) => {
    const db = initDb(getDbPath())
    try {
      if (deleteWorkspace(db, id)) {
        console.log(`Deleted workspace: ${id}`)
      } else {
        console.error(`Workspace not found: ${id}`)
      }
    } finally {
      db.close()
    }
  })

workspaceCmd
  .command("pause")
  .argument("<id>", "Workspace ID")
  .description("Pause a running workspace")
  .action(async (id) => {
    const db = initDb(getDbPath())
    try {
      const ws = getWorkspace(db, id) as Record<string, unknown> | null
      if (!ws) { console.error(`Workspace not found: ${id}`); process.exit(1) }
      if (ws.status !== "running") { console.error(`Workspace is not running (status: ${ws.status})`); process.exit(1) }
      updateWorkspaceStatus(db, id, "paused")
      console.log(`Paused workspace: ${id}`)
    } finally {
      db.close()
    }
  })

workspaceCmd
  .command("resume")
  .argument("<id>", "Workspace ID")
  .description("Resume a paused workspace")
  .action(async (id) => {
    const db = initDb(getDbPath())
    try {
      const ws = getWorkspace(db, id) as Record<string, unknown> | null
      if (!ws) { console.error(`Workspace not found: ${id}`); process.exit(1) }
      if (ws.status !== "paused") { console.error(`Workspace is not paused (status: ${ws.status})`); process.exit(1) }
      updateWorkspaceStatus(db, id, "running")
      console.log(`Resumed workspace: ${id}`)
    } finally {
      db.close()
    }
  })

// ─── Status ──────────────────────────────────────────────────────────────────

program
  .command("status")
  .argument("[workspace]", "Workspace ID for detail view")
  .description("Show active workspaces and progress")
  .action(async (workspaceId) => {
    const db = initDb(getDbPath())
    try {
      if (workspaceId) {
        const ws = getWorkspace(db, workspaceId) as Record<string, unknown> | null
        if (!ws) {
          console.error(`Workspace not found: ${workspaceId}`)
          process.exit(1)
        }
        console.log(`Workspace: ${ws.id}`)
        console.log(`  Cycle: ${ws.cycle_id}`)
        console.log(`  Phase: ${ws.current_phase ?? "not started"}`)
        console.log(`  Status: ${ws.status}`)
        console.log(`  Cost: $${(ws.cost_total as number).toFixed(4)}`)

        const results = listResults(db, workspaceId) as Record<string, unknown>[]
        if (results.length > 0) {
          console.log(`  Results: ${results.length}`)
        }
      } else {
        const rm = new ResourceManager()
        const status = rm.getStatus(db)
        const workspaces = listWorkspaces(db) as Record<string, unknown>[]
        if (isJson()) { console.log(JSON.stringify({ status, workspaces }, null, 2)); return }
        console.log("Researcher Status")
        console.log(`  Active sandboxes: ${status.activeSandboxes}/${status.maxSandboxes}`)
        console.log(`  Hourly cost: $${status.hourlyCost.toFixed(4)} / $${status.maxHourlyCost}`)
        console.log(`  Daily cost: $${status.dailyCost.toFixed(4)}`)
        console.log(`  Budget: ${status.withinBudget ? "OK" : "EXCEEDED"}\n`)
        if (workspaces.length === 0) {
          console.log("No workspaces. Start one with: researcher run <project>")
        } else {
          console.log(`${workspaces.length} workspace(s):\n`)
          for (const ws of workspaces) {
            console.log(`  ${ws.id}  [${ws.status}]  cycle:${ws.cycle_id}  phase:${ws.current_phase ?? "-"}  $${(ws.cost_total as number).toFixed(4)}`)
          }
        }
      }
    } finally {
      db.close()
    }
  })

// ─── Cost ────────────────────────────────────────────────────────────────────

program
  .command("cost")
  .option("--workspace <id>", "Filter by workspace")
  .option("--today", "Show today's costs only")
  .description("Show cost breakdown by provider and model")
  .action(async (options) => {
    const db = initDb(getDbPath())
    try {
      const rm = new ResourceManager()
      if (options.today) {
        console.log(`Today's cost: $${rm.getDailyCost(db).toFixed(4)}`)
        console.log(`This hour: $${rm.getHourlyCost(db).toFixed(4)}\n`)
      }

      const summary = rm.getCostSummary(db, options.workspace) as Record<string, unknown>[]
      if (summary.length === 0) {
        console.log("No costs recorded yet.")
        return
      }
      console.log("Cost by provider/model:\n")
      let total = 0
      for (const row of summary) {
        const cost = row.total_cost as number
        total += cost
        console.log(`  ${row.provider}/${row.model}`)
        console.log(`    Cost: $${cost.toFixed(4)} | Calls: ${row.call_count} | Tokens: ${row.total_tokens_in}in/${row.total_tokens_out}out`)
      }
      console.log(`\nTotal: $${total.toFixed(4)}`)
    } finally {
      db.close()
    }
  })

// ─── Knowledge ───────────────────────────────────────────────────────────────

program
  .command("knowledge")
  .option("--search <query>", "Search knowledge base")
  .option("--domain <domain>", "Filter by domain")
  .option("--cross-domain", "Show cross-domain patterns")
  .option("--project <id>", "Filter by project")
  .option("--export", "Export as markdown")
  .description("Query accumulated knowledge")
  .action(async (options) => {
    const db = initDb(getDbPath())
    try {
      if (options.export) {
        console.log(exportKnowledgeMarkdown(db, options.project))
        return
      }

      const entries = queryKnowledge(db, {
        domain: options.domain,
        search: options.search,
        project_id: options.project,
      })

      if (entries.length === 0) {
        console.log("No knowledge entries found.")
        return
      }

      console.log(`${entries.length} knowledge entries:\n`)
      for (const entry of entries) {
        console.log(`  [${(entry.confidence * 100).toFixed(0)}%] ${entry.insight}`)
        console.log(`    Domain: ${entry.domain} | Tags: ${entry.tags.join(", ") || "none"}`)
        console.log()
      }
    } finally {
      db.close()
    }
  })

// ─── Cycles ──────────────────────────────────────────────────────────────────

program
  .command("cycles")
  .description("List available research cycles")
  .action(async () => {
    const registry = new CycleRegistry()
    await registry.loadBuiltIn()
    const cycles = registry.list()
    console.log(`${cycles.length} cycle(s):\n`)
    for (const c of cycles) {
      console.log(`  ${c.id} — ${c.name} (${c.author})`)
      console.log(`    Phases: ${c.phases.map(p => p.name).join(" → ")}`)
      console.log(`    ${c.description.slice(0, 120)}`)
      console.log()
    }
  })

// ─── Skills ──────────────────────────────────────────────────────────────────

program
  .command("skills")
  .description("List available skills")
  .action(async () => {
    const { createDefaultRegistry } = await import("../skills/index.ts")
    const registry = createDefaultRegistry()
    const skills = registry.list()
    console.log(`${skills.length} skill(s):\n`)
    for (const s of skills) {
      console.log(`  ${s.name} — ${s.description}`)
      console.log(`    Domains: ${s.domains.join(", ")} | Phases: ${s.phases.join(", ")} | Cost: ${s.cost_per_run}`)
    }
  })

// ─── Config ──────────────────────────────────────────────────────────────────

program
  .command("config")
  .description("Show configuration")
  .action(async () => {
    const config = loadConfig()
    console.log("Configuration:\n")
    console.log(`  Default cycle: ${config.general.default_cycle}`)
    console.log(`  Data dir: ${config.general.data_dir}`)
    console.log(`\nProviders:`)
    for (const [name, prov] of Object.entries(config.providers)) {
      if (prov) {
        console.log(`  ${name}: ${prov.default_model} ${prov.api_key ? "(key set)" : "(no key)"}`)
      }
    }
    console.log(`\nResources:`)
    console.log(`  Max parallel sandboxes: ${config.resources.max_parallel_sandboxes}`)
    console.log(`  Max per workspace: ${config.resources.max_parallel_per_workspace}`)
    console.log(`  Max cost/hour: $${config.resources.max_cost_per_hour}`)
    console.log(`  Max cloud sandboxes: ${config.resources.max_cloud_sandboxes}`)
  })

// ─── MCP ─────────────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Install MCP server for AI agents")
  .option("--claude", "Install for Claude Code")
  .option("--codex", "Install for Codex")
  .option("--gemini", "Install for Gemini")
  .option("--all", "Install for all agents")
  .option("--uninstall", "Uninstall instead of install")
  .action(async (options) => {
    const bunPath = process.execPath
    const mcpScript = new URL("../mcp/index.ts", import.meta.url).pathname

    if (options.claude || options.all) {
      const action = options.uninstall ? "remove" : "add"
      if (options.uninstall) {
        console.log("Removing from Claude Code...")
        Bun.spawnSync(["claude", "mcp", "remove", "researcher"])
      } else {
        console.log("Installing to Claude Code...")
        Bun.spawnSync(["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", "researcher", "--", bunPath, "run", mcpScript])
      }
      console.log(`Claude Code: ${action}d researcher MCP server`)
    }

    if (options.codex || options.all) {
      console.log(`Codex: Add to ~/.codex/config.toml:\n[mcp_servers.researcher]\ncommand = "${bunPath}"\nargs = ["run", "${mcpScript}"]`)
    }

    if (options.gemini || options.all) {
      console.log(`Gemini: Add to ~/.gemini/settings.json mcpServers:\n"researcher": { "command": "${bunPath}", "args": ["run", "${mcpScript}"] }`)
    }

    if (!options.claude && !options.codex && !options.gemini && !options.all) {
      console.log("Specify a target: --claude, --codex, --gemini, or --all")
    }
  })

// ─── Meta ────────────────────────────────────────────────────────────────────

program
  .command("meta")
  .description("Meta-research operations")
  .addCommand(
    new Command("evolve-cycles")
      .description("Let AI propose new research cycles based on historical data")
      .action(async () => {
        console.log("Meta cycle evolution — coming soon. Requires accumulated experiment data.")
      }),
  )

program.parse()
