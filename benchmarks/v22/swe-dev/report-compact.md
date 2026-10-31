# SWE retrieval benchmark: DEV split

- Command: `node --import tsx bench/run.ts --dataset lite,multilingual --split dev --repos axios/axios,briannesbitt/carbon,burntsushi/ripgrep,caddyserver/caddy,django/django,faker-ruby/faker,fmtlib/fmt,gin-gonic/gin,google/gson,immutable-js/immutable-js,jekyll/jekyll,jqlang/jq,marshmallow-code/marshmallow,micropython/micropython,mwaskom/seaborn,nlohmann/json,pallets/flask,preactjs/preact,psf/requests,pydicom/pydicom,pytest-dev/pytest,sharkdp/bat,sphinx-doc/sphinx,sympy/sympy,tokio-rs/axum,tokio-rs/tokio --sample 60 --offline --variant baseline --variant current --variant ripgrep-naive --budget 4000 --workers 2 --timeout 120 --max-load 80 --out ~/reposqueeze-lab/results/bench-swe/final-dev/main`
- Started: 2026-10-31T14:47:56.631Z, finished: 2026-10-31T15:17:02.866Z
- Environment: Node v25.9.0, darwin/arm64, 8 cores, 16 GiB RAM, 2 worker(s), 120 s task timeout
- Budget: 4000 o200k_base tokens; bootstrap: 10,000 resamples, seed 1729; harness 4e351856fc3b
- Instances: 60 (SHA-256 of sorted ids 2c565469f5620c56)
- Corpus: 26 full clone(s), 0 depth-1 snapshot repo(s) (shallow repos give variants no git history)
- Filters: repos=axios/axios,briannesbitt/carbon,burntsushi/ripgrep,caddyserver/caddy,django/django,faker-ruby/faker,fmtlib/fmt,gin-gonic/gin,google/gson,immutable-js/immutable-js,jekyll/jekyll,jqlang/jq,marshmallow-code/marshmallow,micropython/micropython,mwaskom/seaborn,nlohmann/json,pallets/flask,preactjs/preact,psf/requests,pydicom/pydicom,pytest-dev/pytest,sharkdp/bat,sphinx-doc/sphinx,sympy/sympy,tokio-rs/axum,tokio-rs/tokio sample=60 sampleMode=even

## Datasets

| dataset | HF revision | content SHA-256 | unique instances | dev | held-out test | dev prepared | selected |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SWE-bench/SWE-bench_Lite | b0dde1093fe4 | 168468da50ffec2f | 323 | 167 | 156 | 167 | 19 |
| SWE-bench/SWE-bench_Multilingual | 846e647b9f33 | 23d209c7ffcfe2ac | 300 | 160 | 140 | 160 | 41 |

No instance was skipped during gold extraction.

## Variants

| variant | path | git SHA | dirty | engine version | env | query truncation | src fingerprint |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | <baseline-2.1.0> | 25fe500f3317 | no | 2.1.0 | - | 8000 chars | 3c4d6c1f3d2b |
| current | <checkout> | b7bc1c7a28f3 | no | 2.2.0 | - | none | ac37eeddd2fc |
| ripgrep-naive | bench/variants/ripgrep-naive | 4e351856fc3b | no | 1.0.0 | - | none | daff62ce4da2 |

## Overall

Means over all instances; a timeout or error counts as a zero for every retrieval metric (`fail` shows how many). Intervals are 95% percentile-bootstrap CIs over instances. Hit@k and MRR rank distinct files by first appearance in `pack.evidence`; line recall uses pre-image edit-site lines (removed lines plus context anchors around pure insertions). Seconds are `engine.context()` wall time over completed runs.

