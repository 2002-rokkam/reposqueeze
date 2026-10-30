import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { Repository } from '../src/repository.js';
import { contextPack } from '../src/context.js';
import { contextPackV2 } from '../src/v2.js';
import type { Pack,Snapshot } from '../src/types.js';

interface Task {repo:string;query:string;gold:{path:string;needle:string}[]}
const tasks=(JSON.parse(await readFile('benchmarks/tasks.json','utf8')) as Task[]).slice(0,40);
const lock=JSON.parse(await readFile('benchmarks/lock.json','utf8')) as {name:string;sha:string;split:string}[];
const rows:any[]=[];
function perturb(query:string,kind:string) {
  if(kind==='original')return query;
  if(kind==='dropout')return query.split(/\s+/).filter((term,i)=>i%5!==1).join(' ');
  if(kind==='telegraphic')return query.replace(/\b(?:how|does|where|which|what|when|is|are|the|a|an|to|of|in|with)\b/gi,' ').replace(/\s+/g,' ').trim();
  const words=query.split(/\s+/);return [words.slice(Math.ceil(words.length/2)).join(' '),words.slice(0,Math.ceil(words.length/2)).join(' ')].join('\n');
}
function evaluate(s:Snapshot,t:Task,query:string,variant:string,budget:number,pack:Pack,perturbation:string) {
  const hits=t.gold.filter(g=>pack.evidence.some(e=>e.path===g.path&&s.files.find(f=>f.path===e.path)!.text.split('\n').slice(e.start-1,e.end).join('\n').includes(g.needle))).length;
  return {repo:t.repo,query:t.query,perturbation,variant,budget,recall:hits/t.gold.length,complete:hits===t.gold.length,tokens:pack.stats.outputTokens};
}
for(const repo of lock.filter(r=>r.split==='development')) {
  const snapshot=await new Repository(`.bench-repos/${repo.name}`).snapshot();
  for(const task of tasks.filter(t=>t.repo===repo.name))for(const kind of ['original','dropout','telegraphic','reordered']) {
    const query=perturb(task.query,kind);
    for(const budget of [1500,3000]) {
      rows.push(evaluate(snapshot,task,query,'v1',budget,contextPack(snapshot,query,budget),kind));
      rows.push(evaluate(snapshot,task,query,'v2-pcr',budget,contextPackV2(snapshot,query,budget),kind));
    }
  }
}
const groups=[];
for(const variant of ['v1','v2-pcr'])for(const budget of [1500,3000])for(const perturbation of ['original','dropout','telegraphic','reordered','all']) {
  const subset=rows.filter(r=>r.variant===variant&&r.budget===budget&&(perturbation==='all'||r.perturbation===perturbation));
  groups.push({variant,budget,perturbation,n:subset.length,completeRate:subset.reduce((a,r)=>a+Number(r.complete),0)/subset.length,meanRecall:subset.reduce((a,r)=>a+r.recall,0)/subset.length,meanTokens:subset.reduce((a,r)=>a+r.tokens,0)/subset.length});
}
const fingerprint=createHash('sha256').update(await readFile('src/v2.ts')).update(await readFile('scripts/benchmark-v2-development.ts')).update(await readFile('benchmarks/tasks.json')).update(await readFile('benchmarks/lock.json')).digest('hex');
await writeFile('benchmarks/v2-development.json',JSON.stringify({protocol:'Development-only: 40 existing questions from eight repositories, four deterministic query forms. Used to choose/freeze V2 before independent ARB trace2code evaluation.',fingerprint,groups,rows},null,2)+'\n');
console.log(JSON.stringify(groups,null,2));
