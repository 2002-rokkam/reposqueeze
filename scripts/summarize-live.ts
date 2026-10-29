import { readFile, writeFile } from 'node:fs/promises';
import { tokens } from '../src/tokens.js';
const data=JSON.parse(await readFile('benchmarks/live/results.json','utf8'));
const rows=[];
for(const packed of [false,true])for(const concise of [false,true]) {
  const runs=data.results.filter((r:any)=>r.arm.packed===packed&&r.arm.concise===concise);
  const sum=(fn:(r:any)=>number)=>runs.reduce((a:number,r:any)=>a+fn(r),0);
  rows.push({packed,concise,n:runs.length,correct:sum(r=>Number(r.correct)),input:sum(r=>['input','cache_read','cache_write'].reduce((a,f)=>a+r.usage.tokenDetails[f].tokenCount,0)),output:sum(r=>r.usage.tokenDetails.output.tokenCount),cacheRead:sum(r=>r.usage.tokenDetails.cache_read.tokenCount),cacheWrite:sum(r=>r.usage.tokenDetails.cache_write.tokenCount),reasoning:sum(r=>Object.values(r.usage.modelMetrics).reduce((a:number,m:any)=>a+m.usage.reasoningTokens,0)),visibleO200k:sum(r=>tokens(r.response)),nanoAiu:sum(r=>r.usage.totalNanoAiu)});
}
const models=[...new Set(data.results.map((r:any)=>r.usage.currentModel))];
const label=(r:any)=>`${r.packed?'3000-token pack':'Whole relevant file'} / ${r.concise?'concise':'ordinary'}`;
const pct=(a:number,b:number)=>(100*(1-b/a)).toFixed(1);
const baseline=rows[0], pack=rows[2], combined=rows[3];
const text=`# Live Copilot measurements

Generated from [raw results](../benchmarks/live/results.json) by [summarize-live.ts](../scripts/summarize-live.ts). Experiment finished ${data.createdAt}. Actual model(s): **${models.join(', ')}**. Four fresh questions × four arms = ${data.results.length} independent sessions. See [protocol and limitations](EVALUATION.md#live-copilot-comparison).

| Arm | Requested facts correct | Provider input incl. cache | Provider output incl. reasoning | Reasoning subset | Visible answer, o200k | Raw totalNanoAiu |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.map(r=>`| ${label(r)} | ${r.correct}/${r.n} | ${r.input} | ${r.output} | ${r.reasoning} | ${r.visibleO200k} | ${r.nanoAiu} |`).join('\n')}

With ordinary answer instructions held constant, packed context used **${pct(baseline.input,pack.input)}% fewer provider input tokens**, **${pct(baseline.output,pack.output)}% fewer provider output tokens**, and **${pct(baseline.nanoAiu,pack.nanoAiu)}% less reported totalNanoAiu** than the oracle-selected whole-file baseline. All four requested fact checks passed in both arms. This is a small observed comparison, not a guaranteed future saving.

The combined pack + concise arm used ${pct(baseline.input,combined.input)}% fewer input tokens, but provider output ${combined.output>baseline.output?'increased':'decreased'} by ${Math.abs(Number(pct(baseline.output,combined.output))).toFixed(1)}% relative to whole-file / ordinary. Its reported totalNanoAiu was ${pct(baseline.nanoAiu,combined.nanoAiu)}% lower. Concise wording **did not reliably reduce billed output** in this experiment: in the packed arm, it increased counted reasoning/output despite a shorter visible answer. Do not hide this negative result or treat output brevity as equivalent to billing savings.

All calls reported zero cache-read tokens. Almost all input was recorded as cache-write tokens, with three ordinary input tokens per call. The table includes both categories rather than presenting only the tiny uncached input field. Hidden CLI/system context remains included. Raw totalNanoAiu is a provider usage field; no undocumented conversion to displayed credits or money is made here. Equal model and cache categories support a within-run relative comparison, not a billing guarantee.

The 16/16 fact checks cover four simple randomized-value questions, not 16 independent repository tasks. The model saw fresh constants but the task templates were authored by the implementer. Some generated line citations are imprecise; exact-string grading does not validate citations. No file edits, multi-step debugging, tool selection, retry cost, or additional expansion calls were evaluated. Auto routing was requested, so future runs may select other models. No failed response was excluded and no retrieval parameter was tuned on these results.
`;
await writeFile('docs/LIVE_RESULTS.md',text);
await writeFile('benchmarks/live/summary.json',JSON.stringify({models,rows},null,2)+'\n');
console.log(text);
