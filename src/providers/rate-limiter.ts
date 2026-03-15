/**
 * Token bucket rate limiter for LLM providers.
 */

export interface RateLimitConfig {
  maxRequestsPerMinute: number
  maxTokensPerMinute: number
}

export const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  anthropic: { maxRequestsPerMinute: 50, maxTokensPerMinute: 100_000 },
  openai: { maxRequestsPerMinute: 60, maxTokensPerMinute: 150_000 },
  cerebras: { maxRequestsPerMinute: 30, maxTokensPerMinute: 100_000 },
  local: { maxRequestsPerMinute: 1000, maxTokensPerMinute: 10_000_000 },
}

export class RateLimiter {
  private requests: number[] = []
  private tokens: number[] = [] // [timestamp, count] pairs flattened
  private config: RateLimitConfig

  constructor(config: RateLimitConfig) {
    this.config = config
  }

  /**
   * Wait until a request can be made within rate limits.
   */
  async acquire(estimatedTokens: number = 1000): Promise<void> {
    const now = Date.now()
    const windowMs = 60_000

    // Clean old entries
    this.requests = this.requests.filter(t => now - t < windowMs)

    // Check request limit
    if (this.requests.length >= this.config.maxRequestsPerMinute) {
      const oldest = this.requests[0]!
      const waitMs = windowMs - (now - oldest) + 100
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs))
      }
      this.requests = this.requests.filter(t => Date.now() - t < windowMs)
    }

    this.requests.push(Date.now())
  }

  /**
   * Record token usage after a request completes.
   */
  recordTokens(count: number): void {
    this.tokens.push(Date.now(), count)
    // Keep last 2 minutes of data
    const cutoff = Date.now() - 120_000
    const cleaned: number[] = []
    for (let i = 0; i < this.tokens.length; i += 2) {
      if (this.tokens[i]! >= cutoff) {
        cleaned.push(this.tokens[i]!, this.tokens[i + 1]!)
      }
    }
    this.tokens = cleaned
  }

  /**
   * Get current usage stats.
   */
  getUsage(): { requestsPerMinute: number; tokensPerMinute: number } {
    const now = Date.now()
    const windowMs = 60_000
    const recentRequests = this.requests.filter(t => now - t < windowMs).length
    let recentTokens = 0
    for (let i = 0; i < this.tokens.length; i += 2) {
      if (now - this.tokens[i]! < windowMs) {
        recentTokens += this.tokens[i + 1]!
      }
    }
    return { requestsPerMinute: recentRequests, tokensPerMinute: recentTokens }
  }
}

/**
 * Global rate limiter registry.
 */
const limiters: Map<string, RateLimiter> = new Map()

export function getRateLimiter(providerName: string, config?: RateLimitConfig): RateLimiter {
  let limiter = limiters.get(providerName)
  if (!limiter) {
    limiter = new RateLimiter(config ?? DEFAULT_LIMITS[providerName] ?? DEFAULT_LIMITS.local!)
    limiters.set(providerName, limiter)
  }
  return limiter
}
