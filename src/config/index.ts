/**
 * Configuration system — ~/.researcher/ management.
 * Supports TOML config files with env var fallbacks for API keys.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ResearcherConfig } from "../types.ts"

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "."
const CONFIG_DIR = join(HOME, ".researcher")
const CONFIG_FILE = join(CONFIG_DIR, "config.toml")
const DB_FILE = join(CONFIG_DIR, "researcher.db")

export const DEFAULT_CONFIG: ResearcherConfig = {
  general: {
    default_cycle: "pflk",
    data_dir: CONFIG_DIR,
  },
  providers: {},
  resources: {
    max_parallel_sandboxes: 20,
    max_parallel_per_workspace: 10,
    max_cost_per_hour: 5,
    max_container_sandboxes: 5,
    max_cloud_sandboxes: 2,
  },
}

/**
 * Ensure the config directory exists.
 */
export function ensureConfigDir(): string {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  return CONFIG_DIR
}

/**
 * Load config from file + env vars.
 */
export function loadConfig(): ResearcherConfig {
  const config = structuredClone(DEFAULT_CONFIG)

  // Try to load from TOML file
  if (existsSync(CONFIG_FILE)) {
    try {
      const content = readFileSync(CONFIG_FILE, "utf-8")
      const parsed = parseSimpleToml(content)
      mergeConfig(config, parsed)
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  // Env var fallbacks for API keys
  if (process.env.ANTHROPIC_API_KEY) {
    config.providers.anthropic = {
      name: "anthropic",
      api_key: process.env.ANTHROPIC_API_KEY,
      default_model: config.providers.anthropic?.default_model ?? "claude-sonnet-4-6",
    }
  }
  if (process.env.OPENAI_API_KEY) {
    config.providers.openai = {
      name: "openai",
      api_key: process.env.OPENAI_API_KEY,
      default_model: config.providers.openai?.default_model ?? "gpt-4.1-mini",
    }
  }
  if (process.env.CEREBRAS_API_KEY) {
    config.providers.cerebras = {
      name: "cerebras",
      api_key: process.env.CEREBRAS_API_KEY,
      base_url: "https://api.cerebras.ai/v1",
      default_model: config.providers.cerebras?.default_model ?? "llama3.1-8b",
    }
  }
  if (process.env.LOCAL_LLM_URL || process.env.LOCAL_LLM_MODEL) {
    config.providers.local = {
      name: "local",
      base_url: process.env.LOCAL_LLM_URL ?? "http://localhost:11434/v1",
      default_model: process.env.LOCAL_LLM_MODEL ?? "qwen3:32b",
    }
  }
  if (process.env.E2B_API_KEY) {
    config.e2b = { api_key: process.env.E2B_API_KEY }
  }

  return config
}

/**
 * Save config to TOML file.
 */
export function saveConfig(config: ResearcherConfig): void {
  ensureConfigDir()
  const toml = generateToml(config)
  writeFileSync(CONFIG_FILE, toml, "utf-8")
}

/**
 * Get the database file path.
 */
export function getDbPath(): string {
  ensureConfigDir()
  return DB_FILE
}

/**
 * Get config directory path.
 */
export function getConfigDir(): string {
  return CONFIG_DIR
}

// ─── Simple TOML parser (key = "value" lines only) ──────────────────────────

function parseSimpleToml(content: string): Record<string, unknown> {
  const result: Record<string, Record<string, unknown>> = {}
  let currentSection = "general"

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    // Section header
    const sectionMatch = trimmed.match(/^\[(.+)]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1]!
      if (!result[currentSection]) result[currentSection] = {}
      continue
    }

    // Key = value
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/)
    if (kvMatch) {
      const [, key, rawValue] = kvMatch
      if (!result[currentSection]) result[currentSection] = {}
      // Parse value
      let value: unknown = rawValue!.trim()
      if ((value as string).startsWith('"') && (value as string).endsWith('"')) {
        value = (value as string).slice(1, -1)
      } else if ((value as string) === "true") {
        value = true
      } else if ((value as string) === "false") {
        value = false
      } else if (!isNaN(Number(value))) {
        value = Number(value)
      }
      result[currentSection]![key!] = value
    }
  }

  return result
}

function mergeConfig(target: ResearcherConfig, source: Record<string, unknown>): void {
  const general = source.general as Record<string, unknown> | undefined
  if (general) {
    if (general.default_cycle) target.general.default_cycle = general.default_cycle as string
    if (general.data_dir) target.general.data_dir = general.data_dir as string
  }

  const resources = source.resources as Record<string, unknown> | undefined
  if (resources) {
    if (resources.max_parallel_sandboxes !== undefined)
      target.resources.max_parallel_sandboxes = resources.max_parallel_sandboxes as number
    if (resources.max_parallel_per_workspace !== undefined)
      target.resources.max_parallel_per_workspace = resources.max_parallel_per_workspace as number
    if (resources.max_cost_per_hour !== undefined)
      target.resources.max_cost_per_hour = resources.max_cost_per_hour as number
    if (resources.max_container_sandboxes !== undefined)
      target.resources.max_container_sandboxes = resources.max_container_sandboxes as number
    if (resources.max_cloud_sandboxes !== undefined)
      target.resources.max_cloud_sandboxes = resources.max_cloud_sandboxes as number
  }
}

function generateToml(config: ResearcherConfig): string {
  let toml = `# researcher configuration\n# Generated by @hasna/researcher\n\n`

  toml += `[general]\ndefault_cycle = "${config.general.default_cycle}"\ndata_dir = "${config.general.data_dir}"\n\n`

  if (config.providers.anthropic) {
    toml += `[providers.anthropic]\n`
    if (config.providers.anthropic.api_key) toml += `api_key = "${config.providers.anthropic.api_key}"\n`
    toml += `default_model = "${config.providers.anthropic.default_model}"\n\n`
  }
  if (config.providers.openai) {
    toml += `[providers.openai]\n`
    if (config.providers.openai.api_key) toml += `api_key = "${config.providers.openai.api_key}"\n`
    toml += `default_model = "${config.providers.openai.default_model}"\n\n`
  }
  if (config.providers.cerebras) {
    toml += `[providers.cerebras]\n`
    if (config.providers.cerebras.api_key) toml += `api_key = "${config.providers.cerebras.api_key}"\n`
    if (config.providers.cerebras.base_url) toml += `base_url = "${config.providers.cerebras.base_url}"\n`
    toml += `default_model = "${config.providers.cerebras.default_model}"\n\n`
  }
  if (config.providers.local) {
    toml += `[providers.local]\n`
    if (config.providers.local.base_url) toml += `base_url = "${config.providers.local.base_url}"\n`
    toml += `default_model = "${config.providers.local.default_model}"\n\n`
  }

  if (config.e2b?.api_key) {
    toml += `[e2b]\napi_key = "${config.e2b.api_key}"\n\n`
  }

  toml += `[resources]\nmax_parallel_sandboxes = ${config.resources.max_parallel_sandboxes}\n`
  toml += `max_parallel_per_workspace = ${config.resources.max_parallel_per_workspace}\n`
  toml += `max_cost_per_hour = ${config.resources.max_cost_per_hour}\n`
  toml += `max_container_sandboxes = ${config.resources.max_container_sandboxes}\n`
  toml += `max_cloud_sandboxes = ${config.resources.max_cloud_sandboxes}\n`

  return toml
}
