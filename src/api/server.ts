/**
 * REST API server for researcher — Bun.serve() based.
 */

import { initDb, listProjects, getProject, getProjectByName, createProject, deleteProject, listWorkspaces, getWorkspace, listResults, getCostSummary } from "../db/index.ts"
import { queryKnowledge, exportKnowledgeMarkdown } from "../engine/knowledge.ts"
import { ResourceManager } from "../engine/resources.ts"
import { getDbPath } from "../config/index.ts"

export function startServer(port: number = 7070) {
  const db = initDb(getDbPath())
  const rm = new ResourceManager()

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      // CORS
      if (method === "OPTIONS") {
        return new Response(null, {
          headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE", "Access-Control-Allow-Headers": "Content-Type" },
        })
      }

      const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }

      try {
        // Projects
        if (path === "/projects" && method === "GET") {
          return Response.json(listProjects(db), { headers: cors })
        }
        if (path === "/projects" && method === "POST") {
          const body = (await req.json()) as { name: string; type: string; path?: string; domain?: string; metric_name?: string; metric_direction?: string }
          const id = createProject(db, body)
          return Response.json({ id, ...body }, { status: 201, headers: cors })
        }
        if (path.startsWith("/projects/") && method === "GET") {
          const id = path.split("/")[2]!
          const project = getProjectByName(db, id) ?? getProject(db, id)
          if (!project) return Response.json({ error: "Not found" }, { status: 404, headers: cors })
          return Response.json(project, { headers: cors })
        }
        if (path.startsWith("/projects/") && method === "DELETE") {
          const id = path.split("/")[2]!
          const project = getProjectByName(db, id) ?? getProject(db, id)
          if (!project) return Response.json({ error: "Not found" }, { status: 404, headers: cors })
          deleteProject(db, (project as Record<string, unknown>).id as string)
          return Response.json({ deleted: true }, { headers: cors })
        }

        // Workspaces
        if (path === "/workspaces" && method === "GET") {
          const status = url.searchParams.get("status")
          return Response.json(listWorkspaces(db, status ?? undefined), { headers: cors })
        }
        if (path.startsWith("/workspaces/") && method === "GET") {
          const id = path.split("/")[2]!
          const ws = getWorkspace(db, id)
          if (!ws) return Response.json({ error: "Not found" }, { status: 404, headers: cors })
          const results = listResults(db, id)
          return Response.json({ workspace: ws, results }, { headers: cors })
        }

        // Status
        if (path === "/status" && method === "GET") {
          const status = rm.getStatus(db)
          const workspaces = listWorkspaces(db)
          return Response.json({ status, workspaces }, { headers: cors })
        }

        // Knowledge
        if (path === "/knowledge" && method === "GET") {
          const domain = url.searchParams.get("domain") ?? undefined
          const search = url.searchParams.get("search") ?? undefined
          const projectId = url.searchParams.get("project_id") ?? undefined
          return Response.json(queryKnowledge(db, { domain, search, project_id: projectId }), { headers: cors })
        }

        // Cost
        if (path === "/cost" && method === "GET") {
          const wsId = url.searchParams.get("workspace") ?? undefined
          const summary = getCostSummary(db, wsId)
          const daily = rm.getDailyCost(db)
          const hourly = rm.getHourlyCost(db)
          return Response.json({ daily, hourly, breakdown: summary }, { headers: cors })
        }

        return Response.json({ error: "Not found" }, { status: 404, headers: cors })
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500, headers: cors })
      }
    },
  })

  console.log(`Researcher API server running on http://localhost:${server.port}`)
  return server
}
