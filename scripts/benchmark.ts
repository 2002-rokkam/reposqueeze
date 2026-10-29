import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Repository } from '../src/repository.js';
import { contextPack, DEFAULTS, type Settings } from '../src/context.js';
import { SemanticIndex } from '../src/semantic.js';
import { tokens } from '../src/tokens.js';
import type { Snapshot, Pack } from '../src/types.js';

interface Task {repo:string;query:string;gold:{path:string;needle:string}[]}
const phase=process.argv[2]??'development';
if(!['development','test'].includes(phase)) throw new Error('Choose development or test');
const semanticModel=process.env.REPOSQUEEZE_BENCH_EMBEDDING;
const repos=JSON.parse(await readFile('benchmarks/lock.json','utf8')) as {name:string;split:string;sha:string}[];
const tasks=JSON.parse(await readFile('benchmarks/tasks.json','utf8')) as Task[];
const sourceHash=createHash('sha256');
for(const file of ['src/context.ts','src/parser.ts','src/repository.ts','src/semantic.ts','src/engine.ts','package-lock.json','benchmarks/tasks.json','benchmarks/lock.json']) sourceHash.update(await readFile(file));
const fingerprint=sourceHash.digest('hex');
const variants:Record<string,Settings>={bm25:{graphWeight:0,symbolWeight:0,diversity:0},structural:DEFAULTS,no_graph:{...DEFAULTS,graphWeight:0}};
if(phase==='test') {
  const frozen=JSON.parse(await readFile('benchmarks/frozen.json','utf8'));
  if(frozen.fingerprint!==fingerprint) throw new Error('Source or tasks changed after development freeze; rerun development before opening test results. Do not tune after test evaluation.');
}
const rows:Record<string,unknown>[]=[];
const budgets=[1500,3000];
for(const repo of repos.filter(r=>r.split===phase)) {
  console.log(`Indexing ${repo.name} (${phase})`);
  const snapshot=await new Repository(`.bench-repos/${repo.name}`).snapshot();
  const rtasks=tasks.filter(t=>t.repo===repo.name);
  for(const task of rtasks) {
    // Validate labels against the pinned input, never silently discard a failing task.
    for(const gold of task.gold) {
      const f=snapshot.files.find(f=>f.path===gold.path);
      if(!f?.text.includes(gold.needle)) throw new Error(`Invalid gold label ${repo.name} ${gold.path}: ${gold.needle}`);
    }
    const scores=semanticModel ? await new SemanticIndex(semanticModel).scores(snapshot,task.query) : undefined;
    for(const budget of budgets) {
      for(const [name,settings] of Object.entries(variants)) rows.push(evaluate(snapshot,task,budget,name,settings));
      if(scores) rows.push(evaluate(snapshot,task,budget,'hybrid',DEFAULTS,scores));
    }
    console.log(`${repo.name}: ${task.query}`);
  }
}
function evaluate(s:Snapshot,t:Task,budget:number,variant:string,settings:Settings,scores?:Map<string,number>) {
  const started=performance.now();const pack=contextPack(s,t.query,budget,settings,[],scores);
  const hits=t.gold.filter(g=>pack.evidence.some(e=>e.path===g.path && s.files.find(f=>f.path===e.path)!.text.split('\n').slice(e.start-1,e.end).join('\n').includes(g.needle))).length;
  // Verify the actual serialized excerpts against source, not just the metadata.
  const faithful=pack.evidence.every(e=>pack.text.includes(`id=${e.id} ---\n${s.files.find(f=>f.path===e.path)!.text.split('\n').slice(e.start-1,e.end).join('\n')}\n--- END SOURCE ---`));
  if(tokens(pack.text)>budget || !faithful) throw new Error(`Budget/fidelity invariant failed for ${t.query}`);
  return {repo:t.repo,query:t.query,budget,variant,evidenceRecall:hits/t.gold.length,allEvidenceFound:hits===t.gold.length,faithful,inputTokens:pack.stats.inputTokens,outputTokens:pack.stats.outputTokens,reduction:pack.stats.reduction,elapsedMs:performance.now()-started,paths:[...new Set(pack.evidence.map(e=>e.path))]};
}
const groups=[];
for(const variant of [...Object.keys(variants),...(semanticModel?['hybrid']:[])]) for(const budget of budgets) {
  const subset=rows.filter(r=>r.variant===variant && r.budget===budget);
  const sum=(key:string)=>subset.reduce((a,r)=>a+Number(r[key]),0);
  groups.push({variant,budget,tasks:subset.length,completeEvidenceRate:sum('allEvidenceFound')/subset.length,meanEvidenceRecall:sum('evidenceRecall')/subset.length,inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),weightedReduction:1-sum('outputTokens')/sum('inputTokens'),meanQueryMs:sum('elapsedMs')/subset.length});
}
const report={phase,protocol:'80:20 repository-disjoint development/test. Hand-authored source-location questions; evidence recall is NOT answer accuracy. Baseline is full indexed repo, not optimized Copilot. Equal-budget BM25 and no-graph ablations included.',fingerprint,settings:DEFAULTS,semanticModel:semanticModel??null,repoCount:new Set(rows.map(r=>r.repo)).size,groups,rows};
await writeFile(`benchmarks/${phase}.json`,JSON.stringify(report,null,2)+'\n');
if(phase==='development') await writeFile('benchmarks/frozen.json',JSON.stringify({fingerprint,settings:DEFAULTS,budgets,semanticModel:semanticModel??null,rule:'No retuning after test results. BM25 is an equal-budget ablation, not an external competitor run.'},null,2)+'\n');
console.log(JSON.stringify(groups,null,2));
