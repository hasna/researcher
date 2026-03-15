/**
 * @hasna/researcher — Universal autonomous experimentation framework.
 *
 * Main library entry point. CLI and MCP server both use this.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type {
  Project,
  ProjectConfig,
  Workspace,
  WorkspaceConfig,
  Sandbox,
  SandboxType,
  ExperimentResult,
  Knowledge,
  KnowledgeEvidence,
  CycleDefinition,
  PhaseDefinition,
  CycleMeta,
  SkillDefinition,
  SkillInput,
  SkillOutput,
  SandboxHandle,
  ProviderConfig,
  GenerateOptions,
  GenerateResult,
  ResearchProvider,
  PFLKCycle,
  GREEPhase,
  ModelCall,
  ResearcherConfig,
} from "../types.ts"

// ─── Database ────────────────────────────────────────────────────────────────

export {
  initDb,
  closeDb,
  createProject,
  getProject,
  getProjectByName,
  listProjects,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  createSandbox,
  getSandbox,
  listSandboxes,
  createResult,
  listResults,
  getBestResult,
  deleteProject,
  logModelCall,
  getCostSummary,
} from "../db/index.ts"

// ─── Engine ──────────────────────────────────────────────────────────────────

export { runCycle, type CycleRunnerConfig, type CycleResult } from "../engine/cycle-runner.ts"
export { runPhase, parseHypotheses, type PhaseContext, type PhaseResult } from "../engine/phase-runner.ts"
export { runParallelExperiments, parseMetrics, type ParallelRunConfig, type ParallelRunResult } from "../engine/parallel.ts"
export { saveKnowledge, queryKnowledge, getCrossProjectKnowledge, updateKnowledgeConfidence, exportKnowledgeMarkdown } from "../engine/knowledge.ts"
export { startPFLK, recordFeedback, recordLoopholes, recordKnowledge, getPFLKHistory, getLoopholeSuccessRate, getKnowledgeFromPFLK } from "../engine/pflk.ts"
export { trackGREEPhase, getGREECostBreakdown, getProviderEfficiency } from "../engine/gree.ts"
export { ResourceManager, DEFAULT_LIMITS } from "../engine/resources.ts"

// ─── Cycles ──────────────────────────────────────────────────────────────────

export { parseCycleYaml, loadCycleFromFile, validateCycleDefinition } from "../cycles/parser.ts"
export { CycleRegistry } from "../cycles/registry.ts"

// ─── Providers ───────────────────────────────────────────────────────────────

export { ProviderRouter, type RouterConfig } from "../providers/router.ts"
export { AnthropicProvider } from "../providers/anthropic.ts"
export { createOpenAIProvider, createCerebrasProvider, createLocalProvider } from "../providers/openai-compat.ts"

// ─── Sandboxes ───────────────────────────────────────────────────────────────

export { SandboxRouter, type SandboxLevel, type ResolveHints } from "../sandbox/router.ts"
export type { SandboxInstance, ExecResult, SandboxCreateOpts } from "../sandbox/base.ts"
export { TempDirSandbox } from "../sandbox/tempdir.ts"
export { WorktreeSandbox } from "../sandbox/worktree.ts"
export { E2BSandbox } from "../sandbox/e2b.ts"

// ─── Skills ──────────────────────────────────────────────────────────────────

export { SkillRegistry, type Skill } from "../skills/registry.ts"
export { createDefaultRegistry } from "../skills/index.ts"

// ─── Config ──────────────────────────────────────────────────────────────────

export { loadConfig, saveConfig, ensureConfigDir, getDbPath, getConfigDir, DEFAULT_CONFIG } from "../config/index.ts"
