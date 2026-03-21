/**
 * SQLite schema for researcher.
 * Uses bun:sqlite native API.
 */

export const SCHEMA_VERSION = 4

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

-- ─── Knowledge Edges (Graph) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK(relationship IN ('contradicts','depends_on','supersedes','supports','derives_from','related_to')),
  weight REAL DEFAULT 1.0,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_id, target_id, relationship)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON knowledge_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON knowledge_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relationship ON knowledge_edges(relationship);

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

-- ─── Pipeline Runs ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pipeline_id TEXT NOT NULL,
  status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed','stopped')),
  current_step TEXT,
  steps_completed INTEGER DEFAULT 0,
  cost_total REAL DEFAULT 0,
  config TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON pipeline_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

-- ─── Graphs ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS graphs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ontology TEXT NOT NULL DEFAULT '{}',
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  episode_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_graphs_project ON graphs(project_id);

-- ─── Graph Nodes ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  attributes TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(graph_id, name)
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_graph ON graph_nodes(graph_id);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON graph_nodes(name);

-- ─── Graph Edges ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  fact TEXT NOT NULL DEFAULT '',
  source_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  attributes TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  valid_at TEXT,
  invalid_at TEXT,
  expired_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_graph ON graph_edges(graph_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_node_id);

-- ─── Graph Episodes ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS graph_episodes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  processed INTEGER NOT NULL DEFAULT 0,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_graph_episodes_graph ON graph_episodes(graph_id);
CREATE INDEX IF NOT EXISTS idx_graph_episodes_processed ON graph_episodes(processed);

-- ─── Graph FTS (Full-Text Search) ───────────────────────────────────────────

CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
  name, summary, labels,
  content='graph_nodes',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS graph_edges_fts USING fts5(
  name, fact,
  content='graph_edges',
  content_rowid='rowid'
);

-- FTS triggers to keep indexes in sync
CREATE TRIGGER IF NOT EXISTS graph_nodes_ai AFTER INSERT ON graph_nodes BEGIN
  INSERT INTO graph_nodes_fts(rowid, name, summary, labels)
  VALUES (new.rowid, new.name, new.summary, new.labels);
END;

CREATE TRIGGER IF NOT EXISTS graph_nodes_ad AFTER DELETE ON graph_nodes BEGIN
  INSERT INTO graph_nodes_fts(graph_nodes_fts, rowid, name, summary, labels)
  VALUES ('delete', old.rowid, old.name, old.summary, old.labels);
END;

CREATE TRIGGER IF NOT EXISTS graph_nodes_au AFTER UPDATE ON graph_nodes BEGIN
  INSERT INTO graph_nodes_fts(graph_nodes_fts, rowid, name, summary, labels)
  VALUES ('delete', old.rowid, old.name, old.summary, old.labels);
  INSERT INTO graph_nodes_fts(rowid, name, summary, labels)
  VALUES (new.rowid, new.name, new.summary, new.labels);
END;

CREATE TRIGGER IF NOT EXISTS graph_edges_ai AFTER INSERT ON graph_edges BEGIN
  INSERT INTO graph_edges_fts(rowid, name, fact)
  VALUES (new.rowid, new.name, new.fact);
END;

CREATE TRIGGER IF NOT EXISTS graph_edges_ad AFTER DELETE ON graph_edges BEGIN
  INSERT INTO graph_edges_fts(graph_edges_fts, rowid, name, fact)
  VALUES ('delete', old.rowid, old.name, old.fact);
END;

CREATE TRIGGER IF NOT EXISTS graph_edges_au AFTER UPDATE ON graph_edges BEGIN
  INSERT INTO graph_edges_fts(graph_edges_fts, rowid, name, fact)
  VALUES ('delete', old.rowid, old.name, old.fact);
  INSERT INTO graph_edges_fts(rowid, name, fact)
  VALUES (new.rowid, new.name, new.fact);
END;

-- ─── Schema version tracking ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`
