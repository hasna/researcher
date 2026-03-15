/**
 * Temp directory sandbox — Level 2 isolation.
 * Creates a temporary directory for experiments. Free, instant, no git needed.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxInstance, ExecResult, SandboxCreateOpts } from "./base.ts"

export class TempDirSandbox implements SandboxInstance {
  id: string
  type = "tempdir" as const
  path: string

  constructor(id: string, path: string) {
    this.id = id
    this.path = path
  }

  static async create(opts: SandboxCreateOpts): Promise<TempDirSandbox> {
    const id = crypto.randomUUID().slice(0, 12)
    const path = await mkdtemp(join(tmpdir(), `researcher-${id}-`))

    const sandbox = new TempDirSandbox(id, path)

    // Copy initial files if provided
    if (opts.files) {
      for (const file of opts.files) {
        await sandbox.writeFile(file.path, file.content)
      }
    }

    return sandbox
  }

  async execute(command: string, opts?: { timeout?: number }): Promise<ExecResult> {
    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: this.path,
      stdout: "pipe",
      stderr: "pipe",
    })

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
    return Bun.file(join(this.path, path)).text()
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Ensure parent directory exists
    const fullPath = join(this.path, path)
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"))
    if (dir !== this.path) {
      const { mkdirSync } = require("node:fs")
      mkdirSync(dir, { recursive: true })
    }
    await Bun.write(fullPath, content)
  }

  async getDiff(): Promise<string> {
    // No git, so just list files
    const result = await this.execute("find . -type f -not -path '*/node_modules/*' | head -50")
    return result.stdout
  }

  async cleanup(): Promise<void> {
    await rm(this.path, { recursive: true, force: true })
  }
}