| variant | N | fail (timeout/error) | packFileHit | packFileRecall | goldLineRecall | packLineHit | MRR | Hit@1 | Hit@3 | Hit@5 | Hit@10 | tokens | sec mean (p50/p90) | cpu sec mean | load avg | RSS MB mean/max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 60 | 1 (1/0) | 0.483 [0.35, 0.60] | 0.432 [0.31, 0.55] | 0.274 [0.17, 0.39] | 0.317 [0.20, 0.43] | 0.288 [0.19, 0.39] | 0.200 [0.10, 0.30] | 0.350 [0.23, 0.47] | 0.400 [0.28, 0.52] | 0.450 [0.33, 0.57] | 3970 | 19.1 (9.7/45.5) | 10.73 | 39.5 | 851/2367 |
| current | 60 | 0 (0/0) | 0.817 [0.72, 0.90] | 0.747 [0.64, 0.84] | 0.528 [0.41, 0.65] | 0.567 [0.43, 0.68] | 0.391 [0.30, 0.49] | 0.250 [0.15, 0.37] | 0.450 [0.33, 0.57] | 0.600 [0.48, 0.72] | 0.733 [0.62, 0.83] | 3978 | 14.9 (8.2/21.8) | 7.85 | 38.9 | 972/2310 |
| ripgrep-naive | 60 | 0 (0/0) | 0.650 [0.53, 0.77] | 0.577 [0.46, 0.69] | 0.118 [0.05, 0.20] | 0.167 [0.08, 0.27] | 0.306 [0.22, 0.40] | 0.167 [0.08, 0.27] | 0.383 [0.27, 0.50] | 0.433 [0.32, 0.57] | 0.633 [0.52, 0.75] | 3962 | 8.5 (2.8/21.9) | 1.07 | 39.2 | 426/475 |

## Paired comparisons

### current vs baseline

Paired over 60 common instances.

| metric | baseline | current | current - baseline [95% CI] | only baseline / only current | McNemar exact p |
| --- | --- | --- | --- | --- | --- |
| packFileHit | 0.483 | 0.817 | +0.333 [0.217, 0.450] | 0 / 20 | <0.0001 |
| packFileRecall | 0.432 | 0.747 | +0.315 [0.208, 0.425] |  |  |
| goldLineRecall | 0.274 | 0.528 | +0.254 [0.149, 0.362] |  |  |
| packLineHit | 0.317 | 0.567 | +0.250 [0.150, 0.367] | 0 / 15 | <0.0001 |
| MRR | 0.288 | 0.391 | +0.103 [0.047, 0.163] |  |  |
| Hit@1 | 0.200 | 0.250 | +0.050 [-0.033, 0.133] | 2 / 5 | 0.4531 |
| Hit@3 | 0.350 | 0.450 | +0.100 [0.033, 0.183] | 0 / 6 | 0.0313 |
| Hit@5 | 0.400 | 0.600 | +0.200 [0.100, 0.300] | 0 / 12 | 0.0005 |
| Hit@10 | 0.450 | 0.733 | +0.283 [0.167, 0.400] | 0 / 17 | <0.0001 |
| outputTokens | 3903.3 | 3977.9 | +74.600 [4.167, 209.983] |  |  |
| seconds | 20.8 | 14.9 | -5.848 [-8.930, -3.221] |  |  |

## Bias indicator: does the issue name a gold file?

13 of 60 instances (21.7%) literally mention a gold file by path or file name (12 by path suffix, 13 by file name; 21 also by bare file stem, a weaker signal). 60 of 60 have at least one code file in the gold set; 15 have more than one gold file. Retrievers benefit from such literal hints, so read the split below before concluding anything about semantic retrieval.

## By dataset

| dataset | N | baseline hit | baseline recall | baseline line | baseline MRR | baseline fail | current hit | current recall | current line | current MRR | current fail | ripgrep-naive hit | ripgrep-naive recall | ripgrep-naive line | ripgrep-naive MRR | ripgrep-naive fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lite | 19 | 0.53 | 0.53 | 0.35 | 0.41 | 0 | 0.79 | 0.79 | 0.70 | 0.52 | 0 | 0.47 | 0.47 | 0.06 | 0.28 | 0 |
| multilingual | 41 | 0.46 | 0.39 | 0.24 | 0.23 | 1 | 0.83 | 0.73 | 0.45 | 0.33 | 0 | 0.73 | 0.62 | 0.15 | 0.32 | 0 |

