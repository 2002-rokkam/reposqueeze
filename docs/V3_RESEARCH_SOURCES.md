# V3 research sources

Every source cited in [`V3_RESEARCH.md`](V3_RESEARCH.md), with verification status. **VERIFIED** means the URL/file
was actually opened (by this agent directly via `web_fetch`/`gh api`, or by one of five delegated research passes
under the same read-only, no-fabrication rules) and the cited claim was read in the source itself.
**UNVERIFIED-FULL-TEXT** means the work's existence, title, venue, and year are confirmed (usually via a bibliography
cross-reference in ≥1 independently-opened paper, or via an independent third-party source code implementation), but
the original full text could not be opened this round (paywall, timeout, rate limit) — the paraphrase used in the
main document is attributed to the corroborating secondary source instead. **UNVERIFIED** means neither the source nor
a corroborating reference could be opened; these items are flagged in the main document and no claim is built on them
alone. Nothing below was recalled from training without being re-opened — several sources are 2025/2026 publications
outside any model's training horizon.

## Local experiments (this agent, not a citation — included for audit)

| # | What was run | Status |
|---|---|---|
| L1 | `node -e` with `js-tiktoken` (`o200k_base`): token cost of random hex strings (N=200 samples, lengths 8/12/16/24/32/40/64), natural code-line baseline, 32-excerpt header overhead, 6 header-format variants, TOON-vs-JSON on a 32-row evidence array | VERIFIED — run directly against this repo's vendored `node_modules/js-tiktoken` and `node_modules/@toon-format/toon`, raw output captured in this session |
| L2 | `node --import tsx -e` importing `src/parser.ts`'s real `terms()` and testing 12 identifiers (`HTTPSConnectionPool`, `XMLParser`, `getUserID`, `sha256`, etc.) | VERIFIED — executed the shipped function directly, not inferred from reading the regex |
| L3 | `node --import tsx -e` importing `src/parser.ts`'s real `parseSource()` on this repo's own `src/context.ts`/`repository.ts`/`v2.ts`, comparing full-definition-body token cost vs. first-line-only and name-only skeletons | VERIFIED — executed the shipped parser directly against this repository's own source |
| L4 | Blank-line-only and `//`-comment-only stripping on `src/context.ts`, token-counted before/after | VERIFIED |

## Topic 1 — Aider repository map

| Source | Status | Note |
|---|---|---|
| [`Aider-AI/aider:aider/repomap.py`](https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py) | VERIFIED | Fetched in full (two paginated reads, ~624 lines); all quoted constants/formulas read directly from this file by this agent |
| [aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html) | VERIFIED | Fetched and read in full by this agent |

## Topic 2 — Code-search ranking

