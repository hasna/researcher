/**
 * E2B cloud sandbox — Level 4 isolation.
 * Uses e2b.dev for heavy compute, GPU experiments, long-running tasks.
 */

import type { SandboxInstance, ExecResult, SandboxCreateOpts } from "./base.ts"

export class E2BSandbox implements SandboxInstance {
  id: string
  type = "e2b" as const
  path: string | null = null
  private sandboxId: string | null = null
  private sandbox: unknown = null // e2b Sandbox instance

  constructor(id: string) {
    this.id = id
  }

  static async create(opts: SandboxCreateOpts): Promise<E2BSandbox> {
    const id = crypto.randomUUID().slice(0, 12)
    const instance = new E2BSandbox(id)

    try {
      // Dynamic import to avoid requiring e2b when not used
      const { Sandbox } = await import("@e2b/code-interpreter")
      const sandbox = await Sandbox.create(opts.e2bTemplate ?? "base", {
        timeoutMs: opts.timeout ?? 600_000, // 10 min default
      })
      instance.sandbox = sandbox
      instance.sandboxId = sandbox.sandboxId
      instance.path = "/home/user"

      // Upload initial files if provided
      if (opts.files) {
        for (const file of opts.files) {
          await sandbox.files.write(file.path, file.content)
        }
      }
    } catch (err) {
      throw new Error(
        `Failed to create E2B sandbox. Ensure E2B_API_KEY is set. Error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    return instance
  }

  async execute(command: string, opts?: { timeout?: number }): Promise<ExecResult> {
    if (!this.sandbox) throw new Error("E2B sandbox not initialized")
    const sb = this.sandbox as {
      commands: {
        run: (cmd: string, opts?: { timeoutMs?: number }) => Promise<{
          stdout: string
          stderr: string
          exitCode: number
        }>
      }
    }

    try {
      const result = await sb.commands.run(command, {
        timeoutMs: opts?.timeout ?? 300_000,
      })
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }
    } catch (err) {
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
      }
    }
  }

  async readFile(path: string): Promise<string> {
    if (!this.sandbox) throw new Error("E2B sandbox not initialized")
    const sb = this.sandbox as {
      files: { read: (path: string) => Promise<string> }
    }
    return sb.files.read(path)
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.sandbox) throw new Error("E2B sandbox not initialized")
    const sb = this.sandbox as {
      files: { write: (path: string, content: string) => Promise<void> }
    }
    await sb.files.write(path, content)
  }

  async getDiff(): Promise<string> {
    const result = await this.execute("git diff HEAD 2>/dev/null || find /home/user -type f | head -50")
    return result.stdout
  }

  async cleanup(): Promise<void> {
    if (!this.sandbox) return
    const sb = this.sandbox as { kill: () => Promise<void> }
    try {
      await sb.kill()
    } catch {
      // Best effort cleanup
    }
    this.sandbox = null
  }
}
