# Changelog

## 2.2.0

Evidence for every item is in the README, section "Evidence".

### Added
- Compact pack format, query-dense windows with the declaration kept, one-line pointers, identical-chunk collapse.
- Persistent cache outside the repository, compact inverted index, parallel indexing.
- 9 more tree-sitter grammars (20 total), leading doc comments and decorators, `signature`/`scope`/`doc` fields, generated-file detection.
- Structural chunkers for Markdown, JSON, YAML, TOML, XML, HTML, CSS, SQL, Dockerfile, Makefile, shell, protobuf, HCL.
- Secret redaction in place (`src/redact.ts`); long-query condensing and a stack-trace parser (`src/trace.ts`); Git history signals (`src/gitsignals.ts`, opt-in).
- PageRank repository map, file outlines and definition search (`map --path`, `map --query`).
- Upgraded log compaction (`src/logs/`).
- `RSQ_FEATURES`/`--features` switches, `--query -` (stdin), `--version`, `reposqueeze_v2_map` tool in VS Code.
- Benchmarks: SWE-bench harness (`bench/`), development suite, overhead measurement, research survey (`docs/V3_RESEARCH.md`).

### Changed
- MCP exposes three tools by default (`--tools all` restores compact and json).
- Tokenizer v2 (`RSQ_TOKENIZER=v1` restores the 2.1 tokenizer); input-token statistic is an estimate (`inputTokensEstimated`).
- Files containing secret-like values are indexed with the values redacted instead of being dropped (`RSQ_FEATURES=-redact` restores dropping).
- The cache moved from `.reposqueeze-v2/` in the repository to the platform cache directory (`REPOSQUEEZE_CACHE_DIR=repo` restores it).

### Fixed
- Python files no longer produce a whole-file chunk named after their first line.
- Token counting no longer hangs on very long unbroken lines.
- Ranking is computed once per query instead of twice; the whole repository is no longer tokenized per query.
