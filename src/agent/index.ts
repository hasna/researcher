/**
 * Agent system — agentic loops for research phases.
 */

export { runAgent, runAgentsParallel, type AgentConfig, type AgentResult, type AgentTool, type ToolCallRecord } from "./loop.ts"
export { runAgenticPhase, type AgenticPhaseContext, type AgenticPhaseResult } from "./phases.ts"
export {
  problemTools,
  gatherTools,
  experimentTools,
  synthesizeTools,
  noteToSelf,
  webSearch,
  queryKnowledgeBase,
  queryPastExperiments,
  readFile,
  writeFile,
  runCommand,
  getDiff,
  saveKnowledgeTool,
  reportMetric,
} from "./tools.ts"
