# Research notes and evidence review

Reviewed 28 October 2026. This is a focused review of relevant open-source approaches, not an exhaustive survey of all repositories. Published results below belong to their authors; inspecting code and result artifacts is not an independent reproduction of their model runs.

## Jev and Laya: what their proofs establish

**[Jev ultrafast](https://github.com/browser-use/jev-ultrafast)** was inspected at commit `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`, including the browser runtime and [performance evidence](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/docs/performance.md). It offers a changing table of permitted actions to a typed decision service, with freshness guards and a separate text helper. That is a useful way to constrain decisions, but it does not prove arbitrary code-context compression is lossless. The committed matched comparison has three pairs for one Google Flights task: median 9.450 seconds versus 7.092 seconds, both 3/3 successful. The reported two-sided sign-test p-value is 0.25. Helper-only costs exclude other service costs. We did not call its paid service or reproduce the live browser experiment.

**[Laya](https://github.com/NandhaKishorM/laya)** was inspected at commit `b9fe351ce81e2d974bca2bf219c1e4030c0a05ea`, including [BENCHMARKS.md](https://github.com/NandhaKishorM/laya/blob/b9fe351ce81e2d974bca2bf219c1e4030c0a05ea/BENCHMARKS.md), decision APIs and confidence handling. Typed decisions and confidence gating can avoid generating unnecessary prose. Its documentation distinguishes in-training application data from held-out sources: held-out toxicity accuracy is 0.530 and jailbreak results span 0.708–0.762. It acknowledges no committed result file behind the headline fine-tuned 0.766 figure and documents a repaired multilingual reproduction discrepancy. Confident errors mean thresholds alone cannot establish correctness. We did not train or run its checkpoints. RepoSqueeze therefore uses deterministic budget/round-trip checks where possible, and explicit recovery reads where retrieval can fail.

The user's Medium article was useful as a pointer to Jev; primary repository artifacts are the basis of this review.

## Related approaches

| Project / primary source | Useful idea | Decision for RepoSqueeze |
| --- | --- | --- |
| [Aider repository maps](https://aider.chat/docs/repomap.html) | Ranked repository structure under a token budget | Use structural signals and citations; do not claim to reproduce Aider's algorithm or outperform it. |
| [Repomix](https://github.com/yamadashy/repomix) | Package a repository; syntax-aware compressed views | Add a bounded map and targeted excerpts; full-repository packing is only a broad size baseline. |
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | Persistent syntax and graph retrieval | Keep source-backed chunks and optional persistent vectors; no resolved call graph in this release. |
| [Graphify](https://github.com/Graphify-Labs/graphify) / [community Graphify](https://github.com/tezendrax/Graphify) | Explore repository relationships | Hosted Graphify's public material does not expose all implementation details. Treat graph context as a retrieval aid, not a proof of understanding. |
| [RTK](https://github.com/rtk-ai/rtk) | Reduce command-output noise before model ingestion | Provide explicit log compaction with loss labels. No RTK comparative benchmark was run. |
| [Caveman](https://github.com/JuliusBrussee/caveman) | Shorter generated language | Supply concise, complete answer guidance. Measure actual output rather than transfer another project's reduction claim. |
| [TOON](https://github.com/toon-format/toon) and its [benchmarks](https://github.com/toon-format/toon/blob/main/benchmarks/README.md) | Tabular JSON can avoid repeated keys | Use the actual codec; verify decode equality, count format overhead, and retain JSON when smaller. Nested data does not always benefit. |
| [LLMLingua](https://github.com/microsoft/LLMLingua), [LLMLingua-2 paper](https://arxiv.org/abs/2403.12968) | Learned token selection for prompt compression | Avoid deploying an additional learned compressor in the default path. Verbatim contiguous code is easier to inspect, although retrieval can still omit vital code. |
| [Jina late chunking](https://github.com/jina-ai/late-chunking) | Embed with broader document context before chunk pooling | Worth future investigation. Current Ollama per-chunk embeddings are **not** late chunking. |
| [Beads](https://github.com/gastownhall/beads) | Durable agent task memory | Distinguish task state from source evidence. This release stores neither unverified task claims nor generated repository summaries. |

## What is original here

The implemented combination is called **evidence budget packing**: structural retrieval, optional local semantic fusion, adaptive contiguous windows, exact-range receipts, explicit expansion, and a verified representation chooser. It was built for the same three surfaces—CLI, MCP and native VS Code tools—and tested with a common engine.

None of those ingredients alone is new. A literature review cannot establish that nobody has combined them before. There is no patentability or priority claim. The benchmark also fails to show an independent benefit from the graph-hint term. Future work should compare against actual Aider/Repomix/RTK integrations at equal end-to-end task quality and cost, with larger blinded task sets and realistic editing loops.

## Billing is part of the experiment

[GitHub's billing documentation](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing) describes model-dependent charges for input, output and cached tokens. A local token estimate alone cannot determine credits. Smaller evidence may also cause retries. Our report separates a tokenizer-based context budget from provider-reported usage and preserves the raw live-run usage fields without assuming undocumented unit conversions.

The integration follows the [VS Code language-model tool API](https://code.visualstudio.com/api/extension-guides/ai/tools), rather than trying to intercept private Copilot internals. Model tool selection and later reads remain under the agent's control.
