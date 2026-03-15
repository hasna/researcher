/**
 * Agent loop — the core agentic execution engine.
 *
 * Each agent has:
 * - A system prompt defining its role
 * - A set of tools it can call
 * - A loop: think → act → observe → decide if done
 * - Ability to spawn child agents for parallel work
 * - A max iterations limit to prevent infinite loops
 * - A scratchpad (memory within the loop)
 */

import type { ProviderRouter } from "../providers/router.ts"
import type { PhaseDefinition } from "../types.ts"

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, { type: string; description: string; required?: boolean }>
  execute: (params: Record<string, unknown>) => Promise<string>
}

export interface AgentConfig {
  name: string
  systemPrompt: string
  tools: AgentTool[]
  router: ProviderRouter
  providerHint: PhaseDefinition["provider_hint"]
  maxIterations: number
  /** Can this agent spawn children? */
  canSpawn: boolean
  /** Factory for creating child agents */
  childFactory?: (task: string) => AgentConfig
  /** Called after each iteration — for logging/monitoring */
  onIteration?: (iteration: number, thought: string, action: string | null) => void
  /** Called when agent completes */
  onComplete?: (result: AgentResult) => void
}

export interface AgentResult {
  success: boolean
  output: string
  iterations: number
  toolCalls: ToolCallRecord[]
  childResults: AgentResult[]
  cost: number
}

export interface ToolCallRecord {
  tool: string
  params: Record<string, unknown>
  result: string
  iteration: number
}

/**
 * Run an agent loop — think, act, observe, repeat until done.
 */
export async function runAgent(config: AgentConfig): Promise<AgentResult> {
  const { name, systemPrompt, tools, router, providerHint, maxIterations } = config
  const toolCalls: ToolCallRecord[] = []
  const childResults: AgentResult[] = []
  let totalCost = 0
  let scratchpad = ""

  // Build tool descriptions for the LLM
  const toolDescriptions = tools.map((t) => {
    const params = Object.entries(t.parameters)
      .map(([k, v]) => `  - ${k} (${v.type}${v.required ? ", required" : ""}): ${v.description}`)
      .join("\n")
    return `### ${t.name}\n${t.description}\nParameters:\n${params}`
  }).join("\n\n")

  const spawnTool = config.canSpawn
    ? `\n\n### spawn_child\nSpawn a child agent to handle a subtask in parallel. Returns the child's result.\nParameters:\n  - task (string, required): What the child agent should accomplish`
    : ""

  const toolList = tools.map((t) => t.name).join(", ") + (config.canSpawn ? ", spawn_child" : "")

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Build the prompt for this iteration
    const prompt = `${scratchpad ? `## Scratchpad (your notes from previous iterations):\n${scratchpad}\n\n` : ""}## Iteration ${iteration}/${maxIterations}

Think step by step about what to do next. Then either:
1. Call a tool by responding with EXACTLY this format:
   TOOL: <tool_name>
   PARAMS: <json_params>

2. Or if you're done, respond with:
   DONE: <your final output/answer>

Available tools: ${toolList}

${toolDescriptions}${spawnTool}

Remember: You are "${name}". Think carefully, then act. If you need more information, use a tool. If you have enough to answer, say DONE.`

    const result = await router.generate(prompt, providerHint, {
      system: systemPrompt,
      max_tokens: 4096,
    })
    totalCost += result.cost

    const response = result.content.trim()
    config.onIteration?.(iteration, response.slice(0, 200), null)

    // Parse response — check for DONE or TOOL
    const doneMatch = response.match(/DONE:\s*([\s\S]+)/i)
    if (doneMatch) {
      const output = doneMatch[1]!.trim()
      const agentResult: AgentResult = {
        success: true,
        output,
        iterations: iteration,
        toolCalls,
        childResults,
        cost: totalCost,
      }
      config.onComplete?.(agentResult)
      return agentResult
    }

    const toolMatch = response.match(/TOOL:\s*(\w+)\s*\nPARAMS:\s*(\{[\s\S]*?\})/i)
    if (toolMatch) {
      const toolName = toolMatch[1]!.trim()
      let params: Record<string, unknown> = {}
      try {
        params = JSON.parse(toolMatch[2]!)
      } catch {
        scratchpad += `\n[Iteration ${iteration}] Failed to parse tool params: ${toolMatch[2]}\n`
        continue
      }

      // Handle spawn_child
      if (toolName === "spawn_child" && config.canSpawn && config.childFactory) {
        const task = params.task as string
        const childConfig = config.childFactory(task)
        const childResult = await runAgent(childConfig)
        childResults.push(childResult)
        totalCost += childResult.cost
        scratchpad += `\n[Iteration ${iteration}] Spawned child for "${task}" → ${childResult.success ? "Success" : "Failed"}: ${childResult.output.slice(0, 500)}\n`
        continue
      }

      // Find and execute the tool
      const tool = tools.find((t) => t.name === toolName)
      if (!tool) {
        scratchpad += `\n[Iteration ${iteration}] Unknown tool: ${toolName}. Available: ${toolList}\n`
        continue
      }

      try {
        const toolResult = await tool.execute(params)
        toolCalls.push({ tool: toolName, params, result: toolResult, iteration })
        // Add to scratchpad so the agent remembers what it did
        scratchpad += `\n[Iteration ${iteration}] Used ${toolName}(${JSON.stringify(params).slice(0, 200)}) → ${toolResult.slice(0, 1000)}\n`
        config.onIteration?.(iteration, `Used ${toolName}`, toolResult.slice(0, 200))
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        scratchpad += `\n[Iteration ${iteration}] Tool ${toolName} failed: ${errMsg}\n`
      }
      continue
    }

    // No TOOL or DONE — treat as thinking, add to scratchpad
    scratchpad += `\n[Iteration ${iteration}] Thought: ${response.slice(0, 1000)}\n`
  }

  // Max iterations reached
  const agentResult: AgentResult = {
    success: false,
    output: `Max iterations (${maxIterations}) reached. Last scratchpad:\n${scratchpad.slice(-2000)}`,
    iterations: maxIterations,
    toolCalls,
    childResults,
    cost: totalCost,
  }
  config.onComplete?.(agentResult)
  return agentResult
}

/**
 * Run multiple agents in parallel and collect results.
 */
export async function runAgentsParallel(configs: AgentConfig[]): Promise<AgentResult[]> {
  return Promise.all(configs.map(runAgent))
}
