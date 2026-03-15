/**
 * Optional integrations with @hasna ecosystem.
 * Each integration checks if the target service is available before using it.
 */

export interface IntegrationConfig {
  economy_enabled?: boolean
  mementos_enabled?: boolean
  mementos_project?: string
  todos_enabled?: boolean
  todos_task_list?: string
}

/**
 * Push cost data to @hasna/economy if available.
 */
export async function pushToEconomy(data: {
  provider: string
  model: string
  tokens_in: number
  tokens_out: number
  cost: number
  session?: string
}): Promise<boolean> {
  try {
    // Try to dynamically import economy — if not installed, silently skip
    const response = await fetch("http://localhost:7060/api/costs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: data.provider,
        model: data.model,
        input_tokens: data.tokens_in,
        output_tokens: data.tokens_out,
        cost_usd: data.cost,
        source: "researcher",
        session_id: data.session,
      }),
    })
    return response.ok
  } catch {
    return false // Economy service not available
  }
}

/**
 * Save knowledge to @hasna/mementos if available.
 */
export async function pushToMementos(data: {
  key: string
  value: string
  project?: string
  importance?: number
  tags?: string[]
}): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:7050/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: data.key,
        value: data.value,
        scope: "shared",
        category: "knowledge",
        importance: data.importance ?? 7,
        tags: data.tags ?? ["researcher", "auto-generated"],
        source: "agent",
      }),
    })
    return response.ok
  } catch {
    return false // Mementos service not available
  }
}

/**
 * Create a follow-up task in @hasna/todos if available.
 */
export async function pushToTodos(data: {
  title: string
  description: string
  task_list_id?: string
  priority?: string
  tags?: string[]
}): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:7040/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: data.title,
        description: data.description,
        task_list_id: data.task_list_id,
        priority: data.priority ?? "medium",
        tags: [...(data.tags ?? []), "researcher", "auto-generated"],
      }),
    })
    return response.ok
  } catch {
    return false // Todos service not available
  }
}
