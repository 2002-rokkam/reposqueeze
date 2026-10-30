# RepoSqueeze V2 evaluation

The primary result is a frozen, paired comparison of V1 retrieval and V2 perturbation-consensus retrieval on the official Agent Retrieval Bench `v2_trace2code` release. Both variants see the same prebuilt source chunks and receive the same ranking limits and 4,000-token packing budget. No embedding model is used.

The result supports a narrower claim than “100% accurate”: on this held-out retrieval set, V2 finds more labeled root-cause files, ranks them earlier, includes more labeled lines and surfaces fewer known distractors. It does not test whether a coding model writes the correct answer or patch, and it does not measure billed Copilot credits.

## Frozen protocol

- Dataset: [Agent Retrieval Bench](https://github.com/eyuansu62/agent-retrieval-bench) `v2_trace2code`, 101 samples, seven repositories and 356,074 prebuilt chunks.
- Archive SHA-256: `19b252e8cfff42107fedc74005dbb6972f2970af33651ce0c1571546819e41c4`.
- Split: sort opaque sample IDs, use the first 80 for development and the remaining 21 once for held-out testing. This is a sample-level split; repositories occur on both sides.
- Freeze fingerprint: `a06c988f7aa6187ceeb6b626f3463749d8e7998ea7fadd79fb0912689b9ac1e2` over PCR, V1 ranking, parsing, the evaluator and archive checksum.
- Query forms: original, deterministic 20% word dropout, command-field removal and line reordering.
- Statistics: the original query is the primary unit. Confidence intervals use 20,000 deterministic paired sample-level bootstrap resamples. Binary outcomes also use an exact two-sided McNemar test.
- Disclosure: the first two dataset rows were inspected while adapting the schema. Their metrics were not viewed before the freeze. The held-out command refuses to run if fingerprinted code changes.

## Held-out original queries

| Metric | V1 | V2 PCR | Paired change | Bootstrap 95% interval for change |
| --- | ---: | ---: | ---: | ---: |
| MRR | 0.293 | **0.467** | **+0.175** | +0.099 to +0.256 |
| Any labeled root-cause file @5 | 47.62% | **61.90%** | **+14.29 pp** | 0.00 to +28.57 pp |
| Any labeled root-cause file @10 | 52.38% | **80.95%** | **+28.57 pp** | +9.52 to +47.62 pp |
| Any labeled root-cause file @20 | 80.95% | **90.48%** | **+9.52 pp** | 0.00 to +23.81 pp |
| Root-cause file recall @20 | 78.57% | **88.10%** | **+9.52 pp** | 0.00 to +23.81 pp |
| Known hard negative in top 5 ↓ | 66.67% | **38.10%** | **−28.57 pp** | −47.62 to −9.52 pp |
| Gold-line recall in 4K pack | 16.06% | **30.99%** | **+14.93 pp** | +5.05 to +27.14 pp |
| Gold-line precision in 4K pack | 0.93% | **1.84%** | **+0.91 pp** | +0.31 to +1.64 pp |
| Mean packed tokens | 3,990.0 | 3,993.6 | +3.7 | −4.6 to +18.1 |

For Any@10, six samples changed from a V1 miss to a V2 hit and none changed in the opposite direction; exact two-sided McNemar `p = 0.03125`. For hard negatives, V2 removed six V1 top-five distractor hits and introduced none; `p = 0.03125`. The other intervals are estimates from a small set and should not be presented as universal effects.

V2 used essentially the same packing budget. The improvement came from ordering and selection rather than sending a larger context.

## Query perturbations

The four forms produce 84 paired retrieval runs from 21 underlying samples. They show that the result survives the tested wording changes, but those 84 rows are correlated and are not 84 independent test samples.

| Aggregate across four forms | V1 | V2 PCR |
| --- | ---: | ---: |
| MRR | 0.291 | **0.467** |
| Any@10 | 52.38% | **80.95%** |
| Any@20 | 82.14% | **89.29%** |
| Recall@20 | 79.37% | **86.90%** |
| Hard negative in top 5 ↓ | 66.67% | **40.48%** |
| Gold-line recall in 4K pack | 16.19% | **30.28%** |
| Gold-line precision in 4K pack | 0.94% | **1.75%** |

The dropout form was the hardest V2 condition: Any@10 was 76.19%, compared with 80.95% on original wording. This is evidence of improved robustness, not invariance to arbitrary paraphrases.

## Development evidence

Before freezing, the 80-sample development partition showed the same direction. On original queries, Any@10 rose from 68.75% to 83.75%, hard-negative hit@5 fell from 57.50% to 33.75%, and line recall at 4K rose from 28.30% to 44.52%.

A separate 40-question stress suite across eight checked-out repositories tested original, dropout, telegraphic and reordered wording. At a 3,000-token budget the aggregate complete-evidence rate increased from 90.00% for V1 to 91.88% for V2. This suite influenced development and is not independent confirmation.

## Remaining failures

V2 still missed every labeled root-cause file in the top ten for four of 21 original held-out samples:

| Sample | Repository | V2 reciprocal rank | Hard negative in top 5 |
| --- | --- | ---: | --- |
| `de059c1c2e3ffc63820ce0e4` | `caddyserver/caddy` | 0.0135 | yes |
| `d0551ed5a2d63c99e3bbfcd5` | `gin-gonic/gin` | 0.0909 | no |
| `d3fe4d1559febe2ac282cced` | `gin-gonic/gin` | 0.0455 | yes |
| `f4fccd0dc58a48c09a195d6b` | `pallets/click` | 0.0556 | yes |

Eight of 21 samples still had a labeled hard negative in V2's top five. Absolute line precision remained low at 1.84%, meaning most packed lines were not inside the benchmark's narrow gold spans. The pack can include useful setup or dependency code outside those spans, but this evaluator does not prove that it is useful. These failures are why the tool reports missing obligations and tells callers to use expansion or ordinary search.

There were no original-query MRR regressions and no V1-only Any@10 successes in this particular held-out set. With 21 samples, that observation is not a guarantee for other repositories.

## Reproduce and audit

Install the upstream `arb` tool and download its self-contained subset:

```sh
arb download-benchmark --version v2_trace2code --local-dir data --force
```

Point `ARB_TRACE_ROOT` at the extracted release directory containing `benchmark/`, `corpus/` and `trace.sha256`, then run:

```sh
npm ci
ARB_TRACE_ROOT=/path/to/arb-trace npm run bench:v2:development
ARB_TRACE_ROOT=/path/to/arb-trace npm run bench:v2:test
npm run bench:v2:summary
```

This blind report belongs to V2.0 commit `190ef6d934af2cc21e3f70caf1431fb1e9e079e4`. V2.1 keeps the PCR ranking algorithm but changes repository enumeration and context reporting, so its whole-file fingerprint intentionally differs. Check out that commit to reproduce the exact frozen ARB run. The V2.1 scale experiment below has its own independent freeze and held-out split; the already-seen ARB test set was not reused to tune or re-certify V2.1.

The checked-in evidence is:

- [Development raw report](../benchmarks/v2-arb-development.json)
- [Held-out raw report](../benchmarks/v2-arb-test.json)
- [Frozen fingerprint](../benchmarks/v2-freeze.json)
- [Deterministic statistics and failure list](../benchmarks/v2-summary.json)
- [40-question development stress report](../benchmarks/v2-development.json)
- [Evaluator](../scripts/benchmark-v2-arb.ts) and [summary script](../scripts/summarize-v2.ts)

The evaluator reads the official prebuilt chunks and does not execute code from benchmark repositories.

Repository-scale behavior is evaluated separately because the ARB release supplies prebuilt chunks and therefore does not exercise file enumeration or parsing. See the [50,000-file scale evaluation](SCALE_EVALUATION.md), including its independent 80:20 freeze, cold-index time, warm-query latency, memory use and synthetic-data limitations.

## What this does and does not prove

The paired held-out result is evidence that PCR improved retrieval on this ARB subset under an equal evidence budget. It is not 100% accuracy, a proof of worldwide algorithmic novelty, an answer-quality evaluation, an executable patch benchmark or a measurement of provider billing. Real savings depend on whether the client actually calls the tool, how often it expands, hidden prompts, cache behavior, reasoning tokens and the final answer length.
