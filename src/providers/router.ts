/**
 * Provider router — selects the right LLM provider based on phase hints.
 *
 * Hint mapping:
 *   cheap       → cerebras > local > openai
 *   balanced    → openai > anthropic (sonnet) > cerebras
 *   smart       → anthropic (sonnet) > openai
 *   best        → anthropic (opus) > anthropic (sonnet)
 *   user_choice → uses configured default or falls back to balanced
 */

import type { ResearchProvider, GenerateOptions, GenerateResult, PhaseDefinition } from "../types.ts"
import { AnthropicProvider } from "./anthropic.ts"
import {
  createOpenAIProvider,
  createCerebrasProvider,
  createLocalProvider,
} from "./openai-compat.ts"

export interface RouterConfig {
  cerebras?: { apiKey?: string }
  anthropic?: { apiKey?: string }
  openai?: { apiKey?: string }
  local?: { baseUrl?: string; model?: string }
  default_hint?: PhaseDefinition["provider_hint"]
}

export class ProviderRouter {
  private providers: Map<string, ResearchProvider> = new Map()
  private defaultHint: PhaseDefinition["provider_hint"]

  constructor(config: RouterConfig = {}) {
    this.defaultHint = config.default_hint ?? "balanced"

    // Initialize available providers
    if (config.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY) {
      this.providers.set("anthropic", new AnthropicProvider(config.anthropic?.apiKey))
    }
    if (config.openai?.apiKey || process.env.OPENAI_API_KEY) {
      this.providers.set("openai", createOpenAIProvider(config.openai?.apiKey))
    }
    if (config.cerebras?.apiKey || process.env.CEREBRAS_API_KEY) {
      this.providers.set("cerebras", createCerebrasProvider(config.cerebras?.apiKey))
    }
    // Local is always available (no API key needed)
    this.providers.set("local", createLocalProvider(config.local?.baseUrl, config.local?.model))
  }

  /**
   * Get a provider for a given hint. Falls back through preference chain.
   */
  resolve(hint: PhaseDefinition["provider_hint"]): ResearchProvider {
    const actualHint = hint === "user_choice" ? this.defaultHint : hint

    const preferences = HINT_PREFERENCES[actualHint]
    for (const pref of preferences) {
      const provider = this.providers.get(pref.name)
      if (provider) {
        // If a specific model override is needed, wrap it
        if (pref.model) {
          return new ModelOverrideProvider(provider, pref.model)
        }
        return provider
      }
    }

    // Last resort: return any available provider
    const first = this.providers.values().next()
    if (first.done) {
      throw new Error("No LLM providers configured. Run `researcher init` to set up API keys.")
    }
    return first.value
  }

  /**
   * Generate with automatic provider selection based on hint.
   */
  async generate(
    prompt: string,
    hint: PhaseDefinition["provider_hint"],
    options?: GenerateOptions,
  ): Promise<GenerateResult & { provider_name: string }> {
    const actualHint = hint === "user_choice" ? this.defaultHint : hint
    const preferences = HINT_PREFERENCES[actualHint]

    // Try each provider in preference order with fallback
    const errors: string[] = []
    for (const pref of preferences) {
      const provider = this.providers.get(pref.name)
      if (!provider) continue

      try {
        const opts = pref.model ? { ...options, model: pref.model } : options
        const result = await provider.generate(prompt, opts)
        if (errors.length > 0) {
          console.error(`[researcher] Fell back to ${provider.name} after ${errors.length} provider(s) failed`)
        }
        return { ...result, provider_name: provider.name }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${pref.name}: ${msg}`)

        // For rate limits (429), wait briefly and retry same provider once
        if (msg.includes("429") || msg.includes("rate")) {
          try {
            await new Promise(r => setTimeout(r, 2000))
            const opts = pref.model ? { ...options, model: pref.model } : options
            const result = await provider.generate(prompt, opts)
            return { ...result, provider_name: provider.name }
          } catch {
            // Continue to next provider
          }
        }
      }
    }

    throw new Error(`All providers failed:\n${errors.join("\n")}`)
  }

  /**
   * List all configured providers.
   */
  listProviders(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Check if a specific provider is available.
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name)
  }
}

// ─── Hint preference chains ─────────────────────────────────────────────────

interface ProviderPreference {
  name: string
  model?: string
}

const HINT_PREFERENCES: Record<PhaseDefinition["provider_hint"], ProviderPreference[]> = {
  cheap: [
    { name: "cerebras" },
    { name: "local" },
    { name: "openai", model: "gpt-4.1-nano" },
    { name: "anthropic", model: "claude-haiku-4-5" },
  ],
  balanced: [
    { name: "openai", model: "gpt-4.1-mini" },
    { name: "anthropic", model: "claude-sonnet-4-6" },
    { name: "cerebras" },
    { name: "local" },
  ],
  smart: [
    { name: "anthropic", model: "claude-sonnet-4-6" },
    { name: "openai", model: "gpt-4.1" },
    { name: "cerebras" },
    { name: "local" },
  ],
  best: [
    { name: "anthropic", model: "claude-opus-4-6" },
    { name: "anthropic", model: "claude-sonnet-4-6" },
    { name: "openai", model: "gpt-4.1" },
  ],
  user_choice: [
    // Resolved dynamically via defaultHint
    { name: "anthropic", model: "claude-sonnet-4-6" },
    { name: "openai" },
    { name: "cerebras" },
    { name: "local" },
  ],
}

// ─── Model override wrapper ──────────────────────────────────────────────────

class ModelOverrideProvider implements ResearchProvider {
  name: string

  constructor(
    private inner: ResearchProvider,
    private modelOverride: string,
  ) {
    this.name = inner.name
  }

  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult> {
    return this.inner.generate(prompt, { ...options, model: this.modelOverride })
  }

  estimateCost(tokens_in: number, tokens_out: number, model?: string): number {
    return this.inner.estimateCost(tokens_in, tokens_out, model ?? this.modelOverride)
  }
}
