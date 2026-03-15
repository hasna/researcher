import { test, expect } from "bun:test"
import { parseMetrics } from "./parallel.ts"

test("parseMetrics: standard key: value format", () => {
  const output = `val_bpb: 0.997900
training_seconds: 300.1
peak_vram_mb: 45060.2`
  const metrics = parseMetrics(output, "val_bpb")
  expect(metrics.val_bpb).toBeCloseTo(0.9979)
  expect(metrics.training_seconds).toBeCloseTo(300.1)
  expect(metrics.peak_vram_mb).toBeCloseTo(45060.2)
})

test("parseMetrics: key=value format", () => {
  const output = `score=0.85
latency=120.5`
  const metrics = parseMetrics(output, "score")
  expect(metrics.score).toBeCloseTo(0.85)
  expect(metrics.latency).toBeCloseTo(120.5)
})

test("parseMetrics: scientific notation", () => {
  const output = `flops: 1.23e12
loss: 3.5e-4`
  const metrics = parseMetrics(output, "loss")
  expect(metrics.flops).toBeCloseTo(1.23e12)
  expect(metrics.loss).toBeCloseTo(3.5e-4)
})

test("parseMetrics: ignores non-metric lines", () => {
  const output = `Loading model...
Training started
val_bpb: 0.95
Done.`
  const metrics = parseMetrics(output, "val_bpb")
  expect(Object.keys(metrics)).toHaveLength(1)
  expect(metrics.val_bpb).toBeCloseTo(0.95)
})

test("parseMetrics: empty output returns empty metrics", () => {
  const metrics = parseMetrics("", "score")
  expect(Object.keys(metrics)).toHaveLength(0)
})
