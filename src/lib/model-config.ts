// Model config for open-researcher.
// Stores the active fine-tuned model ID in ~/.hasna/researcher/config.json.
// (Separate from config.toml which holds the framework config.)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const DEFAULT_MODEL = "gpt-4o-mini"

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "."
const CONFIG_DIR = join(HOME, ".hasna", "researcher")
const MODEL_CONFIG_FILE = join(CONFIG_DIR, "config.json")

interface ResearcherModelConfig {
  activeModel?: string
  [key: string]: unknown
}

function readConfig(): ResearcherModelConfig {
  if (!existsSync(MODEL_CONFIG_FILE)) return {}
  try {
    return JSON.parse(readFileSync(MODEL_CONFIG_FILE, "utf-8")) as ResearcherModelConfig
  } catch {
    return {}
  }
}

function writeConfig(config: ResearcherModelConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(MODEL_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8")
}

/**
 * Get the active fine-tuned model ID.
 * Falls back to DEFAULT_MODEL if none has been set.
 */
export function getActiveModel(): string {
  const config = readConfig()
  return config.activeModel ?? DEFAULT_MODEL
}

/**
 * Set the active fine-tuned model ID in ~/.hasna/researcher/config.json.
 */
export function setActiveModel(id: string): void {
  const config = readConfig()
  config.activeModel = id
  writeConfig(config)
}

/**
 * Clear the active model (revert to default).
 */
export function clearActiveModel(): void {
  const config = readConfig()
  delete config.activeModel
  writeConfig(config)
}
