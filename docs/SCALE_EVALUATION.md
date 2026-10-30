# 50,000-file scale evaluation

RepoSqueeze V2.1 was tested on a deterministic synthetic repository containing 50,000 TypeScript source files, at least 1.2 million lines and 100 query/gold-file pairs. Each query has 20 files containing the same incident term but only one root-cause file containing the full identifier evidence.

The first 80 tasks were used for development. Retrieval, packing and the evaluator were then frozen at SHA-256 `2ad34e1103ac9267471a9eaf376e643e86a520b177e9e5aa675077c73a3ef0a4`. The remaining 20 tasks ran once against that fingerprint.

## Results

| Metric | Development 80 | Held-out 20 |
| --- | ---: | ---: |
| Root-cause file Any@10 | 100% | **100%** |
| Root-cause file Any@20 | 100% | **100%** |
| Root-cause file included in 3K pack | 100% | **100%** |
| Mean parsed candidates | 200 | 200 |
| Mean output tokens | 2,959 | 2,967 |
| Median query time | 0.75 s | 1.31 s |
| 95th-percentile query time | 1.14 s | 4.51 s |
| Peak resident memory | 541 MiB | 475 MiB |

The initial development query built the persistent 4.0 MB compressed index in 10.50 seconds. Subsequent queries reused file sketches. Timings are from one Apple Silicon workstation and should not be treated as cross-machine guarantees.

The repository contained 50,001 eligible files during evaluation because its `.reposqueeze-v2ignore` control file was also indexed. Only 200 exact source files were parsed per query; ranking and packing still saw the complete file-level inventory.

## Reproduce

```sh
npm run bench:scale:development
npm run bench:scale:test
```

The first command generates `/private/tmp/reposqueeze-scale-50000`, initializes its Git index, runs 80 tasks and writes the freeze. The second command refuses to run if scale retrieval, PCR, packing or the evaluator has changed.

Raw evidence:

- [Development report](../benchmarks/scale-development.json)
- [Held-out report](../benchmarks/scale-test.json)
- [Freeze](../benchmarks/scale-freeze.json)
- [Evaluator and generator](../scripts/benchmark-scale.ts)

## Limits

This benchmark proves operation on its generated distribution, not perfect retrieval for every 50,000-file repository. Its identifiers are deterministic and the gold files contain exact term evidence. Real monorepos have generated code, duplicated APIs, cross-language names, build indirection and tasks that do not name their relevant concepts.

The candidate stage can miss a file with no shared path or indexed term. Files with more than 8,192 unique normalized terms use deterministic term sampling. Increase `REPOSQUEEZE_MAX_CANDIDATES`, provide paths or identifiers, or use ordinary search when obligations are missing. Set `REPOSQUEEZE_REFRESH_INDEX=1` after timestamp-preserving edits.

The 100% held-out result is scale-corpus retrieval accuracy. It is not 100% answer accuracy, patch success or Copilot-credit reduction.
