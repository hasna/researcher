/**
 * SQLite schema for researcher.
 * Uses bun:sqlite native API.
 */

export const SCHEMA_VERSION = 1

export const SCHEMA_SQL = `
-- ─── Projects ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('git_repo', 'directory', 'virtual', 'cloud')),
  path TEXT,
  remote_url TEXT,
  domain TEXT NOT NULL DEFAULT 'general',
  metric_name TEXT NOT NULL DEFAULT 'score',
  metric_direction TEXT NOT NULL CHECK (metric_direction IN ('lower', 'higher')) DEFAULT 'higher',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Workspaces ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL,
  current_phase TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed')) DEFAULT 'running',
  config TEXT NOT NULL DEFAULT '{}',
  cost_total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);

-- ─── Sandboxes ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('worktree', 'tempdir', 'container', 'e2b')),
  path TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'running', 'completed', 'failed', 'cleanup')) DEFAULT 'creating',
  hypothesis TEXT NOT NULL DEFAULT '',
  git_branch TEXT,
  container_id TEXT,
  e2b_sandbox_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sandboxes_workspace ON sandboxes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sandboxes_status ON sandboxes(status);

-- ─── Results ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  metrics TEXT NOT NULL DEFAULT '{}',
  decision TEXT NOT NULL CHECK (decision IN ('keep', 'discard', 'crash')),
  diff TEXT,
  cost REAL NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  reasoning TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_results_workspace ON results(workspace_id);
CREATE INDEX IF NOT EXISTS idx_results_sandbox ON results(sandbox_id);
CREATE INDEX IF NOT EXISTS idx_results_decision ON results(decision);

-- ─── Knowledge ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  domain TEXT NOT NULL DEFAULT 'general',
  insight TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_domain ON knowledge(domain);

-- ─── Cycles ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL CHECK (author IN ('human', 'ai')) DEFAULT 'human',
  definition TEXT NOT NULL DEFAULT '{}',
  success_rate REAL,
  best_domains TEXT NOT NULL DEFAULT '[]',
  total_runs INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Skills ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL CHECK (author IN ('builtin', 'human', 'ai')) DEFAULT 'builtin',
  file_path TEXT,
  domains TEXT NOT NULL DEFAULT '[]',
  phases TEXT NOT NULL DEFAULT '[]',
  requires TEXT NOT NULL DEFAULT '[]',
  total_uses INTEGER NOT NULL DEFAULT 0,
  success_rate REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── PFLK Cycles ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pflk_cycles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  problem TEXT NOT NULL DEFAULT '',
  feedback TEXT NOT NULL DEFAULT '',
  loopholes TEXT NOT NULL DEFAULT '[]',
  knowledge TEXT,
  winning_experiment_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pflk_project ON pflk_cycles(project_id);
CREATE INDEX IF NOT EXISTS idx_pflk_workspace ON pflk_cycles(workspace_id);

-- ─── GREE Phases ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gree_phases (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('gather', 'refine', 'experiment', 'evolve')),
  provider_used TEXT NOT NULL DEFAULT '',
  model_used TEXT NOT NULL DEFAULT '',
  input_summary TEXT NOT NULL DEFAULT '',
  output_summary TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gree_workspace ON gree_phases(workspace_id);

-- ─── Model Calls ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  sandbox_id TEXT REFERENCES sandboxes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  phase TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_model_calls_workspace ON model_calls(workspace_id);
CREATE INDEX IF NOT EXISTS idx_model_calls_provider ON model_calls(provider);

-- ─── Schema version tracking ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`
