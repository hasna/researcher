#!/usr/bin/env bun

/**
 * researcher CLI — Universal autonomous experimentation framework.
 */

import { Command } from "commander"
import { table, statusColor, color } from "./table.ts"
import { initDb, createProject, listProjects, getProject, getProjectByName, deleteProject, createWorkspace, listWorkspaces, getWorkspace, listResults, updateWorkspaceStatus, deleteWorkspace } from "../db/index.ts"
import { loadConfig, saveConfig, ensureConfigDir, getDbPath } from "../config/index.ts"
import { ensureGlobalDir, createLocalDir, findProjectRoot, isGitRepo, getGitRemote, resolveDbPath, getLocalDir } from "../storage/paths.ts"
import { registerProject, listRegisteredProjects, getRegisteredProject, updateProjectHealth } from "../storage/registry.ts"
import { CycleRegistry } from "../cycles/registry.ts"
import { exportKnowledgeMarkdown, queryKnowledge } from "../engine/knowledge.ts"
import { ResourceManager } from "../engine/resources.ts"
import { runCycle } from "../engine/cycle-runner.ts"
import { runAgenticPhase, type AgenticPhaseResult } from "../agent/phases.ts"
import { ProviderRouter } from "../providers/router.ts"

const program = new Command()

program
  .name("researcher")
  .description("Universal autonomous experimentation framework")
  .version("0.0.2")
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
  .option("--name <name>", "Project name")
  .option("--domain <domain>", "Research domain", "general")
  .option("--metric <metric>", "Metric to optimize", "score")
  .option("--direction <dir>", "Metric direction (lower, higher)", "higher")
  .option("--global-only", "Only set up global config, skip project init")
  .description("Initialize .researcher/ in the current folder (and global config if needed)")
  .action(async (options) => {
    const cwd = process.cwd()

    // 1. Ensure global ~/.researcher/ exists
    ensureGlobalDir()
    ensureConfigDir()
    const config = loadConfig()
    saveConfig(config)

    if (options.globalOnly) {
      console.log("Initialized global ~/.researcher/")
      console.log("  Config: ~/.researcher/config.toml")
      return
    }

    // 2. Create local .researcher/ in current folder
    const localDir = createLocalDir(cwd)
    const db = initDb(resolveDbPath(cwd))

    // 3. Detect git repo
    const gitRepo = isGitRepo(cwd)
    const gitRemote = gitRepo ? getGitRemote(cwd) : null
    const projectName = options.name ?? require("node:path").basename(cwd)

    // 4. Register in global registry
    registerProject({
      name: projectName,
      path: cwd,
      domain: options.domain,
      metric_name: options.metric,
      metric_direction: options.direction,
    })

    // 5. Create project in local DB
    const existingProject = getProjectByName(db, projectName)
    if (!existingProject) {
      createProject(db, {
        name: projectName,
        type: gitRepo ? "git_repo" : "directory",
        path: cwd,
        remote_url: gitRemote ?? undefined,
        domain: options.domain,
        metric_name: options.metric,
        metric_direction: options.direction,
      })
    }

    db.close()

    console.log(`Initialized ${localDir}`)
    console.log(`  Project: ${projectName}`)
    console.log(`  Domain: ${options.domain}`)
    console.log(`  Metric: ${options.metric} (${options.direction})`)
    console.log(`  Git repo: ${gitRepo ? `yes${gitRemote ? ` (${gitRemote})` : ""}` : "no"}`)
    console.log(`  Registered in global registry`)

    // 6. Suggest .gitignore
    if (gitRepo) {
      const { existsSync, readFileSync, appendFileSync } = require("node:fs")
      const giPath = require("node:path").join(cwd, ".gitignore")
      if (existsSync(giPath)) {
        const content = readFileSync(giPath, "utf-8")
        if (!content.includes(".researcher")) {
          appendFileSync(giPath, "\n# Researcher experiment data\n.researcher/\n")
          console.log(`  Added .researcher/ to .gitignore`)
        }
      }
    }

    console.log(`\nRun experiments: researcher run ${projectName}`)
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
      console.log(table(
        ["ID", "Name", "Domain", "Metric", "Direction"],
        projects.map(p => [String(p.id), String(p.name), String(p.domain), String(p.metric_name), String(p.metric_direction)])
      ))
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
  .option("--continuous", "Run cycles in a loop until stopped (Ctrl+C)")
  .option("--resume <workspace>", "Resume a failed workspace from the last successful phase")
  .option("--agentic", "Use agentic loops — each phase loops with tools instead of single LLM call")
  .description("Start a research workspace and run experiments")
  .action(async (projectName, options) => {
    const config = loadConfig()

    // Resolve project: check registry first, then try local/global DB
    const registered = getRegisteredProject(projectName)
    const dbPath = registered ? resolveDbPath(registered.path) : getDbPath()
    const db = initDb(dbPath)

    try {
      const project = (getProjectByName(db, projectName) ?? getProject(db, projectName)) as Record<string, unknown> | null
      if (!project) {
        console.error(`Project not found: ${projectName}`)
        if (registered) console.error(`  (registered at ${registered.path} but not in local DB — try 'researcher init' there)`)
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

      // Create or resume workspace
      let wsId: string
      let resumeFromPhase: number | undefined
      if (options.resume) {
        const existingWs = getWorkspace(db, options.resume) as Record<string, unknown> | null
        if (!existingWs) { console.error(`Workspace not found: ${options.resume}`); process.exit(1) }
        if (existingWs.status !== "failed" && existingWs.status !== "paused") {
          console.error(`Workspace is not failed/paused (status: ${existingWs.status}). Can only resume failed or paused workspaces.`)
          process.exit(1)
        }
        wsId = options.resume
        // Find which phase to resume from
        const failedPhase = existingWs.current_phase as string
        resumeFromPhase = cycle.phases.findIndex(p => p.name === failedPhase)
        if (resumeFromPhase < 0) resumeFromPhase = 0
        updateWorkspaceStatus(db, wsId, "running")
        console.log(`Resuming workspace ${wsId} from phase "${failedPhase}" (index ${resumeFromPhase})`)
      } else {
        wsId = createWorkspace(db, {
          project_id: project.id as string,
          cycle_id: cycle.id,
          config: { parallel: parseInt(options.parallel) },
        })
      }

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

      // Continuous mode — loop until Ctrl+C
      let stopped = false
      if (options.continuous) {
        process.on("SIGINT", () => { stopped = true; console.log("\nStopping after current cycle...") })
      }

      let cycleNum = 0
      let previousKnowledge = ""
      do {
        cycleNum++
        if (cycleNum > 1) {
          // Create a new workspace for each loop iteration
          const newWsId = createWorkspace(db, { project_id: project.id as string, cycle_id: cycle.id, config: { parallel: parseInt(options.parallel) } })
          console.log(`\n${"═".repeat(60)}\nContinuous cycle #${cycleNum} (workspace: ${newWsId})\n`)
          var currentWsId = newWsId
        } else {
          var currentWsId = wsId
        }

        // Check budget
        const rm = new ResourceManager()
        if (!rm.isWithinBudget(db)) {
          console.log("Hourly budget exceeded. Waiting 60s...")
          await new Promise((r) => setTimeout(r, 60_000))
          if (stopped) break
          continue
        }

        let result: { success: boolean; phases: { phaseName: string; summary: string; cost: number; provider?: string; model?: string }[]; totalCost: number; error?: string }

        if (options.agentic) {
          // ─── Agentic mode: each phase is a mini-agent with tools and loop ───
          const agenticPhases: AgenticPhaseResult[] = []
          let agenticCost = 0
          let agenticContext = `# Research Context\nProject: ${project.name}\nDomain: ${project.domain}\nMetric: ${project.metric_name} (${project.metric_direction})\n${options.goal ? `Goal: ${options.goal}\n` : ""}${previousKnowledge ? `\nPrevious Knowledge:\n${previousKnowledge}\n` : ""}`

          const { updateWorkspacePhase, updateWorkspaceStatus } = await import("../db/index.ts")

          for (let i = 0; i < cycle.phases.length; i++) {
            const phase = cycle.phases[i]!
            updateWorkspacePhase(db, currentWsId, phase.name)
            const start = Date.now()
            console.log(`  \x1b[36m▸\x1b[0m [${i + 1}/${cycle.phases.length}] ${phase.name} (${phase.type}, agentic)`)

            try {
              const phaseResult = await runAgenticPhase({
                db,
                router,
                workspaceId: currentWsId,
                projectId: project.id as string,
                phase,
                accumulatedContext: agenticContext,
                domain: project.domain as string,
                metricName: project.metric_name as string,
                metricDirection: project.metric_direction as "lower" | "higher",
                onAgentIteration: (phaseName, iteration, thought) => {
                  console.log(`    \x1b[2m[${phaseName} iter ${iteration}] ${thought.slice(0, 150)}\x1b[0m`)
                },
              })

              const elapsed = ((Date.now() - start) / 1000).toFixed(1)
              agenticPhases.push(phaseResult)
              agenticCost += phaseResult.cost
              agenticContext += `\n\n## Phase: ${phase.name}\n${phaseResult.summary}`

              console.log(`  \x1b[32m✓\x1b[0m [${i + 1}/${cycle.phases.length}] ${phase.name} — $${phaseResult.cost.toFixed(4)} — ${phaseResult.iterations} iters, ${phaseResult.toolCalls} tool calls${phaseResult.childAgents > 0 ? `, ${phaseResult.childAgents} child agents` : ""} — ${elapsed}s`)
              console.log(`    ${phaseResult.summary.slice(0, 300)}...\n`)
            } catch (err) {
              const elapsed = ((Date.now() - start) / 1000).toFixed(1)
              console.log(`  \x1b[31m✗\x1b[0m [${i + 1}/${cycle.phases.length}] ${phase.name} — FAILED after ${elapsed}s: ${err instanceof Error ? err.message : String(err)}`)
              updateWorkspaceStatus(db, currentWsId, "failed")
              break
            }
          }

          updateWorkspaceStatus(db, currentWsId, "completed")
          result = {
            success: agenticPhases.every(p => p.success),
            phases: agenticPhases.map(p => ({ phaseName: p.phaseName, summary: p.summary, cost: p.cost })),
            totalCost: agenticCost,
          }
        } else {
          // ─── Standard mode: single LLM call per phase ───
          result = await runCycle({
            db,
            router,
            workspaceId: currentWsId,
            projectId: project.id as string,
            cycle,
            resumeFromPhase: cycleNum === 1 ? resumeFromPhase : undefined,
            context: {
              projectName: project.name as string,
              domain: project.domain as string,
              metricName: project.metric_name as string,
              metricDirection: project.metric_direction as string,
              userGoal: options.goal,
              previousKnowledge: previousKnowledge || undefined,
            },
            onPhaseStart: (phase, i) => {
              const spinner = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
              let frame = 0
              const start = Date.now()
              const interval = setInterval(() => {
                const elapsed = ((Date.now() - start) / 1000).toFixed(0)
                process.stdout.write(`\r  ${spinner[frame++ % spinner.length]} [${i + 1}/${cycle.phases.length}] ${phase.name} (${phase.provider_hint}) — ${elapsed}s`)
              }, 100)
              ;(phase as unknown as Record<string, unknown>)._interval = interval
              ;(phase as unknown as Record<string, unknown>)._start = start
            },
            onPhaseComplete: (phase, phaseResult, i) => {
              const interval = (phase as unknown as Record<string, unknown>)._interval as ReturnType<typeof setInterval> | undefined
              if (interval) clearInterval(interval)
              const start = (phase as unknown as Record<string, unknown>)._start as number | undefined
              const elapsed = start ? ((Date.now() - start) / 1000).toFixed(1) : "?"
              process.stdout.write(`\r`)
              console.log(`  \x1b[32m✓\x1b[0m [${i + 1}/${cycle.phases.length}] ${phase.name} — $${phaseResult.cost.toFixed(4)} (${phaseResult.provider}/${phaseResult.model}) ${elapsed}s`)
              console.log(`    ${phaseResult.summary.slice(0, 200)}...\n`)
            },
          })
        }

        console.log(`\n${"─".repeat(60)}`)
        console.log(`Cycle ${result.success ? "COMPLETED" : "FAILED"}`)
        console.log(`Phases: ${result.phases.length}`)
        console.log(`Total cost: $${result.totalCost.toFixed(4)}`)
        if (result.error) console.log(`Error: ${result.error}`)

        // Feed knowledge forward for continuous mode
        const lastPhase = result.phases[result.phases.length - 1]
        if (lastPhase?.summary) {
          previousKnowledge = lastPhase.summary.slice(0, 2000)
        }
      } while (options.continuous && !stopped)
    } finally {
      db.close()
    }
  })

// ─── Health ──────────────────────────────────────────────────────────────────

program
  .command("health")
  .argument("[project]", "Project name (or check all)")
  .option("--fix", "Clean up failed sandboxes and stale data")
  .description("Check health of all registered projects")
  .action(async (projectName, options) => {
    const projects = projectName
      ? [getRegisteredProject(projectName)].filter(Boolean) as import("../storage/registry.ts").RegisteredProject[]
      : listRegisteredProjects()

    if (projects.length === 0) {
      console.log("No registered projects. Run 'researcher init' in a project folder.")
      return
    }

    if (isJson()) { console.log(JSON.stringify(projects, null, 2)); return }

    console.log(`Health Report — ${projects.length} project(s)\n`)
    for (const p of projects) {
      const { existsSync } = require("node:fs")
      const exists = existsSync(getLocalDir(p.path))

      // Determine health
      let health = "unknown"
      if (!exists) {
        health = "missing"
      } else if (!p.last_run_at) {
        health = "new"
      } else {
        const lastRun = new Date(p.last_run_at).getTime()
        const daysAgo = (Date.now() - lastRun) / (1000 * 60 * 60 * 24)
        if (daysAgo > 30) health = "stale"
        else if (p.health_status === "failing") health = "failing"
        else health = "healthy"
      }

      const icon = health === "healthy" ? "\x1b[32m●\x1b[0m"
        : health === "stale" ? "\x1b[33m●\x1b[0m"
        : health === "failing" ? "\x1b[31m●\x1b[0m"
        : health === "missing" ? "\x1b[31m✗\x1b[0m"
        : "\x1b[2m●\x1b[0m"

      console.log(`  ${icon} ${p.name}`)
      console.log(`    Path: ${p.path}${!exists ? " (MISSING)" : ""}`)
      console.log(`    Domain: ${p.domain} | Metric: ${p.metric_name} (${p.metric_direction})`)
      console.log(`    Git: ${p.is_git_repo ? "yes" : "no"}${p.git_remote ? ` (${p.git_remote})` : ""}`)
      console.log(`    Experiments: ${p.total_experiments} | Cost: $${p.total_cost.toFixed(4)} | Last run: ${p.last_run_at ?? "never"}`)
      console.log()

      // Update health in registry
      if (health !== "missing") {
        updateProjectHealth(p.path, health as "healthy" | "stale" | "failing" | "unknown")
      }
    }

    if (options.fix) {
      console.log("Cleaning up...")
      // Remove projects that no longer exist on disk
      let removed = 0
      for (const p of projects) {
        const { existsSync } = require("node:fs")
        if (!existsSync(getLocalDir(p.path))) {
          const { unregisterProject } = await import("../storage/registry.ts")
          unregisterProject(p.path)
          removed++
          console.log(`  Removed missing project: ${p.name}`)
        }
      }
      if (removed === 0) console.log("  Nothing to clean up.")
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

// ─── Diff ────────────────────────────────────────────────────────────────────

program
  .command("diff")
  .argument("<result-id>", "Result ID")
  .description("Show the file diff from an experiment result")
  .action(async (resultId) => {
    const db = initDb(getDbPath())
    try {
      const result = db.query("SELECT * FROM results WHERE id = ?").get(resultId) as Record<string, unknown> | null
      if (!result) { console.error(`Result not found: ${resultId}`); process.exit(1) }
      if (!result.diff) { console.log("No diff recorded for this result."); return }
      console.log(result.diff)
    } finally {
      db.close()
    }
  })

// ─── History ─────────────────────────────────────────────────────────────────

program
  .command("history")
  .argument("<project>", "Project name or ID")
  .option("--limit <n>", "Limit results", "20")
  .description("Show experiment history for a project")
  .action(async (projectName, options) => {
    const db = initDb(getDbPath())
    try {
      const project = (getProjectByName(db, projectName) ?? getProject(db, projectName)) as Record<string, unknown> | null
      if (!project) { console.error(`Project not found: ${projectName}`); process.exit(1) }

      const workspaces = (listWorkspaces(db) as Record<string, unknown>[])
        .filter(ws => ws.project_id === project.id)
        .slice(0, parseInt(options.limit))

      if (isJson()) { console.log(JSON.stringify(workspaces, null, 2)); return }

      if (workspaces.length === 0) {
        console.log(`No history for project "${project.name}".`)
        return
      }

      console.log(`History for "${project.name}" (${workspaces.length} runs):\n`)
      for (const ws of workspaces) {
        const status = ws.status === "completed" ? "OK" : ws.status === "failed" ? "FAIL" : String(ws.status).toUpperCase()
        console.log(`  ${ws.created_at}  ${ws.id}  [${status}]  ${ws.cycle_id}  phase:${ws.current_phase ?? "-"}  $${(ws.cost_total as number).toFixed(4)}`)
      }

      const totalCost = workspaces.reduce((sum, ws) => sum + (ws.cost_total as number), 0)
      const completed = workspaces.filter(ws => ws.status === "completed").length
      console.log(`\nTotal: ${workspaces.length} runs, ${completed} completed, $${totalCost.toFixed(4)}`)
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

      if (isJson()) { console.log(JSON.stringify(entries, null, 2)); return }
      console.log(`${entries.length} knowledge entries:\n`)
      for (const entry of entries) {
        console.log(`  [${(entry.confidence * 100).toFixed(0)}%] ${entry.insight.slice(0, 200)}`)
        console.log(`    ID: ${entry.id} | Domain: ${entry.domain} | Tags: ${entry.tags.join(", ") || "none"}`)
        console.log()
      }
    } finally {
      db.close()
    }
  })

program
  .command("knowledge-delete")
  .argument("<id>", "Knowledge entry ID")
  .description("Delete a knowledge entry")
  .action(async (id) => {
    const db = initDb(getDbPath())
    try {
      const result = db.run("DELETE FROM knowledge WHERE id = ?", [id])
      if (result.changes > 0) {
        console.log(`Deleted knowledge entry: ${id}`)
      } else {
        console.error(`Knowledge entry not found: ${id}`)
      }
    } finally {
      db.close()
    }
  })

// ─── Templates ───────────────────────────────────────────────────────────────

const templateCmd = program.command("template").description("Manage project templates")

templateCmd
  .command("list")
  .description("List available templates")
  .action(async () => {
    const { readdirSync, readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const templatesDir = join(import.meta.dir, "../../templates")
    try {
      const dirs = readdirSync(templatesDir, { withFileTypes: true })
        .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
      if (dirs.length === 0) { console.log("No templates found."); return }
      console.log(`${dirs.length} template(s):\n`)
      for (const dir of dirs) {
        const yamlPath = join(templatesDir, dir.name, "template.yaml")
        try {
          const { parse } = require("yaml")
          const meta = parse(readFileSync(yamlPath, "utf-8"))
          console.log(`  ${dir.name}`)
          console.log(`    Domain: ${meta.domain ?? "general"} | Metric: ${meta.default_metric ?? "score"} (${meta.default_metric_direction ?? "higher"})`)
          console.log(`    Cycle: ${meta.suggested_cycle ?? "pflk"} | ${meta.description?.slice(0, 100) ?? ""}`)
          console.log()
        } catch {
          console.log(`  ${dir.name} (no template.yaml)`)
        }
      }
    } catch {
      console.log("Templates directory not found.")
    }
  })

templateCmd
  .command("use")
  .argument("<template>", "Template name")
  .argument("<dir>", "Target directory")
  .description("Scaffold a project from a template")
  .action(async (template, dir) => {
    const { cpSync, existsSync, mkdirSync, readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const templatesDir = join(import.meta.dir, "../../templates")
    const srcDir = join(templatesDir, template)
    if (!existsSync(srcDir)) {
      console.error(`Template not found: ${template}`)
      process.exit(1)
    }
    mkdirSync(dir, { recursive: true })
    cpSync(srcDir, dir, { recursive: true })
    console.log(`Scaffolded "${template}" template into ${dir}`)

    // Read template metadata and create project
    try {
      const { parse } = require("yaml")
      const meta = parse(readFileSync(join(srcDir, "template.yaml"), "utf-8"))
      const db = initDb(getDbPath())
      const name = require("node:path").basename(dir)
      const id = createProject(db, {
        name,
        type: "directory",
        path: require("node:path").resolve(dir),
        domain: meta.domain ?? "general",
        metric_name: meta.default_metric ?? "score",
        metric_direction: meta.default_metric_direction ?? "higher",
      })
      db.close()
      console.log(`Created project: ${name} (${id})`)
    } catch {
      console.log("Note: Could not auto-create project. Use 'researcher project new' manually.")
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

program
  .command("cycle-new")
  .option("--ai", "Let AI generate the cycle definition")
  .option("--domain <domain>", "Target domain")
  .option("--problem <desc>", "Problem description")
  .description("Create a new research cycle")
  .action(async (options) => {
    if (options.ai) {
      const config = loadConfig()
      const router = new ProviderRouter({
        anthropic: config.providers.anthropic ? { apiKey: config.providers.anthropic.api_key } : undefined,
        openai: config.providers.openai ? { apiKey: config.providers.openai.api_key } : undefined,
        cerebras: config.providers.cerebras ? { apiKey: config.providers.cerebras.api_key } : undefined,
      })

      console.log("Generating new cycle via AI...\n")
      const { proposeCycle, saveCycle, analyzeCyclePerformance } = await import("../engine/meta.ts")
      const db = initDb(getDbPath())
      const analysis = await analyzeCyclePerformance(db)

      const cycle = await proposeCycle(router, {
        existingCycles: analysis,
        domain: options.domain,
        problem: options.problem,
      })

      if (!cycle) {
        console.error("AI failed to generate a valid cycle.")
        db.close()
        return
      }

      console.log(`Generated: ${cycle.name}`)
      console.log(`Phases: ${cycle.phases.map(p => p.name).join(" → ")}`)
      console.log(`Description: ${cycle.description}\n`)

      // Save to DB and filesystem
      saveCycle(db, cycle)
      const { writeFileSync } = require("node:fs")
      const { join } = require("node:path")
      const { stringify } = require("yaml")
      const defDir = join(import.meta.dir, "../cycles/definitions")
      const filename = `${cycle.id}.yaml`
      writeFileSync(join(defDir, filename), stringify({ name: cycle.name, description: cycle.description, author: "ai", phases: cycle.phases }))
      console.log(`Saved: ${filename}`)
      db.close()
    } else {
      console.log("Manual cycle creation: create a YAML file and use 'researcher cycles add <file>'")
      console.log("Or use --ai to let AI generate one.")
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

// ─── Benchmark ───────────────────────────────────────────────────────────────

program
  .command("benchmark")
  .argument("<project>", "Project name or ID")
  .option("--command <cmd>", "Evaluation command (overrides project config)")
  .option("--save", "Save result to database")
  .description("Run a quick benchmark without a full cycle")
  .action(async (projectName, options) => {
    const db = initDb(getDbPath())
    try {
      const project = (getProjectByName(db, projectName) ?? getProject(db, projectName)) as Record<string, unknown> | null
      if (!project) { console.error(`Project not found: ${projectName}`); process.exit(1) }

      const config = JSON.parse((project.config as string) ?? "{}")
      const command = options.command ?? config.evaluation_command
      if (!command) {
        console.error("No evaluation command. Use --command or set evaluation_command in project config.")
        process.exit(1)
      }

      console.log(`Running benchmark for "${project.name}"...`)
      console.log(`Command: ${command}\n`)

      const start = performance.now()
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: (project.path as string) ?? process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      const elapsed = ((performance.now() - start) / 1000).toFixed(1)

      if (exitCode !== 0) {
        console.error(`Benchmark failed (exit ${exitCode}):\n${stderr}`)
        process.exit(1)
      }

      const { parseMetrics } = await import("../engine/parallel.ts")
      const metrics = parseMetrics(stdout, project.metric_name as string)

      if (isJson()) { console.log(JSON.stringify({ metrics, elapsed_seconds: parseFloat(elapsed), exitCode }, null, 2)); return }

      console.log(`Results (${elapsed}s):\n`)
      for (const [k, v] of Object.entries(metrics)) {
        console.log(`  ${k}: ${v}`)
      }

      if (options.save) {
        const { createWorkspace: cw, createSandbox: cs, createResult: cr } = await import("../db/index.ts")
        const wsId = cw(db, { project_id: project.id as string, cycle_id: "benchmark" })
        const sbId = cs(db, { workspace_id: wsId, type: "tempdir", hypothesis: "baseline benchmark" })
        cr(db, { sandbox_id: sbId, workspace_id: wsId, metrics, decision: "keep", provider: "local", model: "benchmark" })
        console.log(`\nSaved to workspace: ${wsId}`)
      }
    } finally {
      db.close()
    }
  })

// ─── Export ──────────────────────────────────────────────────────────────────

program
  .command("export")
  .argument("<project>", "Project name or ID")
  .option("--format <fmt>", "Output format (md, json)", "md")
  .description("Export all project data as a report")
  .action(async (projectName, options) => {
    const db = initDb(getDbPath())
    try {
      const project = (getProjectByName(db, projectName) ?? getProject(db, projectName)) as Record<string, unknown> | null
      if (!project) { console.error(`Project not found: ${projectName}`); process.exit(1) }

      const workspaces = (listWorkspaces(db) as Record<string, unknown>[]).filter(ws => ws.project_id === project.id)
      const knowledge = queryKnowledge(db, { project_id: project.id as string })

      if (options.format === "json") {
        console.log(JSON.stringify({ project, workspaces, knowledge }, null, 2))
        return
      }

      // Markdown export
      let md = `# Research Report: ${project.name}\n\n`
      md += `- **Domain**: ${project.domain}\n`
      md += `- **Metric**: ${project.metric_name} (${project.metric_direction})\n`
      md += `- **Type**: ${project.type}\n`
      md += `- **Created**: ${project.created_at}\n\n`

      md += `## Workspaces (${workspaces.length})\n\n`
      for (const ws of workspaces) {
        md += `### ${ws.id}\n`
        md += `- Cycle: ${ws.cycle_id} | Status: ${ws.status} | Cost: $${(ws.cost_total as number).toFixed(4)}\n`
        md += `- Phase: ${ws.current_phase ?? "-"} | Created: ${ws.created_at}\n\n`
      }

      if (knowledge.length > 0) {
        md += `## Knowledge (${knowledge.length})\n\n`
        for (const k of knowledge) {
          md += `### [${(k.confidence * 100).toFixed(0)}%] ${k.insight.slice(0, 200)}\n`
          md += `- Domain: ${k.domain} | Tags: ${k.tags.join(", ") || "none"}\n\n`
        }
      }

      const totalCost = workspaces.reduce((sum, ws) => sum + (ws.cost_total as number), 0)
      md += `## Summary\n\n`
      md += `- Total runs: ${workspaces.length}\n`
      md += `- Completed: ${workspaces.filter(ws => ws.status === "completed").length}\n`
      md += `- Total cost: $${totalCost.toFixed(4)}\n`
      md += `- Knowledge entries: ${knowledge.length}\n`

      console.log(md)
    } finally {
      db.close()
    }
  })

// ─── Doctor ──────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Run diagnostic checks on researcher setup")
  .action(async () => {
    const { existsSync } = require("node:fs")
    const { join } = require("node:path")
    const home = process.env.HOME ?? "."
    const checks: { name: string; ok: boolean; detail: string }[] = []

    // Config
    const configPath = join(home, ".researcher", "config.toml")
    checks.push({ name: "Config file", ok: existsSync(configPath), detail: configPath })

    // Database
    const dbPath = join(home, ".researcher", "researcher.db")
    checks.push({ name: "Database", ok: existsSync(dbPath), detail: dbPath })

    // Providers
    const config = loadConfig()
    for (const [name, prov] of Object.entries(config.providers)) {
      if (prov) {
        checks.push({ name: `Provider: ${name}`, ok: !!prov.api_key || name === "local", detail: prov.default_model })
      }
    }
    if (!config.providers.anthropic && !config.providers.openai && !config.providers.cerebras) {
      checks.push({ name: "Any cloud provider", ok: false, detail: "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or CEREBRAS_API_KEY" })
    }

    // E2B
    checks.push({ name: "E2B", ok: !!config.e2b?.api_key, detail: config.e2b?.api_key ? "key set" : "E2B_API_KEY not set (optional)" })

    // Git
    const gitCheck = Bun.spawnSync(["git", "--version"])
    checks.push({ name: "Git", ok: gitCheck.exitCode === 0, detail: gitCheck.stdout.toString().trim() })

    // Cycles
    const { CycleRegistry } = await import("../cycles/registry.ts")
    const reg = new CycleRegistry()
    await reg.loadBuiltIn()
    checks.push({ name: "Cycle definitions", ok: reg.list().length > 0, detail: `${reg.list().length} cycles loaded` })

    // Skills
    const { createDefaultRegistry } = await import("../skills/index.ts")
    const skillReg = createDefaultRegistry()
    checks.push({ name: "Skills", ok: skillReg.list().length > 0, detail: `${skillReg.list().length} skills loaded` })

    // Print results
    console.log("Researcher Doctor\n")
    for (const check of checks) {
      const icon = check.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"
      console.log(`  ${icon} ${check.name}: ${check.detail}`)
    }
    const passed = checks.filter(c => c.ok).length
    console.log(`\n${passed}/${checks.length} checks passed`)
  })

// ─── Compare ─────────────────────────────────────────────────────────────────

program
  .command("compare")
  .argument("<ws1>", "First workspace ID")
  .argument("<ws2>", "Second workspace ID")
  .description("Compare two workspace runs side by side")
  .action(async (ws1Id, ws2Id) => {
    const db = initDb(getDbPath())
    try {
      const ws1 = getWorkspace(db, ws1Id) as Record<string, unknown> | null
      const ws2 = getWorkspace(db, ws2Id) as Record<string, unknown> | null
      if (!ws1) { console.error(`Workspace not found: ${ws1Id}`); process.exit(1) }
      if (!ws2) { console.error(`Workspace not found: ${ws2Id}`); process.exit(1) }

      if (isJson()) { console.log(JSON.stringify({ ws1, ws2 }, null, 2)); return }

      console.log("Workspace Comparison\n")
      const fields = ["id", "cycle_id", "status", "current_phase", "cost_total", "created_at"]
      console.log(`${"Field".padEnd(20)} ${"Workspace 1".padEnd(30)} Workspace 2`)
      console.log("─".repeat(80))
      for (const f of fields) {
        const v1 = f === "cost_total" ? `$${(ws1[f] as number).toFixed(4)}` : String(ws1[f] ?? "-")
        const v2 = f === "cost_total" ? `$${(ws2[f] as number).toFixed(4)}` : String(ws2[f] ?? "-")
        const marker = v1 !== v2 ? " *" : ""
        console.log(`${f.padEnd(20)} ${v1.padEnd(30)} ${v2}${marker}`)
      }
    } finally {
      db.close()
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

// ─── Serve ───────────────────────────────────────────────────────────────────

program
  .command("serve")
  .option("--port <port>", "Port to listen on", "7070")
  .description("Start REST API server")
  .action(async (options) => {
    const { startServer } = await import("../api/server.ts")
    startServer(parseInt(options.port))
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
