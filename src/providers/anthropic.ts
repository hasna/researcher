/**
 * Anthropic provider — Claude models for smart/best reasoning.
 */

import Anthropic from "@anthropic-ai/sdk"
import type { GenerateOptions, GenerateResult } from "../types.ts"
import { BaseProvider } from "./base.ts"

// Cost per 1M tokens (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
}

const DEFAULT_MODEL = "claude-sonnet-4-6"

export class AnthropicProvider extends BaseProvider {
  name = "anthropic"
  private client: Anthropic

  constructor(apiKey?: string) {
    super()
    this.client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY })
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult> {
    const model = options?.model ?? DEFAULT_MODEL

    const { result, latency_ms } = await this.measureLatency(async () => {
      return this.client.messages.create({
        model,
        max_tokens: options?.max_tokens ?? 4096,
        ...(options?.system ? { system: options.system } : {}),
        messages: [{ role: "user", content: prompt }],
      })
    })

    const content =
      result.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { type: "text"; text: string }).text)
        .join("") ?? ""

    const tokens_in = result.usage.input_tokens
    const tokens_out = result.usage.output_tokens

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
    const m = model ?? DEFAULT_MODEL
    const pricing = PRICING[m] ?? PRICING[DEFAULT_MODEL]!
    return (tokens_in * pricing.input + tokens_out * pricing.output) / 1_000_000
  }
}
