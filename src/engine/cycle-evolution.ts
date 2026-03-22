/**
 * Evolutionary Cycle Mutation — mutate, crossover, and evolve cycle definitions
 * using genetic algorithm principles.
 *
 * Operators:
 *   - swap_phases: reorder two phases
 *   - change_provider_hint: adjust a phase's provider hint
 *   - adjust_parallelism: change max_parallel for experiment phases
 *   - add_phase: insert a new phase
 *   - remove_phase: remove a phase (min 2 phases)
 *   - duplicate_phase: clone a phase with a different hint
 *
 * The evolve() function runs multi-generation selection:
 *   mutate → benchmark → keep winners → repeat.
 */

import type { Database } from "bun:sqlite"
import type { CycleDefinition, PhaseDefinition } from "../types.ts"
import type { ProviderRouter } from "../providers/router.ts"
import { analyzeCyclePerformance } from "./cycle-analyzer.ts"
import { validateGeneratedCycle } from "./cycle-generator.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export type MutationOperator =
  | "swap_phases"
  | "change_provider_hint"
  | "adjust_parallelism"
  | "add_phase"
  | "remove_phase"
  | "duplicate_phase"

const ALL_OPERATORS: MutationOperator[] = [
  "swap_phases",
  "change_provider_hint",
  "adjust_parallelism",
  "add_phase",
  "remove_phase",
  "duplicate_phase",
]

const PHASE_TYPES: PhaseDefinition["type"][] = [
  "think",
  "gather",
  "parallel_experiment",
  "synthesize",
  "escalate",
]

const PROVIDER_HINTS: PhaseDefinition["provider_hint"][] = [
  "cheap",
  "balanced",
  "smart",
  "best",
  "user_choice",
]

export interface EvolutionResult {
  /** The best cycles from the final generation, sorted by fitness */
  winners: CycleDefinition[]
  /** Fitness scores for each winner */
  scores: number[]
  /** How many generations were actually run */
  generationsRun: number
}

// ─── Mutation ───────────────────────────────────────────────────────────────

/**
 * Apply a mutation to a cycle definition.
 * If no operator is specified, one is chosen at random.
 * Returns a new CycleDefinition (does not modify the input).
 */
export function mutateCycle(
  cycle: CycleDefinition,
  operator?: MutationOperator,
): CycleDefinition {
  const op = operator ?? randomItem(ALL_OPERATORS)
  const phases = cycle.phases.map((p) => ({ ...p, skills: [...p.skills] }))

  switch (op) {
    case "swap_phases":
      return applySwapPhases(cycle, phases)
    case "change_provider_hint":
      return applyChangeProviderHint(cycle, phases)
    case "adjust_parallelism":
      return applyAdjustParallelism(cycle, phases)
    case "add_phase":
      return applyAddPhase(cycle, phases)
    case "remove_phase":
      return applyRemovePhase(cycle, phases)
    case "duplicate_phase":
      return applyDuplicatePhase(cycle, phases)
    default:
      return { ...cycle, phases }
  }
}

/**
 * Combine phases from two parent cycles into a child.
 * Takes the first half of phases from cycleA and the second half from cycleB,
 * then deduplicates by phase type to keep the cycle coherent.
 */
