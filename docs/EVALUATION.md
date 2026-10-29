# Evaluation: observed results and limits

Recorded 28 October 2026. The raw results, scripts, source pins and failed retrievals are committed. No claim below establishes universal answer correctness or future credit savings.

## Repository-disjoint 80:20 evaluation

There is **no model training**. Eight repositories (40 questions) were used for development and two repositories (10 questions) for held-out evaluation. Tasks were manually authored source-location questions, with required file/needle evidence. They include natural-language descriptions and explicit identifiers. The same author built the system and wrote the questions, so this is not a blinded independent benchmark. Repository-level separation avoids mixing adjacent chunks from the same project across development and test, but does not remove author bias or public-code training contamination in the embedding model.

Development: p-limit, p-queue, Click, itsdangerous, Commander, chi, BurntSushi/toml and Rust log. Held out: Requests and Express. Versions and exact source commits are in [repos.json](../benchmarks/repos.json) and [lock.json](../benchmarks/lock.json). No upstream repository code was executed.

The source/task/dependency fingerprint was frozen before the held-out run: `d5609f9270bc9e485a10e0372bdc31401d3d49c822ef74425e1c39bb8cc0ab27`. Retrieval code was not retuned after inspecting held-out results. Packaging, documentation and subsequent integration experiments do not change the frozen retrieval fingerprint.

### Complete expected evidence

| Method | Development, 1500 tokens | Development, 3000 tokens | Held out, 1500 tokens | Held out, 3000 tokens |
| --- | ---: | ---: | ---: | ---: |
| BM25 ablation | 26/40 | 31/40 | 6/10 | 6/10 |
| Structural | 34/40 | 36/40 | 8/10 | 8/10 |
| Structural without reference hints | 34/40 | 36/40 | 8/10 | 8/10 |
| Structural + all-minilm embeddings | 33/40 | 36/40 | 8/10 | 9/10 |

The structural 3000-token mean evidence recall was 85% on held-out tasks, because one miss still contained partial required evidence. Hybrid mean recall was 90%. Complete-evidence success is stricter than partial recall, but neither metric grades a generated answer or successful code modification.

Only ten held-out questions are available. Approximate 95% Wilson intervals are 49–94% for 8/10 and 60–98% for 9/10; questions within the same repository are correlated, so even those intervals may overstate precision. The graph-hint ablation shows no demonstrated complete-evidence benefit. The semantic option helped at 3000 tokens here, but hurt development accuracy at 1500. It is optional, not presumed superior on every workload.

### Failures retained

- Structural retrieval did not fully cover Requests' redirect authorization removal and Express' JSON escaping/content-type question.
- Hybrid retrieval at 3000 tokens missed Express' default environment behavior.
- The expected recovery is a targeted expansion or ordinary source read. Recovery calls were not included in this offline benchmark, so no end-to-end efficiency claim follows.

### Size and latency

Held-out structural packs totalled **29,777 tokens**, versus **4,552,610** when repeatedly counting each entire indexed repository per question: 99.35% less text. Hybrid packs totalled 29,669. Development structural packs totalled 118,724 versus 3,776,900 (96.86% less).

That full-repository baseline is intentionally broad. A competent agent often reads only a few files. It is not a baseline for Copilot's actual prompt, bill or agent strategy. It also excludes ignored and filtered files. Raw `inputTokens` and `outputTokens` in these offline JSON reports mean full-index text and packed text—not model input/output usage.

Every tested serialized excerpt matched its current source range and every pack stayed within its stated `o200k_base` budget across **400 query/variant/budget combinations**. This is a tested invariant, not a theorem about all inputs. Offline `meanQueryMs` measures packing/scoring after indexing and embedding work, so it must not be presented as total request latency. The user-facing engine's elapsed time includes snapshot and semantic work.

