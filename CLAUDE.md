# researcher — Universal Autonomous Experimentation Framework

## Stack
- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript (strict mode)
- **Database**: bun:sqlite (NOT better-sqlite3)
- **Testing**: bun test
- **Package**: @hasna/researcher
- **License**: MIT

## Commands
- `bun run src/cli/index.ts` — Run CLI
- `bun test` — Run tests
- `bun run tsc --noEmit` — Typecheck

## Architecture
- `src/types.ts` — All TypeScript types
- `src/db/` — SQLite schema and queries (use bun:sqlite)
- `src/engine/` — Core: cycle-runner, phase-runner, parallel, knowledge, pflk, gree, meta, resources
- `src/providers/` — LLM providers: Cerebras, Anthropic, OpenAI, Local
- `src/cycles/definitions/` — Cycle YAML definitions (PFLK, GREE, AI-discovered)
- `src/skills/` — Pluggable skills (core, domain, meta)
- `src/sandbox/` — 4-level isolation: worktree, tempdir, container, e2b
- `src/cli/` — CLI interface
- `src/mcp/` — MCP server for AI agents
- `src/lib/` — Library API exports
- `src/config/` — Config management (~/.researcher/)
- `templates/` — Project templates for common domains

## Key Concepts
- **Cycles**: Pluggable research strategies defined in YAML. PFLK and GREE are built-in. AI can discover new ones.
- **PFLK**: Problem → Feedback → Loophole (PARALLEL experiments) → Knowledge
- **GREE**: Gather (cheap model) → Refine (better model) → Experiment → Evolve (best model)
- **Skills**: What the system can DO during phases — pluggable, AI-creatable
- **Sandboxes**: Isolated experiment environments (worktree/tempdir/container/e2b)
- **The app is NOT agentic** — an AI agent USES it to perform experiments via CLI or MCP

## Bun APIs
- `bun:sqlite` for SQLite, NOT better-sqlite3
- `Bun.file()` over node:fs
- `Bun.$` for shell commands
- `bun test` for testing
- Bun auto-loads .env
