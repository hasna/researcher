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
  CyclePipeline,
  PipelineStep,
  PipelineCondition,
  PipelineResult,
  PipelineStepResult,
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
  createPipelineRun,
  updatePipelineRun,
  getPipelineRun,
  listPipelineRuns,
} from "../db/index.ts"

// ─── Engine ──────────────────────────────────────────────────────────────────

export { runCycle, type CycleRunnerConfig, type CycleResult, type CycleMode } from "../engine/cycle-runner.ts"
export { runPhase, parseHypotheses, type PhaseContext, type PhaseResult } from "../engine/phase-runner.ts"
export { runParallelExperiments, parseMetrics, type ParallelRunConfig, type ParallelRunResult } from "../engine/parallel.ts"
export { saveKnowledge, queryKnowledge, getCrossProjectKnowledge, updateKnowledgeConfidence, exportKnowledgeMarkdown } from "../engine/knowledge.ts"
export {
  addRelationship,
  removeRelationship,
  getRelationships,
  getNeighbors,
  findPath,
  propagateConfidence,
  getSubgraph,
  autoLinkKnowledge,
  transferKnowledge,
  type KnowledgeEdge,
  type EdgeRelationship,
  type SubgraphResult,
} from "../engine/knowledge-graph.ts"
export { startPFLK, recordFeedback, recordLoopholes, recordKnowledge, getPFLKHistory, getLoopholeSuccessRate, getKnowledgeFromPFLK } from "../engine/pflk.ts"
export { trackGREEPhase, getGREECostBreakdown, getProviderEfficiency } from "../engine/gree.ts"
export { ResourceManager, DEFAULT_LIMITS } from "../engine/resources.ts"
export {
  runAdaptiveExperiments,
  ensureLineageTable,
  recordLineage,
  getLineageDescendants,
  getLineageAncestors,
  planResourceSchedule,
  type AdaptiveParallelConfig,
  type AdaptiveParallelResult,
  type ExperimentLineageEntry,
  type ResourceSchedule,
} from "../engine/adaptive.ts"
export { ResearchEventEmitter, getGlobalEmitter, setGlobalEmitter, type ResearchEventType, type TypedResearchEvent } from "../engine/events.ts"
export { runPipeline, evaluateCondition, type PipelineRunnerConfig } from "../engine/pipeline-runner.ts"
export {
  analyzeCyclePerformance,
  compareCycles,
  getBestCycleForDomain,
  getDomainRecommendations,
  getPhaseTypeEffectiveness,
  type CyclePerformanceMetrics,
  type CycleComparison,
  type PhaseTypeEffectiveness,
} from "../engine/cycle-analyzer.ts"
export {
  generateCycle,
  validateGeneratedCycle,
  cycleToYaml,
  type CycleGenerationConfig,
} from "../engine/cycle-generator.ts"
export {
  mutateCycle,
  crossover,
  evolve,
  type MutationOperator,
  type EvolutionResult,
} from "../engine/cycle-evolution.ts"

// ─── Cycles ──────────────────────────────────────────────────────────────────

export { parseCycleYaml, loadCycleFromFile, validateCycleDefinition } from "../cycles/parser.ts"
export { CycleRegistry } from "../cycles/registry.ts"
export { parsePipelineYaml, loadPipelineFromFile, validatePipelineDefinition } from "../cycles/pipeline-parser.ts"
export { PipelineRegistry } from "../cycles/pipeline-registry.ts"

// ─── Providers ───────────────────────────────────────────────────────────────

export { ProviderRouter, type RouterConfig } from "../providers/router.ts"
export { AnthropicProvider } from "../providers/anthropic.ts"
export { createOpenAIProvider, createCerebrasProvider, createLocalProvider } from "../providers/openai-compat.ts"
export { searchWeb, searchWithExa, searchWithOpenAI, searchWithAnthropic, type WebSearchResult, type WebSearchResponse, type WebSearchOptions, type SearchProvider } from "../providers/web-search.ts"

// ─── Sandboxes ───────────────────────────────────────────────────────────────

export { SandboxRouter, type SandboxLevel, type ResolveHints } from "../sandbox/router.ts"
export type { SandboxInstance, ExecResult, SandboxCreateOpts } from "../sandbox/base.ts"
export { TempDirSandbox } from "../sandbox/tempdir.ts"
export { WorktreeSandbox } from "../sandbox/worktree.ts"
export { E2BSandbox } from "../sandbox/e2b.ts"

// ─── Skills ──────────────────────────────────────────────────────────────────

export { SkillRegistry, type Skill } from "../skills/registry.ts"
export { createDefaultRegistry } from "../skills/index.ts"

// ─── Observability ──────────────────────────────────────────────────────────

export { ResearchLogger, getLogger, setLogger, connectLoggerToEmitter, type LogLevel, type LogEntry, type LoggerConfig } from "../engine/logger.ts"
export { attachTerminalUI, type TerminalUIConfig } from "../engine/terminal-ui.ts"
export { createSSEServer, type SSEServer, type SSEServerConfig } from "../api/sse.ts"

// ─── Config ──────────────────────────────────────────────────────────────────

export { loadConfig, saveConfig, ensureConfigDir, getDbPath, getConfigDir, DEFAULT_CONFIG } from "../config/index.ts"

// ─── Model config ────────────────────────────────────────────────────────────

export {
  getActiveModel,
  setActiveModel,
  clearActiveModel,
  DEFAULT_MODEL,
} from "./model-config.ts"

// ─── Training data gatherer ───────────────────────────────────────────────────

export { gatherTrainingData } from "./gatherer.ts"
export type {
  GatherTrainingDataFn,
  GatherResult,
  GathererOptions,
  TrainingExample,
} from "./gatherer.ts"