Raw files: [development](../benchmarks/development.json), [held out](../benchmarks/test.json), [freeze](../benchmarks/frozen.json), [questions](../benchmarks/tasks.json), [runner](../scripts/benchmark.ts).

## Data representation and logs

[Format results](../benchmarks/formats.json) cover six fresh synthetic JSON shapes, each as minified and pretty-printed JSON. All 12 cases decoded to deeply equal semantic values and none grew in token count. The unit suite separately covers 100 seeded generated values, Unicode, literal special-token spellings, invalid numeric precision and duplicate keys.

| Example | Original tokens | Chosen tokens | Choice |
| --- | ---: | ---: | --- |
| 100 uniform records, already minified | 1902 | 1118 | TOON (41.2% smaller) |
| Same records, pretty printed | 3402 | 1118 | TOON (67.1% smaller) |
| Nested configuration, minified | 43 | 43 | Original JSON |
| Nested configuration, pretty printed | 89 | 43 | Minified JSON |
| Unicode records, minified | 642 | 455 | TOON (29.1% smaller) |

Those savings include the TOON format header. Six shapes are not a representative production distribution. Semantic round-trip equality does not imply identical model comprehension; no LLM comprehension comparison of TOON versus JSON was run. Lossless conversion rejects inputs that cannot safely retain numeric values.

Three synthetic logs cover repeated lines, mixed test results and short output. Repetition folding reduced 608 tokens to 22 with a repeat count. The 4250-token mixed log became 239 tokens and was explicitly marked lossy. Short output remained four tokens. Log selection can omit useful diagnostics, so retain raw logs and expand as needed.

## Integration and correctness checks

- 28 automated tests passed locally: all 11 language grammars, fallback windows, source fidelity, exact-range receipts, budget enforcement, changed/deleted files, explicit retained-context behavior, traversal/ignore/symlink checks, JSON round trips, log behavior, semantic cache invalidation and actual built MCP protocol calls.
- A real VS Code 1.143.1 extension-host run passed activation, native tool discovery, context invocation and expansion invocation. It does not prove Copilot will always choose the tools or achieve a task.
- The built npm tarball installed into a separate temporary prefix, and its installed CLI produced a valid 512-token-budget context pack outside the source package. The VSIX was built successfully. CI is configured for Node 22 on Linux, Windows and macOS, plus a Linux editor-host run. A configured job is not a passing result; inspect the repository's Actions status for the latest execution.
- Local checks initially used Node 26.8.2 on macOS. npm audit reported no known dependency vulnerabilities at the time of checking; that is not a security audit.

## Live Copilot comparison

The separate experiment uses four fresh, randomly mutated constants in Requests/Express source. Each has four arms: whole relevant file or a 3000-token structural pack, each with ordinary or concise answer instructions. Mutations prevent simply reciting a memorized upstream value. The baseline is an oracle-selected relevant file, stronger than full-repository dumping. Fixtures contain that relevant file; this does not test locating it among a full repository's distractors.

Each call starts a fresh Copilot session with model tools disabled. Arm order rotates between tasks. Auto efficiency routing is used because the tested account rejected explicit model identifiers; actual models and cache usage are recorded per call. Provider caching, hidden prompts and reasoning are not under experimental control. There is one repetition per arm per question; this is a smoke-scale comparison, not a statistically strong performance estimate.

Correctness requires the response to contain every requested fresh string. This checks the requested facts, not every sentence, citation or possible hallucination. Provider-reported output includes any counted reasoning tokens. Input totals must include ordinary input, cache reads and cache writes; cache-aware charges need separate treatment. Raw `totalNanoAiu` is retained without assuming an undocumented conversion into displayed credits or dollars.

The measured table is generated in [LIVE_RESULTS.md](LIVE_RESULTS.md) from [raw answers and usage](../benchmarks/live/results.json). The [runner](../scripts/live-eval.ts) is reproducible but intentionally generates new constants on each run. Inspect the failures as well as aggregate savings.
