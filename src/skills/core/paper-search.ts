/**
 * Research paper search skill — searches arXiv and other academic repositories.
 *
 * Uses @hasna/connectors SDK to call the arxiv connector when available.
 * Falls back to direct arXiv API calls if the connector isn't installed.
 * Also integrates with web search for broader paper discovery.
 */

import type { Skill } from "../registry.ts"
import type { SkillInput, SkillOutput } from "../../types.ts"

export interface PaperResult {
  id: string
  title: string
  authors: string[]
  abstract: string
  categories: string[]
  published: string
  updated?: string
  pdfUrl: string
  arxivUrl: string
}

export const paperSearchSkill: Skill = {
  name: "paper-search",
  description: "Search academic research papers on arXiv. Supports keyword search, category filtering, author search, and recent paper listing. Uses @hasna/connectors arxiv connector when available, falls back to direct arXiv API.",
  domains: ["research", "academic", "science", "general"],
  phases: ["gather", "think"],
  requires: [],
  cost_per_run: "free",

  async execute(input: SkillInput): Promise<SkillOutput> {
    const query = (input.parameters.query as string) ?? ""
    const category = input.parameters.category as string | undefined
    const author = input.parameters.author as string | undefined
    const maxResults = (input.parameters.max_results as number) ?? 10
    const action = (input.parameters.action as string) ?? "search"

    if (!query && !category && !author) {
      return { success: false, data: null, summary: "Provide at least one of: query, category, or author." }
    }

    try {
      // Try using @hasna/connectors arxiv connector first
      const papers = await searchViaConnector(action, { query, category, author, maxResults })
        .catch(() => searchDirectArxiv(query, { category, author, maxResults }))

      if (papers.length === 0) {
        return {
          success: true,
          data: { papers: [], query },
          summary: `No papers found for "${query || category || author}".`,
        }
      }

      const formatted = papers
        .map((p, i) => `${i + 1}. **${p.title}**\n   ${p.authors.slice(0, 3).join(", ")}${p.authors.length > 3 ? " et al." : ""} (${p.published.slice(0, 10)})\n   Categories: ${p.categories.join(", ")}\n   ${p.arxivUrl}\n   ${p.abstract.slice(0, 250)}...`)
        .join("\n\n")

      return {
        success: true,
        data: { papers, query, count: papers.length },
        summary: `Found ${papers.length} papers:\n\n${formatted}`,
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `Paper search failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}

// ─── Connector-based search ─────────────────────────────────────────────────

async function searchViaConnector(
  action: string,
  params: { query: string; category?: string; author?: string; maxResults: number },
): Promise<PaperResult[]> {
  const { runConnectorCommand, connectorExists } = await import("@hasna/connectors")

  if (!connectorExists("arxiv")) {
    throw new Error("arxiv connector not installed")
  }

  const args: string[] = [action]
  if (params.query) args.push("--query", params.query)
  if (params.category) args.push("--category", params.category)
  if (params.author) args.push("--author", params.author)
  args.push("--max-results", String(params.maxResults))
  args.push("--json")

  const result = await runConnectorCommand("arxiv", args)

  if (!result.success) {
    throw new Error(result.stderr || "Connector command failed")
  }

  // Parse connector stdout — expected to return structured JSON
  const data = JSON.parse(result.stdout)
  if (Array.isArray(data)) return data as PaperResult[]
  if (data?.papers) return data.papers as PaperResult[]
  return []
}

// ─── Direct arXiv API fallback ──────────────────────────────────────────────

async function searchDirectArxiv(
  query: string,
  opts: { category?: string; author?: string; maxResults: number },
): Promise<PaperResult[]> {
  // Build arXiv API query
  const searchTerms: string[] = []
  if (query) searchTerms.push(`all:${query}`)
  if (opts.author) searchTerms.push(`au:${opts.author}`)
  if (opts.category) searchTerms.push(`cat:${opts.category}`)

  const searchQuery = searchTerms.join("+AND+")
  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(searchQuery)}&start=0&max_results=${opts.maxResults}&sortBy=relevance&sortOrder=descending`

  const response = await fetch(url)
  if (!response.ok) throw new Error(`arXiv API error: ${response.status}`)

  const xml = await response.text()
  return parseArxivXml(xml)
}

function parseArxivXml(xml: string): PaperResult[] {
  const papers: PaperResult[] = []
  const entries = xml.split("<entry>").slice(1) // skip the feed header

  for (const entry of entries) {
    const id = extractTag(entry, "id")?.replace("http://arxiv.org/abs/", "") ?? ""
    const title = extractTag(entry, "title")?.replace(/\s+/g, " ").trim() ?? ""
    const abstract = extractTag(entry, "summary")?.replace(/\s+/g, " ").trim() ?? ""
    const published = extractTag(entry, "published") ?? ""
    const updated = extractTag(entry, "updated")

    // Extract authors
    const authors: string[] = []
    const authorMatches = entry.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)
    for (const m of authorMatches) {
      if (m[1]) authors.push(m[1].trim())
    }

    // Extract categories
    const categories: string[] = []
    const catMatches = entry.matchAll(/category[^>]*term="([^"]+)"/g)
    for (const m of catMatches) {
      if (m[1]) categories.push(m[1])
    }

    // PDF URL
    const pdfMatch = entry.match(/href="([^"]*)"[^>]*title="pdf"/i)
    const pdfUrl = pdfMatch?.[1] ?? `https://arxiv.org/pdf/${id}`

    if (id && title) {
      papers.push({
        id,
        title,
        authors,
        abstract,
        categories,
        published,
        updated: updated ?? undefined,
        pdfUrl,
        arxivUrl: `https://arxiv.org/abs/${id}`,
      })
    }
  }

  return papers
}

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return match?.[1]?.trim() ?? null
}

export { searchDirectArxiv, parseArxivXml }
