# @hasna/researcher

Universal autonomous experimentation framework — PFLK/GREE cycles, knowledge graphs, entity extraction, sqlite-vec search, multi-provider LLM routing, SQLite knowledge base, sandbox isolation

[![npm](https://img.shields.io/npm/v/@hasna/researcher)](https://www.npmjs.com/package/@hasna/researcher)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/researcher
```

## CLI Usage

```bash
researcher --help
```

- `researcher init`
- `researcher project new`
- `researcher project list`
- `researcher run`
- `researcher workspace list`
- `researcher health`

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service researcher
cloud sync pull --service researcher
```

## Data Directory

Data is stored in `~/.hasna/researcher/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
