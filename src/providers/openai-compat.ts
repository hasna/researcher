/**
 * OpenAI-compatible provider — works for OpenAI, Cerebras, and local (Ollama, vLLM).
 */

import OpenAI from "openai"
import type { GenerateOptions, GenerateResult } from "../types.ts"
import { BaseProvider } from "./base.ts"

// Cost per 1M tokens (USD) — 0 for local
const PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  openai: {
    "gpt-4.1": { input: 2, output: 8 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4 },
    "o3-mini": { input: 1.1, output: 4.4 },
  },
  cerebras: {
    "llama3.1-8b": { input: 0.1, output: 0.1 },
    "qwen-3-235b-a22b-instruct-2507": { input: 0.2, output: 0.6 },
  },
  local: {},
}

export class OpenAICompatProvider extends BaseProvider {
  name: string
  private client: OpenAI
  private defaultModel: string
  private providerType: string

  constructor(opts: {
    name: string
    apiKey?: string
    baseUrl?: string
    defaultModel: string
  }) {
    super()
    this.name = opts.name
    this.providerType = opts.name
    this.defaultModel = opts.defaultModel
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "not-needed",
      baseURL: opts.baseUrl,
    })
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult> {
    const model = options?.model ?? this.defaultModel

    const { result, latency_ms } = await this.measureLatency(async () => {
      return this.client.chat.completions.create({
        model,
        max_tokens: options?.max_tokens ?? 4096,
        temperature: options?.temperature,
        messages: [
          ...(options?.system ? [{ role: "system" as const, content: options.system }] : []),
          { role: "user" as const, content: prompt },
        ],
      })
    })

    const content = result.choices[0]?.message?.content ?? ""
    const tokens_in = result.usage?.prompt_tokens ?? 0
    const tokens_out = result.usage?.completion_tokens ?? 0

    return {
      content,
      tokens_in,
      tokens_out,
      cost: this.estimateCost(tokens_in, tokens_out, model),
      model,
      latency_ms,
    }
  }

  estimateCost(tokens_in: number, tokens_out: number, model?: string): number {
    const m = model ?? this.defaultModel
    const providerPricing = PRICING[this.providerType]
    if (!providerPricing) return 0
    const pricing = providerPricing[m]
    if (!pricing) return 0
    return (tokens_in * pricing.input + tokens_out * pricing.output) / 1_000_000
  }
}

// ─── Factory functions ───────────────────────────────────────────────────────

export function createOpenAIProvider(apiKey?: string): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: "openai",
    apiKey: apiKey ?? process.env.OPENAI_API_KEY,
    defaultModel: "gpt-4.1-mini",
  })
}

export function createCerebrasProvider(apiKey?: string): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: "cerebras",
    apiKey: apiKey ?? process.env.CEREBRAS_API_KEY,
    baseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama3.1-8b",
  })
}

export function createLocalProvider(baseUrl?: string, model?: string): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: "local",
    baseUrl: baseUrl ?? process.env.LOCAL_LLM_URL ?? "http://localhost:11434/v1",
    defaultModel: model ?? process.env.LOCAL_LLM_MODEL ?? "qwen3:32b",
  })
}
