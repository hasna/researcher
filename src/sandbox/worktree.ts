/**
 * Git worktree sandbox — Level 1 isolation.
 * Creates a git worktree branch for each experiment. Free, instant, lightweight.
 */

import type { SandboxInstance, ExecResult, SandboxCreateOpts } from "./base.ts"

export class WorktreeSandbox implements SandboxInstance {
  id: string
  type = "worktree" as const
  path: string
  private repoPath: string
  private branch: string

  constructor(id: string, repoPath: string, worktreePath: string, branch: string) {
    this.id = id
    this.repoPath = repoPath
    this.path = worktreePath
    this.branch = branch
  }

  static async create(opts: SandboxCreateOpts & { repoPath: string }): Promise<WorktreeSandbox> {
    const id = crypto.randomUUID().slice(0, 12)
    const branch = `experiment/${id}`
    const worktreePath = `${opts.repoPath}/.researcher-worktrees/${id}`

    // Create the worktree
    const mkBranch = Bun.spawnSync(["git", "worktree", "add", "-b", branch, worktreePath], {
      cwd: opts.repoPath,
    })
    if (mkBranch.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${mkBranch.stderr.toString()}`)
    }

    return new WorktreeSandbox(id, opts.repoPath, worktreePath, branch)
  }

  async execute(command: string, opts?: { timeout?: number }): Promise<ExecResult> {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: this.path,
      stdout: "pipe",
      stderr: "pipe",
    })

    // Handle timeout
    let timedOut = false
    const timer = opts?.timeout
      ? setTimeout(() => {
          timedOut = true
          proc.kill()
        }, opts.timeout)
      : null

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    if (timer) clearTimeout(timer)

    if (timedOut) {
      return { stdout, stderr: stderr + "\n[TIMEOUT]", exitCode: 124 }
    }

    return { stdout, stderr, exitCode }
  }

  async readFile(path: string): Promise<string> {
    return Bun.file(`${this.path}/${path}`).text()
  }

  async writeFile(path: string, content: string): Promise<void> {
    await Bun.write(`${this.path}/${path}`, content)
  }

  async getDiff(): Promise<ExecResult["stdout"]> {
    const result = await this.execute("git diff HEAD")
    return result.stdout
  }

  async cleanup(): Promise<void> {
    // Remove the worktree
    Bun.spawnSync(["git", "worktree", "remove", "--force", this.path], {
      cwd: this.repoPath,
    })
    // Delete the branch
    Bun.spawnSync(["git", "branch", "-D", this.branch], {
      cwd: this.repoPath,
    })
  }
}