## By language

| language | N | baseline hit | baseline recall | baseline line | baseline MRR | baseline fail | current hit | current recall | current line | current MRR | current fail | ripgrep-naive hit | ripgrep-naive recall | ripgrep-naive line | ripgrep-naive MRR | ripgrep-naive fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C | 5 | 0.20 | 0.20 | 0.00 | 0.10 | 1 | 0.80 | 0.80 | 0.60 | 0.25 | 0 | 0.80 | 0.80 | 0.20 | 0.17 | 0 |
| C++ | 3 | 0.33 | 0.33 | 0.00 | 0.05 | 0 | 1.00 | 0.83 | 0.00 | 0.16 | 0 | 0.67 | 0.50 | 0.00 | 0.22 | 0 |
| Go | 6 | 0.33 | 0.33 | 0.33 | 0.19 | 0 | 0.67 | 0.67 | 0.67 | 0.23 | 0 | 0.67 | 0.67 | 0.17 | 0.10 | 0 |
| Java | 3 | 1.00 | 0.83 | 0.92 | 1.00 | 0 | 1.00 | 0.83 | 0.79 | 0.83 | 0 | 1.00 | 1.00 | 0.71 | 0.83 | 0 |
| JavaScript | 7 | 0.57 | 0.50 | 0.29 | 0.16 | 0 | 1.00 | 0.93 | 0.53 | 0.32 | 0 | 0.71 | 0.71 | 0.27 | 0.13 | 0 |
| PHP | 3 | 0.00 | 0.00 | 0.00 | 0.00 | 0 | 0.67 | 0.30 | 0.00 | 0.23 | 0 | 0.67 | 0.37 | 0.00 | 0.44 | 0 |
| Python | 19 | 0.53 | 0.53 | 0.35 | 0.41 | 0 | 0.79 | 0.79 | 0.70 | 0.52 | 0 | 0.47 | 0.47 | 0.06 | 0.28 | 0 |
| Ruby | 5 | 0.40 | 0.40 | 0.40 | 0.17 | 0 | 0.60 | 0.60 | 0.60 | 0.30 | 0 | 0.40 | 0.40 | 0.00 | 0.13 | 0 |
| Rust | 9 | 0.67 | 0.44 | 0.11 | 0.31 | 0 | 0.89 | 0.71 | 0.26 | 0.40 | 0 | 0.89 | 0.56 | 0.00 | 0.63 | 0 |

## By issue names a gold file

| issue names a gold file | N | baseline hit | baseline recall | baseline line | baseline MRR | baseline fail | current hit | current recall | current line | current MRR | current fail | ripgrep-naive hit | ripgrep-naive recall | ripgrep-naive line | ripgrep-naive MRR | ripgrep-naive fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| does not name a gold file | 47 | 0.40 | 0.35 | 0.20 | 0.22 | 0 | 0.79 | 0.70 | 0.46 | 0.33 | 0 | 0.57 | 0.49 | 0.07 | 0.25 | 0 |
| names a gold file (path or file name) | 13 | 0.77 | 0.71 | 0.54 | 0.52 | 1 | 0.92 | 0.92 | 0.77 | 0.61 | 0 | 0.92 | 0.90 | 0.30 | 0.50 | 0 |

## Notes

- Gold = pre-image files edited by the gold patch (tests and new files excluded); gold lines = removed lines plus context anchors around pure insertions.
- Every (instance, variant) pair runs in a fresh child process on its own pristine checkout of the base commit; variants of one instance run sequentially in a hash-determined order.
- Timeouts and engine errors count as zero for every retrieval metric and are reported separately.
