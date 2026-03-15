/**
 * Cycle registry — discovers and manages available cycle definitions.
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { CycleDefinition } from "../types.ts"
import { loadCycleFromFile } from "./parser.ts"

const BUILT_IN_DIR = join(import.meta.dir, "definitions")

export class CycleRegistry {
  private cycles: Map<string, CycleDefinition> = new Map()

  /**
   * Load all built-in cycles from the definitions/ directory.
   */
  async loadBuiltIn(): Promise<void> {
    await this.loadFromDirectory(BUILT_IN_DIR)
  }

  /**
   * Load all YAML cycle files from a directory.
   */
  async loadFromDirectory(dir: string): Promise<void> {
    try {
      const files = await readdir(dir)
      for (const file of files) {
        if (file.endsWith(".yaml") || file.endsWith(".yml")) {
          try {
            const cycle = await loadCycleFromFile(join(dir, file))
            this.cycles.set(cycle.id, cycle)
          } catch (err) {
            console.error(`Failed to load cycle from ${file}:`, err)
          }
        }
      }
    } catch {
      // Directory doesn't exist, that's OK
    }
  }

  /**
   * Register a cycle definition directly.
   */
  register(cycle: CycleDefinition): void {
    this.cycles.set(cycle.id, cycle)
  }

  /**
   * Get a cycle by ID.
   */
  get(id: string): CycleDefinition | undefined {
    return this.cycles.get(id)
  }

  /**
   * List all available cycles.
   */
  list(): CycleDefinition[] {
    return [...this.cycles.values()]
  }

  /**
   * Check if a cycle exists.
   */
  has(id: string): boolean {
    return this.cycles.has(id)
  }
}
