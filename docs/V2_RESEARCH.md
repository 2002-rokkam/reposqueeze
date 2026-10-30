# V2 research and gap analysis

Reviewed 31 October 2026. Primary papers, official benchmark artifacts and source repositories were used where available.

## What changed the design

The first RepoSqueeze combined lexical ranking, symbol/path boosts, lightweight identifier relations, optional embeddings, token-budget packing and exact source receipts. Its held-out set was small and showed 8/10 complete evidence for structural retrieval and 9/10 with local embeddings. The identifier-relation ablation did not improve the result. V2 does not treat that as solved.

Recent work made several obvious V2 ideas unsuitable as novelty claims:

- [Rivet](https://arxiv.org/abs/2610.34967) already grounds task anchors, follows dependencies/usages/configuration relations and shapes representations under a fixed budget. It reports executable Pass@1 improvements. It also explicitly leaves controlled robustness to wrong or missing graph edges for future study.
- [Agent Retrieval Bench](https://arxiv.org/abs/2607.24882) evaluates 427 workflow-derived samples, including trace-to-code and no-gold cases. It finds that retriever families have different strengths, simple rank fusion helps, raw top scores fail as natural abstention signals, and query rewriting/phrasing robustness remains future work.
- [ContextBench](https://arxiv.org/abs/2602.05892) supplies human-verified contexts for 1,136 tasks and shows the recall/precision cost of broad exploration. Complex agent scaffolds do not automatically improve context retrieval.
- [CORE-Bench](https://arxiv.org/abs/2606.11864) emphasizes repository-level requirements, similar in-repository distractors and edit localization beyond isolated semantic matching.
- [CodeRAG](https://arxiv.org/abs/2509.16112) uses multiple retrieval paths and learned preference reranking. V2's multiple query views are deterministic and do not reproduce its learned method.
- [ACON](https://github.com/microsoft/acon) optimizes compression policies for long agent trajectories. V2 focuses on initial repository evidence and explicit recovery.

## Targeted gap

Coding requests are unstable inputs. A stack trace mixes source signals with paths, test names, numbers, dependency downloads and repeated errors. Users paraphrase the same task, omit a key noun or paste only the final line. A single ranking can change sharply even when the repository evidence should not.

Agent Retrieval Bench explicitly proposes paired query rewrites as future work. Rivet reports no controlled study of graph-edge noise. ContextBench shows that adding more context can lower precision. These observations motivate a narrow question:

> Can a deterministic retriever improve worst-case evidence retrieval under small query perturbations, at the same context budget, without another hosted model?

## Perturbation-consensus retrieval

PCR creates up to six views:

1. the original request;
2. diagnostic lines containing failure/error/assertion signals;
3. identifier-heavy text;
4. three deterministic leave-one-term-bucket-out views.

Each view uses the same local lexical and structural ranker. Reciprocal-rank evidence is accumulated at chunk and file granularity. The original request has a modest extra weight. Stability is the fraction of views where a chunk remains near the top.

The packer also receives a small list of rare query terms found in the repository. These are **evidence obligations**, not proof requirements. They encourage coverage and are reported as covered or missing. In failure traces, visible test files are navigation anchors; same-stem source files get a bounded boost and test files get a penalty unless the request asks for tests.

This technique is deterministic, model-free and inspectable. Its main cost is running the inexpensive ranker several times. It does not compress source text semantically; selected code remains verbatim.

## Novelty wording

The repository calls the implemented technique perturbation-consensus retrieval because that precisely describes it. We found query rewriting, rank fusion, dropout, robustness testing and workflow-aware code retrieval individually in prior work. We did not find this exact deterministic combination with evidence obligations and trace-aware source inversion in the reviewed sources.

That search cannot establish worldwide novelty or patent priority. The defensible contribution is the implementation, frozen protocol, perturbation measurements, independent held-out evaluation and published negative results.

## Scaling research

Large code-search systems avoid parsing an entire corpus for every query. [Zoekt's design](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md) uses a persistent positional trigram index and exact verification, targeting repositories as large as Android or Chromium. [GitHub Code Search](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/) likewise explains why an n-gram inverted index is needed instead of scanning all content for every query. [ripgrep's official guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md) demonstrates the value of early ignore and binary filtering for repository traversal.

RepoSqueeze V2.1 applies the same broad cascade principle to a different output: a small evidence pack. Its first stage stores compact per-file term hashes and metadata; its second stage re-reads, verifies and structurally parses a bounded candidate set. This is an engineering adaptation, not a claim to have invented indexed code search.

## Evaluation rules

- V1 and V2 receive the same repository snapshot and ranking/packing budget.
- Development results may be viewed before freezing. Test execution checks a SHA-256 fingerprint of V2, V1 ranking, parsing and the evaluator.
- The official ARB archive checksum is recorded. No upstream repository code is executed.
- Metrics include MRR, Any@5/10/20, Recall@20, hard-negative hits, and line recall/precision under a 4K packed-context budget.
- Original and perturbed query results are reported separately. Aggregate results cannot hide a regression on original wording.
- The first two ARB rows were inspected while adapting the file format. Their metrics were not viewed before the freeze; this limitation is disclosed rather than describing the whole release as blind.
- Retrieval metrics are not answer accuracy or patch success. No 100% claim is made.