export function crossover(
  cycleA: CycleDefinition,
  cycleB: CycleDefinition,
): CycleDefinition {
  const midA = Math.ceil(cycleA.phases.length / 2)
  const midB = Math.floor(cycleB.phases.length / 2)

  const firstHalf = cycleA.phases.slice(0, midA).map((p) => ({ ...p, skills: [...p.skills] }))
  const secondHalf = cycleB.phases.slice(midB).map((p) => ({ ...p, skills: [...p.skills] }))

  let childPhases = [...firstHalf, ...secondHalf]

  // Ensure minimum 2 phases
  if (childPhases.length < 2) {
    childPhases = [
      cycleA.phases[0] ? { ...cycleA.phases[0], skills: [...cycleA.phases[0].skills] } : makeDefaultPhase("think"),
      cycleB.phases[cycleB.phases.length - 1]
        ? { ...cycleB.phases[cycleB.phases.length - 1]!, skills: [...cycleB.phases[cycleB.phases.length - 1]!.skills] }
        : makeDefaultPhase("synthesize"),
    ]
  }

  // Cap at 8 phases
  if (childPhases.length > 8) {
    childPhases = childPhases.slice(0, 8)
  }

  const childName = `${cycleA.name}-x-${cycleB.name}`.slice(0, 60)
  const childId = childName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")

  return {
    id: childId,
    name: childName,
    description: `Crossover of "${cycleA.name}" and "${cycleB.name}"`,
    author: "ai",
    phases: childPhases,
    meta: {
      discovered_at: new Date().toISOString(),
      total_runs: 0,
    },
  }
}

/**
 * Run evolutionary selection over multiple generations.
 *
 * Each generation:
 *   1. Mutate each cycle in the population
 *   2. Score each cycle using performance data (if available) or a heuristic
 *   3. Keep the top performers
 *   4. Apply crossover on the best to fill the population
 *
 * This is a lightweight in-memory evolution — it does NOT actually run cycles.
 * For real benchmarking, the caller should run each winning cycle through
 * runCycle() and feed results back.
 */
export function evolve(
  db: Database,
  _router: ProviderRouter,
  cycles: CycleDefinition[],
  generations: number = 5,
  populationSize: number = 10,
): EvolutionResult {
  if (cycles.length === 0) {
    return { winners: [], scores: [], generationsRun: 0 }
  }

  // Initialize population by mutating the seed cycles
  let population: CycleDefinition[] = []

  // Start with the originals
  for (const c of cycles) {
    population.push(c)
  }

  // Fill remaining slots with mutations
  while (population.length < populationSize) {
    const parent = randomItem(cycles)
    population.push(mutateCycle(parent))
  }

  let generationsRun = 0

  for (let gen = 0; gen < generations; gen++) {
    generationsRun++

    // Score all individuals
    const scored = population.map((cycle) => ({
      cycle,
      fitness: scoreCycle(db, cycle),
    }))

    // Sort by fitness descending
    scored.sort((a, b) => b.fitness - a.fitness)

    // Keep top half (elitism)
    const survivors = scored.slice(0, Math.max(2, Math.ceil(populationSize / 2)))

    // Build next generation
    const nextGen: CycleDefinition[] = survivors.map((s) => s.cycle)

    // Fill with mutations of survivors
    while (nextGen.length < populationSize) {
      const parentIdx = Math.floor(Math.random() * survivors.length)
      const parent = survivors[parentIdx]!.cycle

      if (Math.random() < 0.3 && survivors.length >= 2) {
        // Crossover
        const otherIdx = (parentIdx + 1 + Math.floor(Math.random() * (survivors.length - 1))) % survivors.length
        const other = survivors[otherIdx]!.cycle
        const child = crossover(parent, other)
        // Ensure the child is valid before adding
        if (child.phases.length >= 2) {
          nextGen.push(child)
        } else {
          nextGen.push(mutateCycle(parent))
        }
      } else {
        // Mutation
        nextGen.push(mutateCycle(parent))
      }
    }

    population = nextGen.slice(0, populationSize)
  }

  // Final scoring and ranking
  const finalScored = population.map((cycle) => ({
    cycle,
    fitness: scoreCycle(db, cycle),
  }))
  finalScored.sort((a, b) => b.fitness - a.fitness)

  return {
    winners: finalScored.map((s) => s.cycle),
    scores: finalScored.map((s) => s.fitness),
    generationsRun,
  }
}

// ─── Mutation Operators ─────────────────────────────────────────────────────

