# RepoSqueeze architecture (2.2)

```mermaid
flowchart TB
  subgraph Index
    A[Repository files] --> B[Enumerate: git ls-files or bounded walk]
    B --> C[Filters: ignore rules, binary, size, symlinks, secret paths]
    C --> D[Read + redact secret values in place]
    D --> E[Chunk: tree-sitter (20 languages) or structural chunkers]
    E --> F[(Cache outside the repo:<br/>per-file entries, term rows, dictionary)]
    F --> G[Inverted index over chunks]
  end
  subgraph Query
    Q[Task, error, trace] --> Q1[Condense if > 8,000 chars]
    Q1 --> Q2[Up to 6 deterministic views]
    Q2 --> R[BM25 per view]
    G --> R
    R --> S[Fusion + feedback + identifier/phrase + priors<br/>(+ optional frames, git)]
    S --> T[Packing under the token budget]
  end
  T --> U[Excerpts, pointers, receipts]
```

## Index

* **Enumeration.** Git (`ls-files --cached --others --exclude-standard`) when available, otherwise a bounded directory walk honouring nested `.gitignore` and `.reposqueeze-v2ignore`. Limits: 100,000 files, 2 GiB, 2 MiB per file, depth 60.
* **Text pipeline.** One hook (`Repository.textFromBytes`) turns bytes into the text that is chunked, indexed, hashed and shown. It rejects binaries and replaces secret values with `[REDACTED:<rule>]` without changing the number of lines, so citations stay valid. Changing its output requires bumping `TEXT_PIPELINE_VERSION`.
* **Chunking.** `parser.ts` uses web-tree-sitter for 20 languages. Definitions include leading doc comments and decorators and carry `signature`, `scope` and `doc`. Long definitions are split into overlapping pieces; every file also gets 64-line windows so nothing is unsearchable. Generated or minified files get bounded chunking. `chunkers.ts` supplies structural spans (headings, keys, elements, rules, statements, stages, targets) for Markdown, JSON, YAML, TOML, XML (including Maven and AEM `.content.xml`), HTML, CSS, SQL, Dockerfile, Makefile, shell, protobuf and HCL.
* **Persistence.** `store.ts` keeps the cache outside the repository (`REPOSQUEEZE_CACHE_DIR`, XDG or platform cache directory, keyed by the repository's real path). Files are checksummed containers written atomically with private permissions; every loaded field is validated, and any cache failure degrades to in-memory operation. Entries are keyed by path, content hash, parser, tokenizer and text-pipeline versions. For repositories up to 5,000 files the content hash is re-verified on every run; above that, size and modification time are trusted (`REPOSQUEEZE_REFRESH_INDEX=1` overrides).
* **Large repositories.** Above 5,000 eligible files a per-file term sketch selects 600–1,800 candidate files that are then parsed; the rest of the pipeline is unchanged.
* **Search index.** `search-index.ts` holds per-chunk term rows and postings in typed arrays. `retrieve()` computes BM25 (k1 = 1.2, b = 0.75) plus bonuses for terms in the symbol name and path, and accepts weighted terms.

## Ranking (`v2.ts`)

1. **Views.** The query is tokenized (`tokenize.ts`: camelCase and acronym splitting, snake_case, joined identifiers, Porter stemming, hash blobs dropped). Up to six deterministic views are built: the original, diagnostic lines, identifier-like words and three leave-one-bucket-out views.
2. **Fusion.** Reciprocal-rank fusion over chunk and file ranks (perturbation-consensus retrieval). Stability, the share of views in which a chunk stays near the top, is a diagnostic, not a confidence.
3. **Signals (default on).** Pseudo-relevance feedback terms from the first-pass top chunks; definitions whose names are literally mentioned; adjacent query-word pairs; priors that down-weight tests, docs and vendored or generated paths unless the query asks for them; trace mode that prefers implementation files over the tests named in a failure.
4. **Signals (opt-in).** `frames`: files named by application frames of a parsed stack trace (`trace.ts`). `git`: files with uncommitted work, recent commits and co-change partners (`gitsignals.ts`).
5. **Obligations.** Rare query terms are listed and reported when no returned excerpt contains them.

## Packing (`pack.ts`)

Greedy selection by marginal value: a candidate's score is scaled by the share of its matched terms (IDF-weighted) not yet on the page and by a per-file crowding factor. Rendering order for a candidate: whole chunk if it fits and is moderate, otherwise the highest-scoring contiguous window (48 → 6 lines) with the enclosing declaration kept as a separate range and an explicit `…[a-b omitted]` marker. Parts of a chunk that overlap already shown lines are never re-printed. Identical chunk texts in several files are printed once and the copies named. About 12% of the budget (at most 400 tokens) is held back for "Also relevant (not shown)" pointers, and unused reservation returns to excerpts. The final text is checked against the budget with the same tokenizer that reports `outputTokens`.

Receipts are 8-hex digests of the displayed range; complete excerpts reuse their chunk id so a client can pass `known` ids to avoid re-sending text it still holds.

## Other components

* `repomap.ts`: file-level PageRank over the definition/reference graph, personalised by optional focus terms, rendered as signatures with directory-prefix compression and fitted to the budget; `skeleton.ts` renders a range as signatures plus query lines; `symbols.ts` provides name search and per-file outlines.
* `compact.ts` + `logs/`: log compaction with volatile-token normalisation, template mining, stack-trace folding, test-runner awareness and explicit omission markers. `structured.ts`: verified lossless JSON/TOON choice.
* `semantic.ts`: optional Ollama embeddings of the 300 strongest lexical candidates, cached outside the repository.
* `mcp.ts`, `cli.ts`, `extension.ts`: three thin front ends over the same `Engine`.

## Invariants (tested)

Output never exceeds the budget; excerpts are exact source lines of the indexed (redacted) text; identical inputs give identical bytes cold, warm and after restart; no file inside the repository is written; paths outside the root, symlinks and secret paths are refused; every elision or redaction is marked.

Rationale and the techniques that were considered or rejected, with sources: [V3_RESEARCH.md](V3_RESEARCH.md). Older 2.1 design notes: [V2_RESEARCH.md](V2_RESEARCH.md).
