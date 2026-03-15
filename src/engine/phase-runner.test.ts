import { test, expect } from "bun:test"
import { parseHypotheses } from "./phase-runner.ts"

test("parseHypotheses: parses standard format", () => {
  const output = `EXPERIMENT 1:
Hypothesis: Increase learning rate to 0.06
File: train.py
Content: LR = 0.06
Rationale: Higher LR may converge faster

EXPERIMENT 2:
Hypothesis: Use GeLU activation
File: model.py
Content: activation = "gelu"
Rationale: GeLU often outperforms ReLU`

  const hypotheses = parseHypotheses(output)
  expect(hypotheses).toHaveLength(2)
  expect(hypotheses[0]!.description).toBe("Increase learning rate to 0.06")
  expect(hypotheses[0]!.changes).toHaveLength(1)
  expect(hypotheses[0]!.changes[0]!.path).toBe("train.py")
  expect(hypotheses[0]!.changes[0]!.content).toBe("LR = 0.06")
  expect(hypotheses[1]!.description).toBe("Use GeLU activation")
})

test("parseHypotheses: handles missing file/content", () => {
  const output = `EXPERIMENT 1:
Hypothesis: Try a deeper model
Rationale: More depth might help`

  const hypotheses = parseHypotheses(output)
  expect(hypotheses).toHaveLength(1)
  expect(hypotheses[0]!.description).toBe("Try a deeper model")
  expect(hypotheses[0]!.changes).toHaveLength(0)
})

test("parseHypotheses: handles empty output", () => {
  expect(parseHypotheses("")).toHaveLength(0)
  expect(parseHypotheses("No experiments here")).toHaveLength(0)
})

test("parseHypotheses: handles multiline content", () => {
  const output = `EXPERIMENT 1:
Hypothesis: New config
File: config.yaml
Content: key1: value1
key2: value2
key3: value3
Rationale: Better config`

  const hypotheses = parseHypotheses(output)
  expect(hypotheses).toHaveLength(1)
  expect(hypotheses[0]!.changes[0]!.content).toContain("key1: value1")
  expect(hypotheses[0]!.changes[0]!.content).toContain("key2: value2")
})