function applySwapPhases(
  cycle: CycleDefinition,
  phases: PhaseDefinition[],
): CycleDefinition {
  if (phases.length < 2) return { ...cycle, phases }
  const i = Math.floor(Math.random() * phases.length)
  let j = Math.floor(Math.random() * phases.length)
  while (j === i && phases.length > 1) {
    j = Math.floor(Math.random() * phases.length)
  }
  const newPhases = [...phases]
  ;[newPhases[i], newPhases[j]] = [newPhases[j]!, newPhases[i]!]
  return makeMutated(cycle, newPhases, "swap_phases")
}

function applyChangeProviderHint(
  cycle: CycleDefinition,
  phases: PhaseDefinition[],
): CycleDefinition {
  const idx = Math.floor(Math.random() * phases.length)
  const newPhases = [...phases]
  const currentHint = newPhases[idx]!.provider_hint
  let newHint = randomItem(PROVIDER_HINTS)
  while (newHint === currentHint && PROVIDER_HINTS.length > 1) {
    newHint = randomItem(PROVIDER_HINTS)
  }
  newPhases[idx] = { ...newPhases[idx]!, provider_hint: newHint }
  return makeMutated(cycle, newPhases, "change_provider_hint")
}

function applyAdjustParallelism(
  cycle: CycleDefinition,
  phases: PhaseDefinition[],
): CycleDefinition {
  // Find experiment phases to adjust
  const expIndices = phases
    .map((p, i) => (p.type === "parallel_experiment" ? i : -1))
    .filter((i) => i >= 0)

  if (expIndices.length === 0) {
    // No experiment phases — adjust any phase's max_parallel slightly
    const idx = Math.floor(Math.random() * phases.length)
    const newPhases = [...phases]
    const current = newPhases[idx]!.max_parallel
    const delta = Math.random() > 0.5 ? 1 : -1
    newPhases[idx] = {
      ...newPhases[idx]!,
      max_parallel: Math.max(1, Math.min(30, current + delta)),
    }
    return makeMutated(cycle, newPhases, "adjust_parallelism")
  }

  const idx = randomItem(expIndices)
  const newPhases = [...phases]
  const current = newPhases[idx]!.max_parallel
  // Random adjustment: multiply by 0.5-2x
  const factor = 0.5 + Math.random() * 1.5
  const newParallel = Math.max(1, Math.min(30, Math.round(current * factor)))
  newPhases[idx] = { ...newPhases[idx]!, max_parallel: newParallel }
  return makeMutated(cycle, newPhases, "adjust_parallelism")
}

function applyAddPhase(
  cycle: CycleDefinition,
  phases: PhaseDefinition[],
): CycleDefinition {
  // Cap at 8 phases
  if (phases.length >= 8) {
    return applyChangeProviderHint(cycle, phases) // fallback mutation
  }

  const newType = randomItem(PHASE_TYPES)
  const newPhase = makeDefaultPhase(newType)

  // Insert at a random position
  const insertIdx = Math.floor(Math.random() * (phases.length + 1))
  const newPhases = [...phases]
  newPhases.splice(insertIdx, 0, newPhase)

  return makeMutated(cycle, newPhases, "add_phase")
}

function applyRemovePhase(
  cycle: CycleDefinition,
  phases: PhaseDefinition[],
): CycleDefinition {
  // Minimum 2 phases
  if (phases.length <= 2) {
    return applyChangeProviderHint(cycle, phases) // fallback mutation
  }

  const removeIdx = Math.floor(Math.random() * phases.length)
  const newPhases = [...phases]
  newPhases.splice(removeIdx, 1)

  return makeMutated(cycle, newPhases, "remove_phase")
}