| Source | Status | Note |
|---|---|---|
| [`sourcegraph/zoekt:doc/design.md`](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md) | VERIFIED | |
| [`sourcegraph/zoekt:index/score.go`](https://raw.githubusercontent.com/sourcegraph/zoekt/main/index/score.go) | VERIFIED | Lines 205–266, 384, 416 read; BM25 `k,b:=1.2,0.75` and "skips idf" comment quoted directly |
| [`sourcegraph/zoekt:index/contentprovider.go`](https://raw.githubusercontent.com/sourcegraph/zoekt/main/index/contentprovider.go) | VERIFIED | Lines 623–641, 752–800; legacy scorer constants and symbol-kind multiplier table |
| [`sourcegraph/zoekt:index/file_category.go`](https://raw.githubusercontent.com/sourcegraph/zoekt/main/index/file_category.go) | VERIFIED | Lines 1–139; `lowPriorityFilePenalty=5`, go-enry category checks |
| [GitHub Blackbird engineering blog](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/) | VERIFIED | Three n-gram indices; scale napkin-math quote |
| [`BurntSushi/ripgrep:GUIDE.md`](https://raw.githubusercontent.com/BurntSushi/ripgrep/master/GUIDE.md) | VERIFIED | Lines 180–254; ignore precedence, binary detection, zero ranking confirmed |
| [`continuedev/continue:core/context/providers/SearchContextProvider.ts`](https://raw.githubusercontent.com/continuedev/continue/main/core/context/providers/SearchContextProvider.ts) | VERIFIED | |
| opencode `packages/core/src/ripgrep.ts` (+ `packages/web/src/content/docs/tools.mdx`) | VERIFIED | Fetched via raw.githubusercontent.com by the delegated pass |
| [Elasticsearch `word_delimiter_graph` docs](https://www.elastic.co/docs/reference/text-analysis/analysis-word-delimiter-graph-tokenfilter) | VERIFIED | Default flags (`split_on_case_change`, `split_on_numerics`, `preserve_original=false`) read directly |
| [Lucene `WordDelimiterGraphFilter` javadoc](https://lucene.apache.org/core/10_0_0/analysis/common/org/apache/lucene/analysis/miscellaneous/WordDelimiterGraphFilter.html) | VERIFIED | |

## Topic 3 — BM25 variants and SWE-bench retrieval numbers

| Source | Status | Note |
|---|---|---|
| Robertson & Zaragoza, *"The Probabilistic Relevance Framework: BM25 and Beyond"* (2009), [PDF](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf) | VERIFIED | Full text extracted (pypdf); eq. 3.15–3.21 and Table 3.1 field weights read directly |
| [`dorianbrown/rank_bm25:rank_bm25.py`](https://raw.githubusercontent.com/dorianbrown/rank_bm25/master/rank_bm25.py) | VERIFIED | `BM25Plus` class, defaults and formula read directly |
| Lv & Zhai, *"Lower-bounding term frequency normalization,"* CIKM 2011 | **UNVERIFIED-FULL-TEXT** | ACM DL → HTTP 403; UIUC author mirror → HTTP 504 timeout. BM25+ formula corroborated instead via `rank_bm25` (above), per the task's own stated fallback |
| [SWE-bench paper](https://arxiv.org/html/2310.06770v3), arXiv:2310.06770 | VERIFIED (qualitative) / **UNVERIFIED (exact Table 2/3 numeric cells)** | §4.3/§5 text and Table 3's title read directly; the actual number grids were dropped by the ar5iv HTML→text conversion in two sequential fetch attempts |
| [Agentless](https://arxiv.org/html/2407.01489v2), arXiv:2407.01489 | VERIFIED | §3.1, §5.1.2, Tables 1–2 read directly |
| [SweRank](https://arxiv.org/html/2505.07849v2), arXiv:2505.07849 | VERIFIED | §5.2, Table 1 read directly |
| [CoRNStack](https://arxiv.org/html/2412.01007v3), arXiv:2412.01007 | VERIFIED (qualitative) / **UNVERIFIED (Table 6 numeric cells)** | §4.3 text read directly; Table 6's cells were skipped by the HTML extractor in two sequential fetches |
| [LocAgent](https://arxiv.org/html/2503.09089v2), arXiv:2503.09089 | VERIFIED | Abstract, §2.2 read directly |

## Topic 4 — Query-side techniques

| Source | Status | Note |
|---|---|---|
| Abdul-Jaleel et al., *"UMass at TREC 2004: Novelty and HARD,"* [PDF](https://trec.nist.gov/pubs/trec13/papers/umass.novelty.hard.pdf) | VERIFIED | Full 13pp text extracted; RM3 formula and `UMassBaseRM3` run parameters read directly |
| Nie, Jiang, Ren, Sun, Li, *"Query Expansion Based on Crowd Knowledge for Code Search,"* arXiv:1703.01443 | VERIFIED | Full PDF text extracted |
| Rahman & Roy, *"Improving Bug Localization with Context-Aware Query Reformulation"* (BLIZZARD), arXiv:1808.00594 | VERIFIED | Full PDF text extracted |
| Samir & Rahman, *"Improving IR-based Bug Localization with Semantics-Driven Query Reduction"* (IQLoc), arXiv:2510.04468 | VERIFIED | Full 62pp PDF text extracted |
| Murali, Gross, Qian, Chandra, *"Industry-scale IR-based Bug Localization... from Facebook"* (Bug2Commit), arXiv:2010.09977 | VERIFIED | Full PDF text extracted |
| Yang et al., *"SWE-agent: Agent-Computer Interfaces..."*, arXiv:2405.15793 | VERIFIED | Full PDF text extracted |
| [Sentry Developer Docs, "Stack Trace Interface"](https://develop.sentry.dev/sdk/foundations/envelopes/event-payloads/stacktrace/) | VERIFIED | |
| `mou23/BugLocator` (third-party replication package) | VERIFIED | `LenScore.java`, `BugSimilarity.java`, CLI help text read directly to re-derive the rVSM/simiScore algorithm |
| `mou23/BLUiR` (third-party replication package) | VERIFIED | `FactExtractor.java`, `GenericVisitorFact.java` read directly |
| Rocchio, *"The SMART Retrieval System,"* 1971 | **UNVERIFIED-FULL-TEXT** | Book chapter, not digitized online; Stanford IR-book mirror failed via TLS reset (two attempts). Title/attribution confirmed via BLIZZARD's bibliography (ref [48]) only |
| Lavrenko & Croft, *"Relevance-Based Language Models,"* SIGIR 2001 | **UNVERIFIED-FULL-TEXT** | ACM DL paywalled. A PDF matching Lavrenko's PhD thesis was fetched from `ciir.cs.umass.edu/pubfiles/ir-178.pdf` but its text was corrupted by legacy Type3-font encoding and its title could not be visually confirmed — flagged as unverified-title-match despite a plausible URL |

## Topic 5 — Bug localization with version history

| Source | Status | Note |
|---|---|---|
| Zhou, Zhang, Lo, *"Where should the bugs be fixed?"* (BugLocator), ICSE 2012 | **UNVERIFIED-FULL-TEXT** (paper) / VERIFIED (algorithm) | Original paper paywalled; algorithm independently re-derived from `mou23/BugLocator` source (Topic 4 table) |
| Saha, Lease, Khurshid, Perry, *"Improving Bug Localization Using Structured IR"* (BLUiR), ASE 2013 | **UNVERIFIED-FULL-TEXT** (paper) / VERIFIED (algorithm) | Algorithm re-derived from `mou23/BLUiR` source |
| Wang & Lo, *"Version History, Similar Report, and Structure..."* / AmaLgam+, ICPC 2014 / JSEP 2016 | **UNVERIFIED-FULL-TEXT** | Title/venue/year/pages cross-confirmed identically in two independently-opened bibliographies (IQLoc ref [88], BLIZZARD ref [58]) |
| Wen, Wu, Cheung, *"Locus: Locating Bugs from Software Changes,"* ASE 2016 | **UNVERIFIED-FULL-TEXT** | Cross-confirmed via IQLoc ref [91] and BLIZZARD ref [59] |
| Sisman & Kak, *"Incorporating Version Histories in IR-Based Bug Localization,"* MSR 2012 | **UNVERIFIED-FULL-TEXT** | Title/venue via IQLoc ref [26] only |
| Rahman & Roy, *"STRICT,"* SANER 2017 | **UNVERIFIED-FULL-TEXT** | Cited within BLIZZARD (ref [42]) and IQLoc (ref [24]) bibliographies; not independently opened |
| Lee, Kim, Bissyandé, Jung, Le Traon, *"Bench4BL,"* ISSTA 2018 | **UNVERIFIED-FULL-TEXT** | Existence/citation confirmed via IQLoc's framing of it as its base dataset; specific findings not read |
| Chaparro & Marcus, ICSE-C 2016; Chaparro, Florez & Marcus, 2017; Moreno et al., ICSME 2014 | **UNVERIFIED-FULL-TEXT** | Bibliographic cross-reference only |

## Topic 6 — Rank fusion

| Source | Status | Note |
|---|---|---|
| Cormack, Clarke, Büttcher, *"Reciprocal Rank Fusion..."* SIGIR 2009, [PDF](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf) | VERIFIED | Full text extracted; `k=60` formula and pilot-sweep table read directly |
| Fox & Shaw, *"Combination of Multiple Searches,"* TREC-2 1994, [NIST archive](https://trec.nist.gov/pubs/trec2/papers/txt/23.txt) | VERIFIED | Full text; CombSUM/CombMNZ/CombANZ/CombMAX/CombMIN/CombMED formulas (Table 6) read directly |
| *"Optimal Fusion Weights Form Intervals, Not Points,"* arXiv:2610.24341 (+ code `thomsonreuters/query-based-rrf`) | VERIFIED | Abstract opened |
| Deployed hybrid-RAG pipeline weights paper, arXiv:2609.01617 | VERIFIED | Opened; `.50/.35/.15` weights and `k=60` quoted directly |
| MMMORRF, arXiv:2503.20698 | VERIFIED | Abstract opened |
| Rackauckas, *"RAG-Fusion,"* arXiv:2402.03367 | VERIFIED | Abstract opened |

## Topic 7 — Token-budget packing

| Source | Status | Note |
|---|---|---|
| Lin & Bilmes, *"A Class of Submodular Functions for Document Summarization,"* ACL 2011, [PDF](https://aclanthology.org/P11-1052.pdf) | VERIFIED | Full text opened, including Theorem 2 (MMR is submodular but non-monotone) |
| Carbonell & Goldstein, MMR, SIGIR 1998 (DOI `10.1145/290941.291025`) | **PARTIALLY VERIFIED** | Metadata (title/venue/pages/citation count) verified via Crossref; formula verified via a verbatim quote inside Lin & Bilmes (above); original ACM PDF itself is paywalled (403) and a CMU mirror 404'd — "typical λ ranges" the paper itself reports could not be confirmed |
| Nemhauser, Wolsey, Fisher, 1978 (greedy `(1-1/e)` guarantee) | **UNVERIFIED-FULL-TEXT** | Cited one hop removed, through Lin & Bilmes (verified primary source), not independently opened |
| Sviridenko, 2004 (knapsack-constrained submodular maximization) | **UNVERIFIED-FULL-TEXT** | Same as above |
| Classic 0/1-knapsack greedy 2-approximation (e.g. Kellerer/Pferschy/Pisinger, *Knapsack Problems*) | **UNVERIFIED** | Four university lecture-note URLs (CMU, Cornell, UIUC, UFL) all returned 404; reported as well-known textbook material, substituted with the stronger verified Lin & Bilmes citation chain |
| LongCodeZip, arXiv:2510.00446 (+ [`YerbaPage/LongCodeZip`](https://github.com/YerbaPage/LongCodeZip)) | VERIFIED | Abstract and GitHub README opened; "0/1 knapsack optimization" and "5.6× compression" quoted directly |
| LLMLingua, arXiv:2310.05736 (+ `microsoft/LLMLingua`) | VERIFIED | |
| LLMLingua-2, arXiv:2403.12968 | VERIFIED | |
| cAST, arXiv:2506.15655 (+ [`yilinjz/astchunk`](https://github.com/yilinjz/astchunk)) | VERIFIED | HTML full text and GitHub README opened; confirmed the repo is not literally named "cAST" |
| Anthropic, *"Contextual Retrieval"* research post | VERIFIED | Fetched directly; "49%/67%" figures quoted directly |

## Topic 8 — Agentic localization baselines and IDE retrieval stacks

| Source | Status | Note |
|---|---|---|
| Agentless, arXiv:2407.01489 (+ `OpenAutoCoder/Agentless`) | VERIFIED | |
| LocAgent, arXiv:2503.09089 (+ `gersteinlab/LocAgent`) | VERIFIED | ACL 2025 BibTeX and author match confirmed in repo README |
| RepoGraph, arXiv:2410.14684 (+ `ozyyshr/RepoGraph`) | VERIFIED | README confirms plug-in integration with Agentless/SWE-agent |
| CodeRAG, arXiv:2509.16112 (+ `KDEGroup/CodeRAG`) | VERIFIED | Pipeline script names (`build_query.py`→`retrieve.py`→`rerank.py`) confirmed in repo |
| SweRank, arXiv:2505.07849; SweRank+, arXiv:2512.20482 | VERIFIED | Both abstracts opened via arXiv API |
| CoRNStack, arXiv:2412.01007 | VERIFIED | Abstract opened via arXiv API |
| `aorwall/moatless-tools` README | VERIFIED | Opened twice; Voyage AI dependency and flow table quoted directly |
| SWE-Search, arXiv:2410.20285 (+ `aorwall/moatless-tree-search`) | VERIFIED | |
| RepoMaster, arXiv:2505.21577 (+ `QuantaAlpha/RepoMaster`) | VERIFIED | README badges confirm matching arXiv ID |
| [cursor.com/docs/agent/tools/search](https://cursor.com/docs/agent/tools/search) + `cursor.com/llms.txt` | VERIFIED | Confirms no stored embeddings/index in current docs |
| [sourcegraph.com/docs/cody/core-concepts/context](https://sourcegraph.com/docs/cody/core-concepts/context) | VERIFIED | Only the canonical overview page checked, not the full enterprise-config doc tree |
| [docs.github.com Copilot repository-indexing](https://docs.github.com/en/copilot/concepts/prompting-and-context/repository-indexing) | VERIFIED | |
| GitHub engineering blog, "Neighboring tabs" | VERIFIED | |
| `continuedev/continue:core/context/providers/CodebaseContextProvider.ts` | VERIFIED | Lines 1–28 |
| `continuedev/continue:core/context/retrieval/pipelines/RerankerRetrievalPipeline.ts` | VERIFIED | Lines 1–82 |
| `continuedev/continue:core/context/retrieval/pipelines/` directory listing | VERIFIED | |

## Topic 9 — Pack-the-repo tools

| Source | Status | Note |
|---|---|---|
| [`yamadashy/repomix`](https://github.com/yamadashy/repomix) README | VERIFIED | Fetched directly by this agent |
| [`yamadashy/repomix:src/core/file/fileProcessContent.ts`](https://raw.githubusercontent.com/yamadashy/repomix/main/src/core/file/fileProcessContent.ts) | VERIFIED | Fetched and read in full directly by this agent |
| [`yamadashy/repomix:src/core/treeSitter/parseFile.ts`](https://raw.githubusercontent.com/yamadashy/repomix/main/src/core/treeSitter/parseFile.ts) | VERIFIED | Fetched and read in full directly by this agent; `CHUNK_SEPARATOR='⋮----'` and the fail-closed-to-uncompressed design confirmed from source comments and code |
| `coderamp-labs/gitingest` (formerly `cyclotruc/gitingest`) README + `src/gitingest/config.py` | VERIFIED | Org move confirmed via `gh api` redirect |
| `mufeedvh/code2prompt` README + `Cargo.toml` | VERIFIED | `tiktoken-rs` crate usage confirmed |
| `simonw/files-to-prompt` README | VERIFIED | |
| `toon-format/toon` (+ `toon-format/spec`) README | VERIFIED | "When Not to Use TOON" criteria quoted directly |

## Topic 10 — Local semantic signals

| Source | Status | Note |
|---|---|---|
| `ollama.com/library/nomic-embed-text`, `/all-minilm/tags`, `/search?q=bge`, `/search?q=jina` | VERIFIED | |
| `huggingface.co/nomic-ai/nomic-embed-text-v1.5/.../config.json`, `BAAI/bge-m3/.../config.json`, `jinaai/jina-embeddings-v2-base-code/.../config.json`, `sentence-transformers/all-MiniLM-L6-v2` | VERIFIED | Dimensions confirmed from each model's own `config.json`, not marketing copy |
| `bge-large`'s exact embedding dimension | **UNVERIFIED** | Inferred by analogy to `bge-large-en-v1.5`'s fastembed table entry (1024-dim); not confirmed from `bge-large`'s own config |
| Nomic Embed technical report, arXiv:2402.01613 | VERIFIED | |
| `qdrant/fastembed` README + supported-models table | VERIFIED | |
| `huggingface/transformers.js` README + `Xenova/all-MiniLM-L6-v2` model card | VERIFIED | |
| Weinberger, Dasgupta, Attenberg, Langford, Smola, *"Feature Hashing..."*, arXiv:0902.2206 | VERIFIED | |
| Deerwester, Dumais, Furnas, Landauer, Harshman, 1990 (LSI), PDF at `wordvec.colorado.edu/papers/Deerwester_1990.pdf` | **PARTIALLY VERIFIED** | PDF resolves at an authoritative host whose landing page explicitly captions this link as the 1990 paper; binary content was not text-extracted this round |
| Sahlgren (Random Indexing survey); Kanerva, Kristoferson & Holst, 2000 | **UNVERIFIED** | Semantic Scholar Graph API rate-limited (HTTP 429) on 4 attempts; DBLP blocked by bot-protection; CrossRef returned a genuine but *different* Sahlgren paper (confirming his authorship in this space, not this specific source) |
| `sbert.net` "Retrieve & Re-Rank" docs | VERIFIED | |

## Topic 11 — Secret detection and prompt-injection hygiene

| Source | Status | Note |
|---|---|---|
| [`gitleaks/gitleaks:config/gitleaks.toml`](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) | VERIFIED | Full file fetched via `gh api` (3,209 lines) after `web_fetch`'s 20,000-char cap truncated it; 222 rules / 130 with `entropy=` counted directly |
| `gitleaks/gitleaks:README.md` | VERIFIED | Lines 136–168 |
| Gitleaks maintainer blog, "Regex is almost all you need" | VERIFIED | |
| `trufflesecurity/trufflehog:README.md` | VERIFIED | Lines 43–59; `"Verified":true` sample output confirmed |
| `Yelp/detect-secrets:detect_secrets/plugins/high_entropy_strings.py` | VERIFIED | Lines 1–160; `4.5`/`3.0` bits/char defaults and numeric-penalty formula read directly |
| `Yelp/detect-secrets:README.md` | VERIFIED | Lines 27–104 |
| [BFG Repo-Cleaner docs](https://rtyley.github.io/bfg-repo-cleaner/) | VERIFIED | `--delete-files` vs. `--replace-text` both quoted directly |
| [OWASP GenAI LLM01 page](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) | VERIFIED | |
| Greshake et al., *"Not what you've signed up for,"* arXiv:2302.12173 | VERIFIED | |

## Topic 12 — Log/CI-output compression

| Source | Status | Note |
|---|---|---|
| `logpai/Drain3:README.md` | VERIFIED | Lines 119–135; `sim_th=0.4, depth=4, max_children=100` read from documented prose ("(default X)"); a guessed literal `drain3.ini` path 404'd, so these are a textual, not binary-config, source |
| `logpai/logparser:logparser/Drain/README.md` (paper citation block) | VERIFIED | |
| ReBucket, MSR publication page | VERIFIED | Venue corrected during research: confirmed *"Published by ICSE 2012 SEIP"*, not an initially assumed ASE 2012 |
| Mozilla Socorro signature-generation docs | VERIFIED | |
| pytest docs, "Managing pytest's output" | VERIFIED | |
| `golang/go:src/cmd/go/internal/test/test.go` doc comment | VERIFIED | |
| Rust Book, ch. 11.2 | VERIFIED | |
| Jest CLI docs | **PARTIALLY VERIFIED** | Structured pass/fail/total counts confirmed via the `--collectTests` section; the literal default-run footer wording was not found quoted verbatim within this round's fetch budget |
| `tqdm/tqdm:README.rst` | VERIFIED | `\r`-only redraw contract quoted directly |

## Topic 13 — Evaluation methodology

| Source | Status | Note |
|---|---|---|
| SWE-bench paper, arXiv:2310.06770, §4.1 | VERIFIED | (Same source as Topic 3; re-cited here for its retrieval-metric framing, §4.1) |
| `swebench.com`, `/lite.html`, `/multilingual.html` | VERIFIED | Multilingual variant's existence specifically confirmed live as of 2026, not assumed |
| OpenAI, "Introducing SWE-bench Verified" | VERIFIED | |
| Agent Retrieval Bench, arXiv:2607.24882 | VERIFIED | Re-opened independently this round; abstract matches RepoSqueeze's own prior citation |
| ContextBench, arXiv:2602.05892 | VERIFIED | Re-opened independently; matches (minor wording paraphrase noted in main doc) |
| CORE-Bench, arXiv:2606.11864 | VERIFIED | Re-opened independently; matches (minor wording paraphrase noted) |
| Rivet, arXiv:2610.34967 | VERIFIED | Re-opened independently; matches |
| McNemar's test | VERIFIED | Standard ~80-year-old statistical description (Wikipedia-sourced, per the task's own explicit allowance for this specific, non-code citation) |
| Berg-Kirkpatrick, Burkett & Klein, ACL Anthology D12-1091 | VERIFIED | |
| Dror, Baumer, Shlomov & Reichart, ACL Anthology P18-1128 | VERIFIED | |
| Bonferroni correction | VERIFIED | Standard reference description |
| Sakai, "Topic Set Size Design" | **NOT ATTEMPTED** | Deliberately not guessed (no ID was recalled with confidence); the task's own pre-approved alternatives (Bonferroni, Dror et al. 2018) were used instead, per the hard rule against inventing sources |

## Summary

Of roughly 95 distinct sources cited above, the large majority are **VERIFIED** by direct fetch. The **UNVERIFIED** or
**UNVERIFIED-FULL-TEXT** items cluster almost entirely in two predictable places: (1) pre-2015 ACM/IEEE-paywalled
software-engineering papers (BugLocator, BLUiR, Locus, AmaLgam, STRICT, Bench4BL, Sisman & Kak, Lv & Zhai, Lavrenko &
Croft, Rocchio, Nemhauser et al. 1978, Sviridenko 2004, Carbonell & Goldstein's own PDF) — for the two most
algorithmically load-bearing of these (BugLocator, BLUiR), the actual algorithm was still independently confirmed via
third-party open-source replication-package source code, not left as a bare citation; and (2) a handful of HTML-table
extraction failures on arXiv (SWE-bench Table 3, CoRNStack Table 6) where the abstract/prose claims were confirmed but
specific number grids were not. No claim in `V3_RESEARCH.md` is built solely on an unverified source without saying so.
