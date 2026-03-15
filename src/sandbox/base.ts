/**
 * Base sandbox interface and types.
 */

export interface SandboxInstance {
  id: string
  type: "worktree" | "tempdir" | "container" | "e2b"
  path: string | null

  /** Execute a shell command in the sandbox. */
  execute(command: string, opts?: { timeout?: number }): Promise<ExecResult>

  /** Read a file from the sandbox. */
  readFile(path: string): Promise<string>

  /** Write a file in the sandbox. */
  writeFile(path: string, content: string): Promise<void>

  /** Get a diff of changes made in the sandbox. */
  getDiff(): Promise<string>

  /** Clean up the sandbox (remove worktree, delete temp dir, kill container, etc). */
  cleanup(): Promise<void>
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface SandboxCreateOpts {
  workspaceId: string
  hypothesis: string
  /** For git worktree: the repo path */
  repoPath?: string
  /** Files to copy into a tempdir sandbox */
  files?: { path: string; content: string }[]
  /** For e2b: template to use */
  e2bTemplate?: string
  /** Timeout for the entire sandbox lifecycle (ms) */
  timeout?: number
}
