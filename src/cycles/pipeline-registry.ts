/**
 * Pipeline registry -- discovers and manages available pipeline definitions.
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { CyclePipeline } from "../types.ts"
import { loadPipelineFromFile } from "./pipeline-parser.ts"

const BUILT_IN_DIR = join(import.meta.dir, "pipelines")

export class PipelineRegistry {
  private pipelines: Map<string, CyclePipeline> = new Map()

  /**
   * Load all built-in pipelines from the pipelines/ directory.
   */
  async loadBuiltIn(): Promise<void> {
    await this.loadFromDirectory(BUILT_IN_DIR)
  }

  /**
   * Load all YAML pipeline files from a directory.
   */
  async loadFromDirectory(dir: string): Promise<void> {
    try {
      const files = await readdir(dir)
      for (const file of files) {
        if (file.endsWith(".yaml") || file.endsWith(".yml")) {
          try {
            const pipeline = await loadPipelineFromFile(join(dir, file))
            this.pipelines.set(pipeline.id, pipeline)
          } catch (err) {
            console.error(`Failed to load pipeline from ${file}:`, err)
          }
        }
      }
    } catch {
      // Directory doesn't exist, that's OK
    }
  }

  /**
   * Register a pipeline definition directly.
   */
  register(pipeline: CyclePipeline): void {
    this.pipelines.set(pipeline.id, pipeline)
  }

  /**
   * Get a pipeline by ID.
   */
  get(id: string): CyclePipeline | undefined {
    return this.pipelines.get(id)
  }

  /**
   * List all available pipelines.
   */
  list(): CyclePipeline[] {
    return [...this.pipelines.values()]
  }

  /**
   * Check if a pipeline exists.
   */
  has(id: string): boolean {
    return this.pipelines.has(id)
  }
}
