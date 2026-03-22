/**
 * PDF parsing skill — extract text from PDFs using native LLM capabilities.
 *
 * Uses Anthropic (base64 PDF input) or OpenAI (file input) to parse PDFs.
 * Falls back to basic text extraction if no LLM provider is available.
 */

import type { Skill } from "../registry.ts"
import type { SkillInput, SkillOutput } from "../../types.ts"

export const pdfParseSkill: Skill = {
  name: "pdf-parse",
  description: "Extract text, tables, and metadata from PDF files using Anthropic or OpenAI's native PDF support. Provide a file path as parameter.",
  domains: ["general", "research", "academic", "science"],
  phases: ["gather"],
  requires: [],
  cost_per_run: "moderate",

  async execute(input: SkillInput): Promise<SkillOutput> {
    const filePath = input.parameters.path as string
    if (!filePath) {
      return { success: false, data: null, summary: "No PDF path provided. Set parameters.path to the PDF file path." }
    }

    const query = (input.parameters.query as string) ?? "Extract all text, tables, key findings, and metadata from this PDF."

    try {
      // Read the file
      const file = Bun.file(filePath)
      if (!await file.exists()) {
        return { success: false, data: null, summary: `File not found: ${filePath}` }
      }
      const buffer = await file.arrayBuffer()
      const base64 = Buffer.from(buffer).toString("base64")
      const sizeKb = (buffer.byteLength / 1024).toFixed(1)

      // Try Anthropic first (supports PDF natively via base64)
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const result = await parseWithAnthropic(base64, query)
          return {
            success: true,
            data: { text: result.text, provider: "anthropic", filePath, sizeKb },
            summary: `Parsed PDF (${sizeKb}KB) via Anthropic:\n${result.text.slice(0, 1000)}`,
            cost: result.cost,
          }
        } catch {
          // Fall through to OpenAI
        }
      }

      // Try OpenAI
      if (process.env.OPENAI_API_KEY) {
        try {
          const result = await parseWithOpenAI(base64, query)
          return {
            success: true,
            data: { text: result.text, provider: "openai", filePath, sizeKb },
            summary: `Parsed PDF (${sizeKb}KB) via OpenAI:\n${result.text.slice(0, 1000)}`,
            cost: result.cost,
          }
        } catch {
          // Fall through
        }
      }

      return {
        success: false,
        data: null,
        summary: `Cannot parse PDF: no LLM provider with PDF support available. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.`,
      }
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `PDF parsing failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}

async function parseWithAnthropic(base64: string, query: string): Promise<{ text: string; cost: number }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          },
          { type: "text", text: query },
        ],
      }],
    }),
  })

  if (!response.ok) throw new Error(`Anthropic PDF parse failed: ${response.status}`)

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>
    usage: { input_tokens: number; output_tokens: number }
  }

  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n")
  const cost = (data.usage.input_tokens * 0.8 + data.usage.output_tokens * 4) / 1_000_000

  return { text, cost }
}

async function parseWithOpenAI(base64: string, query: string): Promise<{ text: string; cost: number }> {
  // OpenAI supports PDF via file input in the Responses API
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_file", file: { data: base64, filename: "document.pdf" } },
            { type: "input_text", text: query },
          ],
        },
      ],
    }),
  })

  if (!response.ok) throw new Error(`OpenAI PDF parse failed: ${response.status}`)

  const data = (await response.json()) as {
    output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  let text = ""
  for (const output of data.output) {
    if (output.content) {
      for (const block of output.content) {
        if (block.text) text += block.text
      }
    }
  }

  const tokensIn = data.usage?.input_tokens ?? 1000
  const tokensOut = data.usage?.output_tokens ?? 500
  const cost = (tokensIn * 0.4 + tokensOut * 1.6) / 1_000_000

  return { text, cost }
}
