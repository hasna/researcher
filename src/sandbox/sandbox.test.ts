import { test, expect, afterEach } from "bun:test"
import { TempDirSandbox } from "./tempdir.ts"
import { SandboxRouter } from "./router.ts"

// ─── TempDir Sandbox tests ───────────────────────────────────────────────────

let tempSandbox: TempDirSandbox | null = null

afterEach(async () => {
  if (tempSandbox) {
    await tempSandbox.cleanup()
    tempSandbox = null
  }
})

test("tempdir sandbox: create and cleanup", async () => {
  tempSandbox = await TempDirSandbox.create({
    workspaceId: "test-ws",
    hypothesis: "test hypothesis",
  })
  expect(tempSandbox.id).toBeTruthy()
  expect(tempSandbox.type).toBe("tempdir")
  expect(tempSandbox.path).toBeTruthy()
})

test("tempdir sandbox: write and read file", async () => {
  tempSandbox = await TempDirSandbox.create({
    workspaceId: "test-ws",
    hypothesis: "test",
  })
  await tempSandbox.writeFile("test.txt", "hello world")
  const content = await tempSandbox.readFile("test.txt")
  expect(content).toBe("hello world")
})

test("tempdir sandbox: execute command", async () => {
  tempSandbox = await TempDirSandbox.create({
    workspaceId: "test-ws",
    hypothesis: "test",
  })
  await tempSandbox.writeFile("data.txt", "line1\nline2\nline3\n")
  const result = await tempSandbox.execute("wc -l data.txt")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("3")
})

test("tempdir sandbox: create with initial files", async () => {
  tempSandbox = await TempDirSandbox.create({
    workspaceId: "test-ws",
    hypothesis: "test",
    files: [
      { path: "config.json", content: '{"key":"value"}' },
      { path: "script.sh", content: "echo hello" },
    ],
  })
  const config = await tempSandbox.readFile("config.json")
  expect(config).toBe('{"key":"value"}')
  const script = await tempSandbox.readFile("script.sh")
  expect(script).toBe("echo hello")
})

test("tempdir sandbox: execute with failed command", async () => {
  tempSandbox = await TempDirSandbox.create({
    workspaceId: "test-ws",
    hypothesis: "test",
  })
  const result = await tempSandbox.execute("false")
  expect(result.exitCode).not.toBe(0)
})

// ─── Sandbox Router tests ────────────────────────────────────────────────────

test("router: resolve to worktree for git repos", () => {
  const router = new SandboxRouter()
  const level = router.resolve({ isGitRepo: true, repoPath: "/tmp/repo" })
  expect(level).toBe("worktree")
})

test("router: resolve to tempdir by default", () => {
  const router = new SandboxRouter()
  const level = router.resolve({})
  expect(level).toBe("tempdir")
})

test("router: resolve to e2b for GPU", () => {
  const router = new SandboxRouter()
  const level = router.resolve({ needsGpu: true })
  expect(level).toBe("e2b")
})

test("router: resolve to e2b for untrusted code", () => {
  const router = new SandboxRouter()
  const level = router.resolve({ untrusted: true })
  expect(level).toBe("e2b")
})

test("router: respect forceType override", () => {
  const router = new SandboxRouter()
  expect(router.resolve({ forceType: "e2b" })).toBe("e2b")
  expect(router.resolve({ forceType: "tempdir", isGitRepo: true, repoPath: "/tmp" })).toBe("tempdir")
})

test("router: create tempdir sandbox", async () => {
  const router = new SandboxRouter()
  const sandbox = await router.create({}, { workspaceId: "ws", hypothesis: "test" })
  expect(sandbox.type).toBe("tempdir")
  expect(router.activeCount).toBe(1)

  await router.release(sandbox.id)
  expect(router.activeCount).toBe(0)
})

test("router: enforce max parallel limit", async () => {
  const router = new SandboxRouter({ max_parallel: 2 })
  await router.create({}, { workspaceId: "ws", hypothesis: "test1" })
  await router.create({}, { workspaceId: "ws", hypothesis: "test2" })

  expect(router.activeCount).toBe(2)
  await expect(
    router.create({}, { workspaceId: "ws", hypothesis: "test3" }),
  ).rejects.toThrow("Max parallel sandboxes reached")

  // Cleanup
  const counts = router.getActiveCounts()
  expect(counts.tempdir).toBe(2)
})

test("router: getActiveCounts returns breakdown", async () => {
  const router = new SandboxRouter()
  await router.create({}, { workspaceId: "ws", hypothesis: "test" })
  const counts = router.getActiveCounts()
  expect(counts.tempdir).toBe(1)
  expect(counts.worktree).toBe(0)
  expect(counts.e2b).toBe(0)
})
