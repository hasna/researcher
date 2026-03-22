import { test, expect, mock } from "bun:test"
import { parseArxivXml, type PaperResult } from "./core/paper-search.ts"
import { createDefaultRegistry } from "./index.ts"

const SAMPLE_ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <id>http://arxiv.org/abs/2301.12345v1</id>
  <title>Attention Is All You Need: A Revisitation</title>
  <summary>We revisit the transformer architecture and propose improvements to the self-attention mechanism that reduce computational complexity from O(n^2) to O(n log n).</summary>
  <published>2023-01-15T00:00:00Z</published>
  <updated>2023-01-20T00:00:00Z</updated>
  <author><name>Alice Researcher</name></author>
  <author><name>Bob Scientist</name></author>
  <author><name>Carol Engineer</name></author>
  <link href="http://arxiv.org/pdf/2301.12345v1" title="pdf" type="application/pdf"/>
  <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
  <category term="cs.CL"/>
  <category term="cs.AI"/>
</entry>
<entry>
  <id>http://arxiv.org/abs/2302.67890v2</id>
  <title>Scaling Laws for Language Models</title>
  <summary>We study how model performance scales with compute, data, and parameters, finding power-law relationships across six orders of magnitude.</summary>
  <published>2023-02-10T00:00:00Z</published>
  <author><name>Dave Optimizer</name></author>
  <link href="http://arxiv.org/pdf/2302.67890v2" title="pdf" type="application/pdf"/>
  <category term="cs.LG"/>
</entry>
</feed>`

test("parseArxivXml extracts papers from XML", () => {
  const papers = parseArxivXml(SAMPLE_ARXIV_XML)
  expect(papers).toHaveLength(2)

  expect(papers[0]!.id).toBe("2301.12345v1")
  expect(papers[0]!.title).toBe("Attention Is All You Need: A Revisitation")
  expect(papers[0]!.authors).toEqual(["Alice Researcher", "Bob Scientist", "Carol Engineer"])
  expect(papers[0]!.abstract).toContain("transformer architecture")
  expect(papers[0]!.categories).toContain("cs.CL")
  expect(papers[0]!.categories).toContain("cs.AI")
  expect(papers[0]!.published).toBe("2023-01-15T00:00:00Z")
  expect(papers[0]!.pdfUrl).toBe("http://arxiv.org/pdf/2301.12345v1")
  expect(papers[0]!.arxivUrl).toBe("https://arxiv.org/abs/2301.12345v1")
})

test("parseArxivXml handles single author", () => {
  const papers = parseArxivXml(SAMPLE_ARXIV_XML)
  expect(papers[1]!.authors).toEqual(["Dave Optimizer"])
})

test("parseArxivXml handles empty XML", () => {
  const papers = parseArxivXml("<feed></feed>")
  expect(papers).toHaveLength(0)
})

test("paper-search skill is registered in default registry", () => {
  const registry = createDefaultRegistry()
  expect(registry.has("paper-search")).toBe(true)

  const gatherSkills = registry.forPhase("gather")
  expect(gatherSkills.some(s => s.name === "paper-search")).toBe(true)
})

test("paper-search skill requires query or category or author", async () => {
  const registry = createDefaultRegistry()
  const skill = registry.get("paper-search")!
  const result = await skill.execute({
    context: "test",
    parameters: {},
  })
  expect(result.success).toBe(false)
  expect(result.summary).toContain("Provide at least one")
})
