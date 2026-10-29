# Third-party notices

RepoSqueeze's own source is MIT licensed. Its bundled distribution contains independent open-source components with their own licenses.

- `web-tree-sitter` supplies the runtime. `tree-sitter-wasms@0.1.13` supplies precompiled language parsers. The latter package is Unlicense; the underlying grammars retain their upstream licenses.
- The grammar license texts in `third_party/` were fetched from the upstream npm versions declared as minimum ranges in `tree-sitter-wasms@0.1.13`. That package does not expose a per-binary source commit manifest. We do not claim a reproducible grammar build from those exact versions.
- Builds copy these notices to `assets/licenses/` and generate `BUNDLED-DEPENDENCIES.txt` from the actual JavaScript bundler input graph, preserving dependency license texts.
- The TOON codec, tokenizer, MCP SDK and other bundled dependencies are attributed in that generated file. Research projects discussed in `docs/RESEARCH.md` are references; their implementations are not copied into RepoSqueeze.
- Evaluation uses pinned public repositories fetched separately. Their code is not included in the npm package. Benchmark answers and source-location metadata are included for auditability.

Regenerate grammar notices with `python3 scripts/fetch-licenses.py` (network access). Ordinary builds use the checked-in notices and need no license download.
