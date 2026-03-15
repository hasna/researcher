# Researcher MCP Skill

Use the researcher MCP tools to run autonomous experiments on any project.

## When to Use
- User wants to optimize code, prompts, configs, or any measurable metric
- User wants to run experiments autonomously
- User mentions "research", "experiment", "optimize", "PFLK", "GREE"

## Workflow

### 1. Create a project (if not exists)
```
researcher_create_project(name, type, domain, metric_name, metric_direction)
```
Types: git_repo, directory, virtual, cloud
Domains: code, marketing, finance, infrastructure, prompts, mcp, general

### 2. Start a workspace
```
researcher_start_workspace(project, cycle, parallel)
```
Cycles:
- **pflk** — Problem → Feedback → Loophole (parallel experiments) → Knowledge. Best for: focused optimization with clear metric.
- **gree** — Gather (cheap model) → Refine (better model) → Experiment → Evolve (best model). Best for: broad research where you need to explore first.

### 3. Run the cycle
```
researcher_run_cycle(workspace_id, user_goal?)
```
This executes all phases. Each phase uses a different provider based on intelligence needed.

### 4. Check results
```
researcher_get_status()
researcher_get_workspace(workspace_id)
researcher_query_knowledge(search?, domain?)
```

### 5. Export findings
```
researcher_export_knowledge(project_id?)
```

## Provider Routing
- **cheap** phases → Cerebras (fast, $0.0001/call)
- **balanced** phases → OpenAI GPT-4.1-mini ($0.001/call)
- **smart** phases → Anthropic Claude Sonnet ($0.03/call)
- **best** phases → Anthropic Claude Opus ($0.23/call)

## Tips
- Use `researcher_list_cycles` to see available cycles
- Use `researcher_list_skills` to see what skills are available
- Knowledge accumulates across runs — query it before starting new experiments
- Set a specific goal for better-targeted experiments
