// researcher brains — Training data and fine-tuning subcommand.
// Subcommands: gather, train, model, model set, model clear

import { Command } from "commander"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { gatherTrainingData } from "../lib/gatherer.ts"
import {
  getActiveModel,
  setActiveModel,
  clearActiveModel,
  DEFAULT_MODEL,
} from "../lib/model-config.ts"

function isJson(program: Command): boolean {
  return program.opts().json === true
}

function jsonOut(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n")
}

export function registerBrainsCommand(program: Command): void {
  const brainsCmd = program
    .command("brains")
    .description("Fine-tuning integration with @hasna/brains")

  // ── researcher brains gather ──────────────────────────────────────────────

  brainsCmd
    .command("gather")
    .description("Gather training data from research projects, workspaces, and knowledge")
    .option("-l, --limit <n>", "Max number of training examples", "500")
    .option("-o, --output <dir>", "Output directory (default: ~/.researcher/training/)")
    .action(async (opts: { limit?: string; output?: string }) => {
      const limit = parseInt(opts.limit ?? "500", 10)
      const outputDir = opts.output ?? join(homedir(), ".researcher", "training")
      const json = isJson(program)

      if (!json) {
        process.stdout.write("Gathering training data from researcher...\n")
      }

      try {
        const result = await gatherTrainingData({ limit })

        await mkdir(outputDir, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
        const outputPath = join(outputDir, `researcher-training-${timestamp}.jsonl`)
        const jsonl = result.examples.map((ex) => JSON.stringify(ex)).join("\n")
        await writeFile(outputPath, jsonl, "utf-8")

        if (json) {
          jsonOut({ ok: true, source: result.source, count: result.count, path: outputPath })
          return
        }

        console.log(`✔ Gathered ${result.count} training examples`)
        console.log(`  Written to: ${outputPath}`)
        console.log(`  Run: researcher brains train --dataset ${outputPath}`)
      } catch (err) {
        if (json) jsonOut({ error: (err as Error).message })
        else console.error(`✖ Gather failed: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── researcher brains train ───────────────────────────────────────────────

  brainsCmd
    .command("train")
    .description("Start a fine-tuning job using @hasna/brains")
    .option("--base-model <model>", "Base model to fine-tune", DEFAULT_MODEL)
    .option("--name <name>", "Name for the fine-tuned model", "researcher-v1")
    .option("--dataset <path>", "Path to JSONL dataset (default: latest in ~/.researcher/training/)")
    .option("--provider <provider>", "Provider: openai or thinker-labs", "openai")
    .action(async (opts: { baseModel: string; name: string; dataset?: string; provider: string }) => {
      const json = isJson(program)

      if (!json) {
        console.log("Starting fine-tune job...")
        console.log(`  Base model: ${opts.baseModel}`)
        console.log(`  Name: ${opts.name}`)
        console.log(`  Provider: ${opts.provider}`)
      }

      // Try to import @hasna/brains SDK
      let brains: Record<string, unknown>
      try {
        // @ts-ignore — optional peer dependency
        brains = await import("@hasna/brains") as Record<string, unknown>
      } catch {
        const msg =
          "@hasna/brains is not installed. Install it with:\n  bun add @hasna/brains\n\nThen re-run: researcher brains train"
        if (json) jsonOut({ error: msg })
        else console.error("⚠ " + msg)
        process.exit(1)
      }

      // Resolve dataset path
      let datasetPath = opts.dataset
      if (!datasetPath) {
        const trainingDir = join(homedir(), ".researcher", "training")
        try {
          const { readdirSync, statSync } = await import("node:fs")
          const files = readdirSync(trainingDir)
            .filter((f: string) => f.endsWith(".jsonl"))
            .map((f: string) => ({
              name: f,
              mtime: statSync(join(trainingDir, f)).mtimeMs,
            }))
            .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime)

          if (files.length === 0) {
            const msg = "No JSONL datasets found in ~/.researcher/training/. Run: researcher brains gather"
            if (json) jsonOut({ error: msg })
            else console.error("✖ " + msg)
            process.exit(1)
          }

          datasetPath = join(trainingDir, (files[0] as { name: string }).name)
          if (!json) console.log(`  Dataset: ${datasetPath}`)
        } catch {
          const msg = "Could not find a dataset. Run: researcher brains gather first."
          if (json) jsonOut({ error: msg })
          else console.error("✖ " + msg)
          process.exit(1)
        }
      }

      try {
        const startFn =
          typeof brains["startFinetune"] === "function"
            ? (brains["startFinetune"] as Function)
            : null

        if (!startFn) {
          const msg = "@hasna/brains does not export startFinetune. Check the installed version."
          if (json) jsonOut({ error: msg })
          else console.error("⚠ " + msg)
          process.exit(1)
        }

        const job = await startFn({
          provider: opts.provider,
          baseModel: opts.baseModel,
          dataset: datasetPath,
          name: opts.name,
        })

        if (json) { jsonOut({ ok: true, job }); return }

        const j = job as Record<string, unknown>
        console.log("✔ Fine-tune job started")
        if (j["id"]) console.log(`  Job ID: ${String(j["id"])}`)
        if (j["status"]) console.log(`  Status: ${String(j["status"])}`)
        console.log("\n  When complete, set the model with:")
        console.log("  researcher brains model set <model-id>")
      } catch (err) {
        if (json) jsonOut({ error: (err as Error).message })
        else console.error(`✖ ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── researcher brains model ───────────────────────────────────────────────

  const modelCmd = brainsCmd
    .command("model")
    .description("Show or set the active fine-tuned model for researcher")
    .action(() => {
      const active = getActiveModel()
      const isDefault = active === DEFAULT_MODEL
      const json = isJson(program)

      if (json) { jsonOut({ activeModel: active, isDefault }); return }

      console.log()
      console.log(`Active model: ${active}`)
      if (isDefault) {
        console.log("  (using default — no fine-tuned model set)")
        console.log("  Run: researcher brains train  to create a fine-tuned model")
        console.log("  Then: researcher brains model set <model-id>")
      } else {
        console.log("  (fine-tuned model)")
        console.log("  To reset to default: researcher brains model clear")
      }
      console.log()
    })

  modelCmd
    .command("set <id>")
    .description("Set the active fine-tuned model ID")
    .action((id: string) => {
      setActiveModel(id)
      const json = isJson(program)

      if (json) { jsonOut({ ok: true, activeModel: id }); return }

      console.log(`✔ Active model set to: ${id}`)
      console.log("  Researcher AI calls will now use this model.")
    })

  modelCmd
    .command("clear")
    .description("Clear the active model (revert to default)")
    .action(() => {
      clearActiveModel()
      const json = isJson(program)

      if (json) { jsonOut({ ok: true, activeModel: DEFAULT_MODEL }); return }

      console.log(`✔ Active model cleared — using default: ${DEFAULT_MODEL}`)
    })
}
