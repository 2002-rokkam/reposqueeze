# SWE retrieval benchmark, DEV split: baseline 2.1.0 vs current integration build

Harness: `bench/run.ts` (this branch). Query = raw issue text, gold = non-test files (and pre-image edit lines) of the gold patch,
real `Engine` on the repository at `base_commit`. Budget 4000 o200k tokens, 1 fresh process per (instance, variant), 120 s timeout,
2 workers, bootstrap 10,000 resamples (seed 1729), exact McNemar. Full JSON, rows and packs: `~/reposqueeze-lab/results/bench-swe/final-dev/main/`.

## Sample

* DEV split only (SHA-256 rule), SWE-bench Lite (19 instances) + Multilingual (41), 60 instances, repository-stratified (`--sample 60`, even mode),
  restricted to 26 smaller repositories (no druid, lucene, terraform, three.js, ...). 9 languages: Python 19, Rust 9, JavaScript 7, Go 6, C 5, Ruby 5, Java 3, PHP 3, C++ 3.
* 13 of 60 issues (22%) literally name a gold file (bias indicator; see split below).
* Variants: `baseline` = upstream 2.1.0 (`@truncate=8000`), `current` = `~/Desktop/reposqueeze` at git `b7bc1c7a28f3`, src fingerprint `ac37eeddd2fc`
  (**an integration snapshot taken while the working tree was still being modified; not the final build**), `ripgrep-naive` = bundled grep-style reference.

## Overall (failures count as 0; 95% bootstrap CI over instances)

| variant | fail (timeout/error) | packFileHit | packFileRecall | goldLineRecall | MRR | Hit@5 | Hit@10 | tokens (ok mean) | sec mean (p50/p90) | RSS MB mean/max |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 1 (1/0) | 0.483 [0.35, 0.60] | 0.432 [0.31, 0.55] | 0.274 [0.17, 0.39] | 0.288 [0.19, 0.39] | 0.400 | 0.450 | 3970 | 19.1 (9.7/45.5) | 851/2367 |
| current | 0 | 0.817 [0.72, 0.90] | 0.747 [0.64, 0.84] | 0.528 [0.41, 0.65] | 0.391 [0.30, 0.49] | 0.600 | 0.733 | 3978 | 14.9 (8.2/21.8) | 972/2310 |
| ripgrep-naive | 0 | 0.650 [0.53, 0.77] | 0.577 [0.46, 0.69] | 0.118 [0.05, 0.20] | 0.306 [0.22, 0.40] | 0.433 | 0.633 | 3962 | 8.5 (2.8/21.9) | 426/475 |

No budget violations. The single baseline failure is a 120 s timeout (`micropython__micropython-15898`).
Machine load average was ~39 for the whole run, so wall-clock seconds are inflated and only comparable within this run; mean CPU seconds: baseline 10.7, current 7.8, ripgrep-naive 1.1.

## Paired comparisons (60 instances)

current - baseline:

| metric | baseline | current | diff [95% CI] | only baseline / only current | McNemar p |
|---|---|---|---|---|---|
| packFileHit | 0.483 | 0.817 | +0.333 [+0.217, +0.450] | 0 / 20 | <0.0001 |
| packFileRecall | 0.432 | 0.747 | +0.315 [+0.208, +0.425] | | |
| goldLineRecall | 0.274 | 0.528 | +0.254 [+0.149, +0.362] | | |
| MRR | 0.288 | 0.391 | +0.103 [+0.047, +0.163] | | |
| Hit@1 | 0.200 | 0.250 | +0.050 [-0.033, +0.133] | 2 / 5 | 0.4531 |
| Hit@5 | 0.400 | 0.600 | +0.200 [+0.100, +0.300] | 0 / 12 | 0.0005 |
| Hit@10 | 0.450 | 0.733 | +0.283 [+0.167, +0.400] | 0 / 17 | <0.0001 |
| outputTokens | 3903 | 3978 | +75 [+4, +210] | | |
| seconds (loaded machine) | 20.8 | 14.9 | -5.8 [-8.9, -3.2] | | |

ripgrep-naive - current:

| metric | current | ripgrep-naive | diff [95% CI] | only current / only ripgrep-naive | McNemar p |
|---|---|---|---|---|---|
| packFileHit | 0.817 | 0.650 | -0.167 [-0.267, -0.067] | 11 / 1 | 0.0063 |
| packFileRecall | 0.747 | 0.577 | -0.170 [-0.279, -0.067] | | |
| goldLineRecall | 0.528 | 0.118 | -0.410 [-0.528, -0.292] | | |
| MRR | 0.391 | 0.306 | -0.085 [-0.183, +0.013] | | |
| Hit@5 | 0.600 | 0.433 | -0.167 [-0.300, -0.033] | 15 / 5 | 0.0414 |
| Hit@10 | 0.733 | 0.633 | -0.100 [-0.200, +0.000] | 8 / 2 | 0.1094 |

ripgrep-naive vs baseline 2.1.0: file hit +0.167 [+0.033, +0.300] (McNemar p=0.031) but gold-line recall -0.156 [-0.261, -0.055]:
a plain grep reference finds more files than upstream 2.1.0 but places far fewer of the edit lines in the pack.

## By language (file hit / gold-line recall)

| language | N | baseline | current | ripgrep-naive |
|---|---|---|---|---|
| Python | 19 | 0.53 / 0.35 | 0.79 / 0.70 | 0.47 / 0.06 |
| Rust | 9 | 0.67 / 0.11 | 0.89 / 0.26 | 0.89 / 0.00 |
| JavaScript | 7 | 0.57 / 0.29 | 1.00 / 0.53 | 0.71 / 0.27 |
| Go | 6 | 0.33 / 0.33 | 0.67 / 0.67 | 0.67 / 0.17 |
| C | 5 | 0.20 / 0.00 | 0.80 / 0.60 | 0.80 / 0.20 |
| Ruby | 5 | 0.40 / 0.40 | 0.60 / 0.60 | 0.40 / 0.00 |
| Java | 3 | 1.00 / 0.92 | 1.00 / 0.79 | 1.00 / 0.71 |
| PHP | 3 | 0.00 / 0.00 | 0.67 / 0.00 | 0.67 / 0.00 |
| C++ | 3 | 0.33 / 0.00 | 1.00 / 0.00 | 0.67 / 0.00 |

Languages have 3-19 instances: per-language numbers are anecdotal. By whether the issue names a gold file (file hit): not named (N=47) baseline 0.40, current 0.79, ripgrep-naive 0.57; named (N=13) 0.77 / 0.92 / 0.92.
Gold-line recall for Java current is lower than baseline (0.79 vs 0.92) on 3 instances; Hit@1 is not significantly different from baseline.

## Limitations

* 60 instances from 26 repositories; instances are treated as independent although they cluster by repository, so CIs are optimistic.
* Gold = files the reference patch edits (a proxy for useful context). Pack order for Hit@k/MRR is greedy-packing order.
* `current` is a mid-integration snapshot; re-run against the frozen final build before quoting these numbers for the release.
* A feature-ablation run (`RSQ_FEATURES`, `RSQ_TOKENIZER=v1`) was started and **aborted**: the integration working tree changed while it ran, so its rows were discarded and nothing from it is reported.
