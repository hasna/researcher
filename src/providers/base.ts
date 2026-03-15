/**
 * Base provider interface and shared utilities.
 */

import type { ResearchProvider, GenerateOptions, GenerateResult } from "../types.ts"

export abstract class BaseProvider implements ResearchProvider {
  abstract name: string

  abstract generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult>
  abstract estimateCost(tokens_in: number, tokens_out: number, model?: string): number

  protected measureLatency<T>(fn: () => Promise<T>): Promise<{ result: T; latency_ms: number }> {
    const start = performance.now()
    return fn().then((result) => ({
      result,
      latency_ms: Math.round(performance.now() - start),
    }))
  }
}
