/**
 * Core types for the researcher framework.
 */

// ─── Projects ────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  type: "git_repo" | "directory" | "virtual" | "cloud"
  path: string | null
  remote_url: string | null
  domain: string
  metric_name: string
  metric_direction: "lower" | "higher"
  config: ProjectConfig
  created_at: string
  updated_at: string
}

export interface ProjectConfig {
  default_cycle?: string
  default_parallel?: number
  evaluation_command?: string
  experiment_files?: string[]
  timeout_seconds?: number
  [key: string]: unknown
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

export interface Workspace {
  id: string
  project_id: string
  cycle_id: string
  current_phase: string | null
  status: "running" | "paused" | "completed" | "failed"
  config: WorkspaceConfig
  cost_total: number
  created_at: string
  updated_at: string
}

export interface WorkspaceConfig {
  parallel: number
  provider_overrides?: Record<string, string>
  timeout_seconds?: number
  [key: string]: unknown
}

// ─── Sandboxes ───────────────────────────────────────────────────────────────

export type SandboxType = "worktree" | "tempdir" | "container" | "e2b"

export interface Sandbox {
  id: string
  workspace_id: string
  type: SandboxType
  path: string | null
  status: "creating" | "running" | "completed" | "failed" | "cleanup"
  hypothesis: string
  git_branch: string | null
  container_id: string | null
  e2b_sandbox_id: string | null
  started_at: string
  completed_at: string | null
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface ExperimentResult {
  id: string
  sandbox_id: string
  workspace_id: string
  metrics: Record<string, number>
  decision: "keep" | "discard" | "crash"
  diff: string | null
  cost: number
  provider: string
  model: string
  reasoning: string | null
  created_at: string
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

export interface Knowledge {
  id: string
  project_id: string | null
  domain: string
  insight: string
  evidence: KnowledgeEvidence[]
  confidence: number
  tags: string[]
  created_at: string
  updated_at: string
}

export interface KnowledgeEvidence {
  experiment_id: string
  metric_value: number
  description: string
}

// ─── Cycles ──────────────────────────────────────────────────────────────────

export interface CycleDefinition {
  id: string
  name: string
  description: string
  author: "human" | "ai"
  phases: PhaseDefinition[]
  meta: CycleMeta
}

export interface PhaseDefinition {
  name: string
  type: "think" | "gather" | "parallel_experiment" | "synthesize" | "escalate"
  provider_hint: "cheap" | "balanced" | "smart" | "best" | "user_choice"
  skills: string[]
  max_parallel: number
  description: string
  input: string
  output: string
}

export interface CycleMeta {
  discovered_at?: string
  success_rate?: number
  best_domains?: string[]
  total_runs?: number
}

// ─── Skills ──────────────────────────────────────────────────────────────────

export interface SkillDefinition {
  name: string
  description: string
  domains: string[]
  phases: PhaseDefinition["type"][]
  requires: string[]
  cost_per_run: "free" | "cheap" | "moderate" | "expensive"
}

export interface SkillInput {
  context: string
  parameters: Record<string, unknown>
  sandbox?: SandboxHandle
}

export interface SkillOutput {
  success: boolean
  data: unknown
  summary: string
  cost?: number
}

export interface SandboxHandle {
  execute(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  getDiff(): Promise<string>
}

// ─── Providers ───────────────────────────────────────────────────────────────

export interface ProviderConfig {
  name: string
  api_key?: string
  base_url?: string
  default_model: string
}

export interface GenerateOptions {
  model?: string
  temperature?: number
  max_tokens?: number
  system?: string
  structured?: boolean
}

export interface GenerateResult {
  content: string
  tokens_in: number
  tokens_out: number
  cost: number
  model: string
  latency_ms: number
}

export interface ResearchProvider {
  name: string
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult>
  estimateCost(tokens_in: number, tokens_out: number, model?: string): number
}

// ─── PFLK Tracking ───────────────────────────────────────────────────────────

export interface PFLKCycle {
  id: string
  project_id: string
  workspace_id: string
  problem: string
  feedback: string
  loopholes: string[] // sandbox IDs of parallel experiments
  knowledge: string | null
  winning_experiment_id: string | null
  created_at: string
}

// ─── GREE Tracking ──────────────────────────────────────────────────────────

export interface GREEPhase {
  id: string
  workspace_id: string
  phase: "gather" | "refine" | "experiment" | "evolve"
  provider_used: string
  model_used: string
  input_summary: string
  output_summary: string
  tokens_in: number
  tokens_out: number
  cost: number
  created_at: string
}

// ─── Model Calls ─────────────────────────────────────────────────────────────

export interface ModelCall {
  id: string
  workspace_id: string | null
  sandbox_id: string | null
  provider: string
  model: string
  tokens_in: number
  tokens_out: number
  cost: number
  latency_ms: number
  phase: string | null
  created_at: string
}

// ─── Pipelines (Multi-Cycle Orchestration) ──────────────────────────────────

export interface CyclePipeline {
  id: string
  name: string
  description: string
  author: string
  /** Ordered steps in the pipeline */
  steps: PipelineStep[]
  meta?: Record<string, unknown>
}

export interface PipelineStep {
  /** Step ID for referencing in conditions */
  id: string
  /** Cycle ID to execute */
  cycleId: string
  /** Optional conditions to check before executing this step */
  condition?: PipelineCondition
  /** Override cycle config for this step */
  overrides?: {
    maxParallel?: number
    providerHint?: string
    evaluationCommand?: string
  }
}

export interface PipelineCondition {
  /** Type of condition */
  type: "confidence_threshold" | "knowledge_gap" | "experiment_success_rate" | "always" | "custom"
  /** For confidence_threshold: minimum avg confidence from previous step */
  threshold?: number
  /** For custom: expression to evaluate */
  expression?: string
  /** What to do if condition is NOT met */
  onFail: "skip" | "branch" | "stop"
  /** Step ID to branch to if condition fails (for onFail: "branch") */
  branchTo?: string
}

export interface PipelineResult {
  success: boolean
  stepsCompleted: number
  totalSteps: number
  totalCost: number
  stepResults: PipelineStepResult[]
  error?: string
}

export interface PipelineStepResult {
  stepId: string
  cycleId: string
  success: boolean
  cost: number
  skipped: boolean
  cycleResult?: import("./engine/cycle-runner.ts").CycleResult
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ResearcherConfig {
  general: {
    default_cycle: string
    data_dir: string
  }
  providers: {
    cerebras?: ProviderConfig
    anthropic?: ProviderConfig
    openai?: ProviderConfig
    local?: ProviderConfig
  }
  e2b?: {
    api_key?: string
  }
  resources: {
    max_parallel_sandboxes: number
    max_parallel_per_workspace: number
    max_cost_per_hour: number
    max_container_sandboxes: number
    max_cloud_sandboxes: number
  }
}
