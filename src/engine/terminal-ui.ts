/**
 * Terminal UI — rich progress display for cycle execution.
 *
 * Connects to the event emitter and renders:
 * - Current phase with spinner
 * - Experiment tree with status
 * - Live metrics and cost accumulator
 * - Knowledge count
 */

import type { ResearchEventEmitter, TypedResearchEvent } from "./events.ts"

export interface TerminalUIConfig {
  /** Show individual agent iterations (verbose, default: false) */
  showIterations?: boolean
  /** Show cost updates (default: true) */
  showCost?: boolean
  /** Use colors (default: true) */
  colors?: boolean
}

/**
 * Attach terminal UI to an event emitter. Returns unsubscribe function.
 */
export function attachTerminalUI(
  emitter: ResearchEventEmitter,
  config: TerminalUIConfig = {},
): () => void {
  const { showIterations = false, showCost = true, colors = true } = config

  const c = {
    reset: colors ? "\x1b[0m" : "",
    dim: colors ? "\x1b[2m" : "",
    cyan: colors ? "\x1b[36m" : "",
    green: colors ? "\x1b[32m" : "",
    red: colors ? "\x1b[31m" : "",
    yellow: colors ? "\x1b[33m" : "",
    bold: colors ? "\x1b[1m" : "",
    magenta: colors ? "\x1b[35m" : "",
  }

  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  let spinnerFrame = 0
  let spinnerInterval: ReturnType<typeof setInterval> | null = null
  let currentPhase = ""
  let phaseStart = 0
  let totalCost = 0
  let knowledgeCount = 0
  let experimentCount = 0

  function startSpinner(label: string) {
    stopSpinner()
    phaseStart = Date.now()
    currentPhase = label
    spinnerInterval = setInterval(() => {
      const elapsed = ((Date.now() - phaseStart) / 1000).toFixed(0)
      process.stdout.write(`\r  ${spinner[spinnerFrame++ % spinner.length]} ${c.cyan}${currentPhase}${c.reset} ${c.dim}${elapsed}s${c.reset}`)
    }, 100)
  }

  function stopSpinner() {
    if (spinnerInterval) {
      clearInterval(spinnerInterval)
      spinnerInterval = null
      process.stdout.write("\r" + " ".repeat(80) + "\r")
    }
  }

  const unsub = emitter.onAny((event: TypedResearchEvent) => {
    switch (event.type) {
      case "cycle:start": {
        const d = event.data as { cycleName: string; phaseCount: number; mode: string }
        console.log(`\n${c.bold}${c.cyan}━━━ ${d.cycleName} ━━━${c.reset} ${c.dim}(${d.phaseCount} phases, ${d.mode} mode)${c.reset}\n`)
        totalCost = 0
        knowledgeCount = 0
        experimentCount = 0
        break
      }
      case "phase:start": {
        const d = event.data as { phaseName: string; phaseType: string; phaseIndex: number; totalPhases: number; providerHint: string }
        startSpinner(`[${d.phaseIndex + 1}/${d.totalPhases}] ${d.phaseName} (${d.phaseType}, ${d.providerHint})`)
        break
      }
      case "phase:complete": {
        stopSpinner()
        const d = event.data as { phaseName: string; success: boolean; cost: number; durationMs: number; summary: string }
        totalCost += d.cost
        const icon = d.success ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`
        const elapsed = (d.durationMs / 1000).toFixed(1)
        console.log(`  ${icon} ${d.phaseName} — $${d.cost.toFixed(4)} — ${elapsed}s`)
        console.log(`    ${c.dim}${d.summary.slice(0, 250)}${d.summary.length > 250 ? "..." : ""}${c.reset}\n`)
        break
      }
      case "phase:error": {
        stopSpinner()
        const d = event.data as { phaseName: string; error: string }
        console.log(`  ${c.red}✗ ${d.phaseName} — ERROR: ${d.error}${c.reset}\n`)
        break
      }
      case "experiment:start": {
        const d = event.data as { experimentIndex: number; totalExperiments: number; hypothesis: string }
        experimentCount++
        if (showIterations) {
          console.log(`    ${c.dim}[exp ${d.experimentIndex + 1}/${d.totalExperiments}] ${d.hypothesis.slice(0, 100)}${c.reset}`)
        }
        break
      }
      case "experiment:ranked": {
        const d = event.data as { total: number; completed: number; crashed: number; winner?: { hypothesis: string; metrics: Record<string, number> } }
        console.log(`    ${c.magenta}Experiments: ${d.completed}/${d.total} completed, ${d.crashed} crashed${c.reset}`)
        if (d.winner) {
          console.log(`    ${c.green}Winner: ${d.winner.hypothesis.slice(0, 100)}${c.reset}`)
          console.log(`    ${c.dim}Metrics: ${JSON.stringify(d.winner.metrics)}${c.reset}`)
        }
        break
      }
      case "agent:iteration": {
        if (showIterations) {
          const d = event.data as { agentName: string; iteration: number; thought: string }
          console.log(`    ${c.dim}[${d.agentName} #${d.iteration}] ${d.thought.slice(0, 150)}${c.reset}`)
        }
        break
      }
      case "knowledge:saved": {
        knowledgeCount++
        const d = event.data as { insight: string; confidence: number; domain: string }
        console.log(`    ${c.yellow}💡 Knowledge (${(d.confidence * 100).toFixed(0)}%): ${d.insight.slice(0, 150)}${c.reset}`)
        break
      }
      case "cost:update": {
        if (showCost) {
          const d = event.data as { totalCost: number }
          totalCost = d.totalCost
        }
        break
      }
      case "cycle:complete": {
        stopSpinner()
        const d = event.data as { success: boolean; totalCost: number; phasesCompleted: number }
        console.log(`\n${c.bold}${d.success ? c.green : c.red}━━━ Cycle ${d.success ? "COMPLETED" : "FAILED"} ━━━${c.reset}`)
        console.log(`  Phases: ${d.phasesCompleted} | Cost: $${d.totalCost.toFixed(4)} | Knowledge: ${knowledgeCount} | Experiments: ${experimentCount}`)
        console.log()
        break
      }
      case "cycle:error": {
        stopSpinner()
        const d = event.data as { phase: string; error: string }
        console.log(`\n${c.red}${c.bold}━━━ Cycle FAILED ━━━${c.reset}`)
        console.log(`  ${c.red}Error in ${d.phase}: ${d.error}${c.reset}\n`)
        break
      }
    }
  })

  return () => {
    stopSpinner()
    unsub()
  }
}