function applyDuplicatePhase(
  cycle: CycleDefinition,
  phases: PhaseDefinition[],
): CycleDefinition {
  if (phases.length >= 8) {
    return applyChangeProviderHint(cycle, phases) // fallback
  }

  const sourceIdx = Math.floor(Math.random() * phases.length)
  const source = phases[sourceIdx]!

  // Clone with a different provider hint
  let newHint = randomItem(PROVIDER_HINTS)
  while (newHint === source.provider_hint && PROVIDER_HINTS.length > 1) {
    newHint = randomItem(PROVIDER_HINTS)
  }

  const clone: PhaseDefinition = {
    ...source,
    name: `${source.name}_v2`,
    provider_hint: newHint,
    skills: [...source.skills],
  }

  const newPhases = [...phases]
  newPhases.splice(sourceIdx + 1, 0, clone)

  return makeMutated(cycle, newPhases, "duplicate_phase")
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Score a cycle definition.
 * Uses real performance data if available, otherwise a structural heuristic.
 */
function scoreCycle(db: Database, cycle: CycleDefinition): number {
  // Try real performance data first
  const perf = analyzeCyclePerformance(db, cycle.id)
  if (perf.runCount > 0) {
    // Weighted real performance score
    return (
      perf.avgConfidence * 0.3 +
      Math.min(perf.costEfficiency, 1) * 0.25 +
      perf.experimentSuccessRate * 0.25 +
      Math.min(perf.timeEfficiency, 1) * 0.2
    )
  }

  // Heuristic scoring based on structure
  let score = 0.5 // base

  // Bonus for having a thinking phase
  if (cycle.phases.some((p) => p.type === "think")) score += 0.1

  // Bonus for having an experiment phase
  if (cycle.phases.some((p) => p.type === "parallel_experiment")) score += 0.1

  // Bonus for having a synthesis phase
  if (cycle.phases.some((p) => p.type === "synthesize")) score += 0.1

  // Penalty for too many phases (diminishing returns)
  if (cycle.phases.length > 6) score -= 0.05 * (cycle.phases.length - 6)

  // Penalty for too few phases
  if (cycle.phases.length < 3) score -= 0.1

  // Bonus for escalating provider hints (cheap → smart → best)
  const hintOrder: Record<string, number> = {
    cheap: 0,
    balanced: 1,
    user_choice: 2,
    smart: 3,
    best: 4,
  }
  let escalating = true
  for (let i = 1; i < cycle.phases.length; i++) {
    const prev = hintOrder[cycle.phases[i - 1]!.provider_hint] ?? 0
    const curr = hintOrder[cycle.phases[i]!.provider_hint] ?? 0
    if (curr < prev) {
      escalating = false
      break
    }
  }
  if (escalating) score += 0.05

  return Math.max(0, Math.min(1, score))
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDefaultPhase(type: PhaseDefinition["type"]): PhaseDefinition {
  const skillSets: Record<PhaseDefinition["type"], string[]> = {
    think: [],
    gather: ["web-search", "db-query", "file-scan"],
    parallel_experiment: ["file-edit", "run-command", "benchmark"],
    synthesize: ["db-query"],
    escalate: [],
  }

  const hintDefaults: Record<PhaseDefinition["type"], PhaseDefinition["provider_hint"]> = {
    think: "balanced",
    gather: "cheap",
    parallel_experiment: "user_choice",
    synthesize: "smart",
    escalate: "best",
  }

  return {
    name: `${type}_phase`,
    type,
    provider_hint: hintDefaults[type],
    skills: skillSets[type],
    max_parallel: type === "parallel_experiment" ? 10 : 1,
    description: `AI-generated ${type} phase`,
    input: "Context from previous phases",
    output: `${type} phase output`,
  }
}

function makeMutated(
  original: CycleDefinition,
  newPhases: PhaseDefinition[],
  operator: MutationOperator,
): CycleDefinition {
  const suffix = `-mut-${operator.slice(0, 4)}`
  const newName = original.name.includes("-mut-")
    ? original.name.replace(/-mut-\w+/, suffix)
    : `${original.name}${suffix}`
  const newId = newName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")

  return {
    id: newId,
    name: newName,
    description: `${original.description} (mutated: ${operator})`,
    author: "ai",
    phases: newPhases,
    meta: {
      ...original.meta,
      discovered_at: new Date().toISOString(),
      total_runs: 0,
    },
  }
}

function randomItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}
