# Code Optimization Research

## Goal
Optimize the experiment file to achieve the best possible score on the evaluation metric.

## Rules
- Only modify the experiment file (e.g., `experiment.py`)
- Do NOT modify the evaluation harness (`evaluate.sh`)
- Each experiment runs for a fixed time budget
- The metric is extracted from the evaluation output

## Experiment Loop
1. Propose a change to the experiment file
2. Run the evaluation: `./evaluate.sh`
3. Parse the metric from output
4. If improved: keep. If not: discard.
5. Repeat.

## What You Can Change
- Algorithm parameters, hyperparameters
- Data structures, algorithms
- Optimization techniques
- Architecture changes
- Everything in the experiment file is fair game
