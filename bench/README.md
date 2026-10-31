# SWE retrieval benchmark (`bench/`)

Measures how well a RepoSqueeze variant **localizes the code that must change for real GitHub issues**,
across many open-source repositories and languages, using the SWE-bench family:

| dataset | HF id | instances | repos | languages |
| --- | --- | --- | --- | --- |
| `lite` | `SWE-bench/SWE-bench_Lite` (`test` 300 + `dev` 23) | 323 | 18 | Python |
| `multilingual` | `SWE-bench/SWE-bench_Multilingual` (`test` 300) | 300 | 41 | C, C++, Go, Java, JavaScript, TypeScript, PHP, Ruby, Rust |
| `verified` | `SWE-bench/SWE-bench_Verified` (`test` 500) | 500 | 12 | Python |

The **query** is the instance's `problem_statement` (the raw issue text). The **gold** is the set of
non-test files modified by the gold `patch` (plus the pre-image line ranges the patch edits). The real
`Engine` runs on the real repository checked out at the instance's `base_commit`.

Everything is TypeScript ESM run with `node --import tsx`; there are no new dependencies.

## Quick start

```bash
# 1. fetch + cache the datasets (HuggingFace datasets-server, no auth), print sizes and hashes
npm run bench:v3:data

# 2. what would run? (no clone, no execution)
npm run bench:v3:swe -- --dry-run --dataset lite,multilingual --split dev \
  --variant baseline --variant ripgrep-naive

# 3. a small, reproducible, repository-stratified sample of DEV instances (30), two variants
npm run bench:v3:swe -- --dataset lite,multilingual --split dev --sample 30 \
  --variant baseline=/Users/me/reposqueeze-lab/baseline:@truncate=8000 \
  --variant ripgrep-naive \
  --budget 4000 --workers 2 --out ~/reposqueeze-lab/results/bench-swe/my-run

# 4. interrupted? run the identical command again: finished rows are skipped.
# 5. regenerate the report from rows.jsonl without running anything
npm run bench:v3:report -- --out ~/reposqueeze-lab/results/bench-swe/my-run
```

Run any variant on any split by changing `--variant` and `--split`:

```bash
node --import tsx bench/run.ts \
  --dataset lite,multilingual,verified --split dev \
  --variant baseline=$HOME/reposqueeze-lab/baseline:@truncate=8000 \
  --variant current=$HOME/Desktop/reposqueeze:RSQ_FEATURES=-git,REPOSQUEEZE_CACHE_DIR=$HOME/reposqueeze-lab/tmp/cache-current \
  --budget 4000 --workers 2 --timeout 120 --out $HOME/reposqueeze-lab/results/bench-swe/dev-full
```

