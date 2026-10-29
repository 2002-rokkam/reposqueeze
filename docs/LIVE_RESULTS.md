# Live Copilot measurements

Generated from [raw results](../benchmarks/live/results.json) by [summarize-live.ts](../scripts/summarize-live.ts). Experiment finished 2026-10-28T17:10:05.089Z. Actual model(s): **gpt-6-luna**. Four fresh questions × four arms = 16 independent sessions. See [protocol and limitations](EVALUATION.md#live-copilot-comparison).

| Arm | Requested facts correct | Provider input incl. cache | Provider output incl. reasoning | Reasoning subset | Visible answer, o200k | Raw totalNanoAiu |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Whole relevant file / ordinary | 4/4 | 65298 | 636 | 385 | 230 | 847995000 |
| Whole relevant file / concise | 4/4 | 65408 | 463 | 239 | 205 | 840720000 |
| 3000-token pack / ordinary | 4/4 | 54259 | 476 | 212 | 243 | 702007500 |
| 3000-token pack / concise | 4/4 | 54367 | 695 | 488 | 190 | 714307500 |

With ordinary answer instructions held constant, packed context used **16.9% fewer provider input tokens**, **25.2% fewer provider output tokens**, and **17.2% less reported totalNanoAiu** than the oracle-selected whole-file baseline. All four requested fact checks passed in both arms. This is a small observed comparison, not a guaranteed future saving.

The combined pack + concise arm used 16.7% fewer input tokens, but provider output increased by 9.3% relative to whole-file / ordinary. Its reported totalNanoAiu was 15.8% lower. Concise wording **did not reliably reduce billed output** in this experiment: in the packed arm, it increased counted reasoning/output despite a shorter visible answer. Do not hide this negative result or treat output brevity as equivalent to billing savings.

All calls reported zero cache-read tokens. Almost all input was recorded as cache-write tokens, with three ordinary input tokens per call. The table includes both categories rather than presenting only the tiny uncached input field. Hidden CLI/system context remains included. Raw totalNanoAiu is a provider usage field; no undocumented conversion to displayed credits or money is made here. Equal model and cache categories support a within-run relative comparison, not a billing guarantee.

The 16/16 fact checks cover four simple randomized-value questions, not 16 independent repository tasks. The model saw fresh constants but the task templates were authored by the implementer. Some generated line citations are imprecise; exact-string grading does not validate citations. No file edits, multi-step debugging, tool selection, retry cost, or additional expansion calls were evaluated. Auto routing was requested, so future runs may select other models. No failed response was excluded and no retrieval parameter was tuned on these results.
