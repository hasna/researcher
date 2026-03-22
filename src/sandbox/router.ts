/**
 * Sandbox router — auto-selects the right isolation level based on experiment requirements.
 *
 * Level 1: Git worktree (code in repos, free, instant)
 * Level 2: Temp directory (non-repo files, free)
 * Level 3: Container (dangerous/untrusted — not implemented yet, use e2b instead)
 * Level 4: E2B cloud (heavy compute, GPU, long-running)
 */

import type { SandboxInstance, SandboxCreateOpts } from "./base.ts"
import { WorktreeSandbox } from "./worktree.ts"
import { TempDirSandbox } from "./tempdir.ts"
import { E2BSandbox } from "./e2b.ts"

export interface SandboxRouterConfig {
  max_parallel: number
  max_cloud: number
}

export type SandboxLevel = "worktree" | "tempdir" | "e2b"

export interface ResolveHints {
  /** Is this a git repository? */
  isGitRepo?: boolean
  /** Path to the git repo */
  repoPath?: string
  /** Does this need GPU? */
  needsGpu?: boolean
  /** Is this running untrusted/dangerous code? */
  untrusted?: boolean
  /** Explicit sandbox type override */
  forceType?: SandboxLevel
}

export class SandboxRouter {
  private activeSandboxes: Map<string, SandboxInstance> = new Map()
  private config: SandboxRouterConfig

  constructor(config?: Partial<SandboxRouterConfig>) {
    this.config = {
      max_parallel: config?.max_parallel ?? 20,
      max_cloud: config?.max_cloud ?? 2,
    }
  }

  /**
   * Determine the appropriate sandbox level based on hints.
   */
  resolve(hints: ResolveHints): SandboxLevel {
    if (hints.forceType) return hints.forceType
    if (hints.needsGpu) return "e2b"
    if (hints.untrusted) return "e2b" // Use e2b for untrusted code (safer than local container)
    if (hints.isGitRepo && hints.repoPath) return "worktree"
    return "tempdir"
  }

  /**
   * Create a sandbox based on hints.
   */
  async create(hints: ResolveHints, opts: SandboxCreateOpts): Promise<SandboxInstance> {
    // Check limits
    if (this.activeSandboxes.size >= this.config.max_parallel) {
      throw new Error(
        `Max parallel sandboxes reached (${this.config.max_parallel}). Wait for existing sandboxes to complete.`,
      )
    }

    const cloudCount = [...this.activeSandboxes.values()].filter((s) => s.type === "e2b").length
    const level = this.resolve(hints)

    if (level === "e2b" && cloudCount >= this.config.max_cloud) {
      throw new Error(
        `Max cloud sandboxes reached (${this.config.max_cloud}). Wait for existing cloud sandboxes to complete.`,
      )
    }

    let sandbox: SandboxInstance

    switch (level) {
      case "worktree":
        if (!hints.repoPath) throw new Error("repoPath required for worktree sandbox")
        sandbox = await WorktreeSandbox.create({ ...opts, repoPath: hints.repoPath })
        break
      case "tempdir":
        sandbox = await TempDirSandbox.create({ ...opts, projectPath: opts.projectPath ?? hints.repoPath })
        break
      case "e2b":
        sandbox = await E2BSandbox.create(opts)
        break
      default:
        throw new Error(`Unknown sandbox level: ${level}`)
    }

    this.activeSandboxes.set(sandbox.id, sandbox)
    return sandbox
  }

  /**
   * Release a sandbox (cleanup + remove from tracking).
   */
  async release(sandboxId: string): Promise<void> {
    const sandbox = this.activeSandboxes.get(sandboxId)
    if (sandbox) {
      await sandbox.cleanup()
      this.activeSandboxes.delete(sandboxId)
    }
  }

  /**
   * Get count of active sandboxes by type.
   */
  getActiveCounts(): Record<string, number> {
    const counts: Record<string, number> = { worktree: 0, tempdir: 0, e2b: 0 }
    for (const sandbox of this.activeSandboxes.values()) {
      counts[sandbox.type] = (counts[sandbox.type] ?? 0) + 1
    }
    return counts
  }

  /**
   * Total active sandboxes.
   */
  get activeCount(): number {
    return this.activeSandboxes.size
  }
}