The held-out split is refused unless `--i-am-the-orchestrator-final-run` is passed (see
[Dev/test discipline](#devtest-discipline)).

## Protocol

### Instances and splits

* Instances of the selected datasets are merged by `instance_id` (an instance that is in both Lite and
  Verified is evaluated once and tagged with both datasets).
* **Split rule (shared by every lane):** an instance is in the DEV split iff the first byte of
  `SHA-256("rsq-v3:" + instance_id)` is even; otherwise it is in the held-out TEST split. The rule, not the
  file, is the definition. `bench/splits.json` lists the resulting ids per dataset
  (`npm run bench:v3:splits` writes it, `-- --check` verifies it against the rule and the cached data).
  Note that "TEST" is *our* held-out split, unrelated to the HuggingFace split called `test`.
* Gold extraction (`bench/lib/gitdiff.ts`, `gold.ts`) parses the unified diff of `patch`:
  * files that exist in the base commit and whose **content** changes are gold; the pre-image path is used
    (renames keep the old path; deletions cover every removed line);
  * new files, binary files, mode-only changes, pure renames and **test files** (`tests/`, `test/`,
    `__tests__/`, `testing/`, `test_*`, `*_test.*`, `*.test.*`, `*.spec.*`, `conftest.py`, `*Test.java`,
    `*Tests.cs`, ...; see `testfiles.ts`) are not gold;
  * an instance with no gold file is skipped and counted with its reason (`only_new_files`,
    `only_test_files`, `no_content_change`, `empty_patch`, ...). Instances whose repository or base commit
    cannot be obtained are reported as *unavailable* and excluded for every variant.
* **Gold lines** are pre-image line numbers the patch edits: every removed (`-`) line, and for a pure
  insertion the context lines directly before and after the insertion point. Hunk context is *not* counted.

### Execution

* The corpus lives in `~/reposqueeze-lab/corpus/swe/<owner>__<repo>` (full clones by default; see
  `--clone-mode`). Each worker gets a **private checkout** in `corpus/swe/_checkouts/`: a separate `.git`
  that borrows objects from the corpus clone through `objects/info/alternates`. Unlike `git worktree` it
  shares **no refs**, so a retriever running `git log --all`, `git for-each-ref` or `git describe` cannot
  see the fix commit or any commit newer than the base commit. All git commands use a hermetic config
  (no hooks, no LFS filters, no credential helpers, no prompts, no auto-gc) and nothing from a benchmark
  repository is ever executed or installed.
* Instances are ordered by repository and base-commit date, so a worker's checkout changes little between
  consecutive instances. Before every run the checkout is reset to a pristine state (`git reset --hard`,
  `git clean -ffdx`), so no variant sees files another variant wrote.
* Every `(instance, variant)` pair runs in a **fresh child process** (`bench/lib/worker.ts`) that imports
  `<variantRoot>/src/engine.ts`, calls `new Engine(checkout).context(query, budget)` and sends the pack back
  over IPC. Variants never share module state; peak RSS is attributable to one query; a hard timeout kills the
  whole process group (so helper processes such as `rg` die too). Variants of one instance run sequentially in
  an order derived from a hash of the instance id, which removes systematic file-cache advantages.
* A timeout or an engine error is recorded as a **failure** (zero for every retrieval metric) and counted
  separately; it is never silently dropped. Infrastructure failures (checkout/network) are *not* failures of a
  variant: they are marked `infra`, excluded for all variants and retried on resume.
* The harness counts the pack's tokens itself with `o200k_base` (`js-tiktoken`) and flags any pack above the
  budget (`budgetViolation`).

### Variant syntax

```
--variant name=/path/to/repo[:ENV=VALUE[,ENV=VALUE...]][:@truncate=N]
```

`/path/to/repo` must contain `src/engine.ts` exporting `Engine`. Options after the path are separated by `:`
or `,`; a separator only splits when `KEY=` or `@name=` follows, so values containing `:` or `,` survive
(or use `--variant-env name:KEY=VALUE`). `@truncate=N` cuts the query to its first `N` UTF-16 code units
before the call: upstream 2.1.0 rejects queries over 8000 characters, so the baseline needs
`@truncate=8000`; newer variants should handle long text themselves. Bare names: `ripgrep-naive`
(bundled reference), `baseline` (`~/reposqueeze-lab/baseline`, truncation 8000), `current`
(`~/Desktop/reposqueeze`).

Reports record, per variant: git SHA, dirty flag, branch, `package.json`/`variant.json` version, environment,
truncation, and a **source fingerprint** (hash of `src/**`, `package.json` and the `assets/` listing). A resumed
run refuses to continue if any of that changed (`--force-resume` overrides, knowingly).

### `ripgrep-naive`

`bench/variants/ripgrep-naive/src/engine.ts` is a deliberately simple reference: "what an agent gets from
plain grep". It extracts identifiers (case-sensitive) and words (case-insensitive) from the issue, lets
`rg` find the files containing any of them, ranks files by the IDF-weighted number of distinct terms they
contain, and fills the token budget with grep-style line windows (like `rg -C 6`, best file first, round-robin
over files). No syntax awareness, symbol boosting or query views.

### Metrics

Per instance, then averaged. A failed run counts as 0.

| metric | definition |
| --- | --- |
| `packFileHit` | 1 if any gold file has at least one excerpt in `pack.evidence` |
| `packFileRecall` | fraction of gold files with at least one excerpt |
| `goldLineRecall` | fraction of gold lines (pre-image edit sites) inside excerpts |
| `packLineHit` | 1 if at least one gold line is inside an excerpt |
| `MRR` | 1 / rank of the first gold file, where files are ranked by **first appearance in `pack.evidence`** (distinct files, selection order); 0 if none is packed |
| `Hit@1/3/5/10` | 1 if a gold file is among the first k distinct files in that order |
| `outputTokens` | o200k_base tokens of `pack.text`, counted by the harness |
| `ms`, `cpuMs` | wall and CPU time of `engine.context()` in the child (start-up and import excluded) |
| `rssMB` | peak RSS of the child process (includes ~100 to 150 MB of Node + tsx baseline, `rssBaseMB`) |

Reports also contain the **bias indicator**: the fraction of instances whose issue text literally names a
gold file (`path`: a two-segment path suffix such as `models/query.py`; `basename`: the file name with
extension as a whole token; `stem`: the bare stem, a weaker signal; generic names such as `__init__.py` do not
count). Metrics are split by that flag, and by dataset, language and repository.

### Statistics

* 95% **percentile-bootstrap** CIs of the mean over instances, **10,000 resamples**, fixed seed (`--seed`,
  default 1729; the CLI refuses fewer than 10,000 resamples). All metrics share the same resampled indices.
* **Paired** comparisons (every pair of variants, on the instances both completed): paired bootstrap of the
  difference `B - A`, and the **exact McNemar test** (two-sided binomial on discordant pairs) for the binary
  outcomes (`packFileHit`, `packLineHit`, `Hit@k`). No multiple-comparison correction is applied.
* Instances are treated as independent draws. They are clustered by repository (Django alone is 39% of the
  167 Python instances of the Lite + Multilingual DEV split), so intervals are optimistic about
  repository-level variation.

### Outputs (`--out DIR`)

| file | content |
| --- | --- |
| `manifest.json` | command, node/OS/machine, harness SHA, split, seed, resamples, budget, timeout, clone mode, dataset hashes/revisions, filters, instance list hash, skipped/unavailable, variant identities |
| `instances.json` | selected instances (id, repo, language, datasets, base commit) |
| `rows.jsonl` | one row per (instance, variant), appended as runs finish; this is the resume log |
| `report.json` | manifest, summaries, paired comparisons, group tables and **all rows** (gold files and ranges, packed files in order, evidence, all metrics, tokens, ms, cpuMs, load1, rssMB, status/error) |
| `report.md`, `report-compact.md` | tables |
| `packs/<variant>/<id>.txt.gz` | the pack text of every successful run (`--no-save-packs` to skip) |

Resuming: re-run the same command. Rows with status `ok`, `timeout` or `error` are skipped (use
`--retry-failed` to re-run timeouts and errors); `infra` rows are always retried.

## Machine etiquette (shared machine)

The benchmark is meant to coexist with other work: `--workers` defaults to 2 (keep it at 3 or below), each
worker runs one engine process at a time, and `--max-load N` (default 40) makes the runner sleep before every
clone, checkout and engine run while the machine's one-minute load average is above `N` (`0` disables). The
load at the start of every run is stored in the row (`load1`) and shown in the report: **wall-clock
latencies are only comparable between runs made at similar load; `cpuMs` is not affected by load** (it
covers the worker process, not helper processes such as `rg`).
`--clone-mode shallow` fetches one `--depth 1` snapshot per base commit instead of cloning: far less data for
huge repositories with few instances, at the price that variants see no git history (recorded in the manifest).

## Known biases and limitations

* **Patch files are only a proxy for useful context.** An agent may need callers, tests or docs that the patch
  does not touch, and a correct fix may touch other files. Gold files are what the reference patch edited.
* **Issue text may name the files.** The indicator above shows how often; see the `names a gold file` split.
  Identifier-level hints (a function name in the issue) are not measured.
* **Baseline truncation.** Upstream 2.1.0 rejects queries over 8000 characters, so `baseline` is evaluated on
  the first 8000 characters (about 2% of DEV statements are longer). Variants that handle long text see it all.
* **Path policy.** Engines skip some directories (`build/`, `dist/`, `vendor/`, `target/`, `coverage/`, ...):
  a gold file below such a directory is unreachable by design; it is counted, not removed (`bench:v3:data`
  reports it; in the Lite + Multilingual DEV split no gold file is affected).
* **Test-file heuristic** is path-based; code in a package named `test` (for example `django/test/`) is
  classified as test code, which matches SWE-bench's own patch/test_patch partition.
* **Line gold is narrow** (edit sites only, no context), so `goldLineRecall` is a strict measure; use
  `packFileHit` and `packLineHit` for the lenient views.
* **Pack order is not a pure ranking.** Hit@k and MRR use the order in which files first appear in the pack,
  which for RepoSqueeze is greedy-packing order. Variants that pack many small excerpts from many files and
  variants that pack a few large ones are compared at the same token budget only.
* **Language labels** come from the extensions of the gold files (the repository's main language breaks ties
  and decides `.h`). Docs/config-only gold (`hasCodeGold = false`) is rare but kept.
* **Latency and RSS** are measured on a shared machine; read them with the recorded load.
* Datasets can change upstream: the content hash and hub revision of what was used are in every report.
* Gold patches and issues are public and may be memorised by language models; the evaluated engines are
  model-free, so this does not affect them, but do not reuse the numbers for LLM agents.

## Dev/test discipline

Tune, debug and iterate only on DEV. The held-out TEST split is executed exactly once, by the orchestrator, at
the end, with `--split test --i-am-the-orchestrator-final-run`. Without that flag the CLI exits with an
error for `--split test`, and `--instances` containing a held-out id is rejected. `bench:v3:data`
computes content statistics (gold extraction, languages, repositories) for DEV only; held-out instances are
only counted. Never open, inspect or tune on held-out instances.

## Layout

```
bench/run.ts                      CLI (run | data | splits | prepare | report)
bench/lib/dataset.ts              HF datasets-server fetch, JSONL cache, content hashes
bench/lib/split.ts                split rule and splits.json
bench/lib/gitdiff.ts testfiles.ts lang.ts mentions.ts gold.ts   gold extraction and instance preparation
bench/lib/select.ts               filters, deterministic stratified sampling
bench/lib/repos.ts git.ts lock.ts corpus clones, private checkouts, hermetic git
bench/lib/variants.ts worker.ts runner.ts   variant specs, child process worker, timeouts and clean kill
bench/lib/metrics.ts stats.ts     metrics, bootstrap, exact McNemar
bench/lib/report.ts render.ts     aggregation and markdown
bench/lib/execute.ts load.ts      orchestration, resume, load guard
bench/variants/ripgrep-naive/     reference variant
bench/splits.json                 dev/test assignment per dataset
tests/bench-*.test.ts             unit and integration tests (run under npm test)
```
