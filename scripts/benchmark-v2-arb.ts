import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { rank } from '../src/context.js';
import { hash,terms } from '../src/parser.js';
import { rankV2 } from '../src/v2.js';
import { tokens } from '../src/tokens.js';
import type { Chunk,Snapshot,SourceFile } from '../src/types.js';

const root=process.env.ARB_TRACE_ROOT ?? '/private/tmp/arb-trace';
const phase=process.argv[2];
if(!['development','test'].includes(phase))throw Error('Choose development or test');
const samplePath=resolve(root,'benchmark/v2_trace2code/samples.jsonl');
const manifestPath=resolve(root,'corpus/v2_trace2code/corpus_manifest.jsonl');
const rows=(await readFile(samplePath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const manifests=(await readFile(manifestPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const manifest=new Map(manifests.map(row=>[`${row.repo}\0${row.base_commit}`,resolve(root,row.chunks_path.replace(/^data\//,''))]));
// Deterministic 80:20 split by opaque sample id. It is sample-level, not repository-disjoint.
const ordered=[...rows].sort((a,b)=>a.id.localeCompare(b.id));
const cut=Math.floor(ordered.length*0.8);
const selected=new Set((phase==='development'?ordered.slice(0,cut):ordered.slice(cut)).map(x=>x.id));
const sourceFiles=['src/v2.ts','src/context.ts','src/parser.ts','scripts/benchmark-v2-arb.ts'];
const fingerprint=createHash('sha256');for(const file of sourceFiles)fingerprint.update(await readFile(file));
fingerprint.update(await readFile('/private/tmp/arb-trace/trace.sha256'));
const fingerprintHex=fingerprint.digest('hex');
if(phase==='test') {
  const frozen=JSON.parse(await readFile('benchmarks/v2-freeze.json','utf8'));
  if(frozen.fingerprint!==fingerprintHex)throw Error('V2 technique or evaluator changed after development freeze');
}
function queryText(sample:any){return JSON.stringify(sample.query,Object.keys(sample.query).sort());}
function perturb(query:string,kind:string){
  if(kind==='original')return query;
  if(kind==='dropout')return query.split(/\s+/).filter((_,i)=>i%5!==1).join(' ');
  if(kind==='no-command')return query.replace(/"command":"[^"]*",?/,'');
  const lines=query.split('\\n');return [...lines.filter((_,i)=>i%2),...lines.filter((_,i)=>i%2===0)].join('\\n');
}
function makeSnapshot(records:any[]):Snapshot {
  const chunks:Chunk[]=records.map(row=>({id:row.chunk_id,path:row.path,start:row.start_line,end:row.end_line,name:row.symbol??'',kind:row.kind??'chunk',text:row.text,terms:terms(`${row.path} ${row.symbol??''} ${row.text}`),refs:[]}));
  const byPath=new Map<string,Chunk[]>();for(const chunk of chunks)byPath.set(chunk.path,[...(byPath.get(chunk.path)??[]),chunk]);
  const files:SourceFile[]=[...byPath].map(([path,cs])=>{const best=[...cs].sort((a,b)=>(b.end-b.start)-(a.end-a.start))[0];return {path,text:best.text,hash:hash(best.text),language:'text',chunks:cs,parsed:false}});
  return {files,chunks,revision:hash(chunks.map(c=>c.id).join('')).slice(0,16),skipped:0,truncated:false,warnings:[],root:'ARB prebuilt corpus',elapsedMs:0};
}
function fileRanking(ranked:{chunk:Chunk;score:number}[]){const out:string[]=[];const seen=new Set<string>();for(const row of ranked)if(!seen.has(row.chunk.path)){seen.add(row.chunk.path);out.push(row.chunk.path);}return out;}
function intervalOverlap(a:number,b:number,c:number,d:number){return Math.max(0,Math.min(b,d)-Math.max(a,c)+1)}
const tokenCosts=new WeakMap<Chunk,number>();
function pack(ranked:{chunk:Chunk;score:number}[],budget=4000){const out:Chunk[]=[];const spans=new Map<string,[number,number][]>();let used=0;for(const {chunk} of ranked){const prior=spans.get(chunk.path)??[];if(prior.some(([a,b])=>intervalOverlap(a,b,chunk.start,chunk.end)/(chunk.end-chunk.start+1)>.5))continue;let cost=tokenCosts.get(chunk);if(cost===undefined){cost=tokens(`${chunk.path}:${chunk.start}-${chunk.end}\n${chunk.text}\n`);tokenCosts.set(chunk,cost);}if(used+cost>budget)continue;out.push(chunk);used+=cost;spans.set(chunk.path,[...prior,[chunk.start,chunk.end]]);if(out.length>=40)break;}return {chunks:out,tokens:used};}
function metrics(sample:any,ranked:{chunk:Chunk;score:number}[]){
  const gold=(sample.gold.root_cause_files??[]) as string[],hard=(sample.hard_negative_files??[]) as string[];
  const files=fileRanking(ranked),ranks=gold.map(path=>files.indexOf(path)+1).filter(Boolean);
  const packed=pack(ranked),goldSpans=sample.gold_spans??[];
  let goldLines=0,predLines=packed.chunks.reduce((n,c)=>n+c.end-c.start+1,0),overlap=0;
  for(const span of goldSpans){goldLines+=span.end_line-span.start_line+1;for(const c of packed.chunks)if(c.path===span.path)overlap+=intervalOverlap(c.start,c.end,span.start_line,span.end_line);}
  return {mrr:ranks.length?1/Math.min(...ranks):0,any5:ranks.some(r=>r<=5),any10:ranks.some(r=>r<=10),any20:ranks.some(r=>r<=20),recall20:gold.length?gold.filter(path=>files.slice(0,20).includes(path)).length/gold.length:0,hardNegative5:hard.some(path=>files.slice(0,5).includes(path)),lineRecall:goldLines?Math.min(overlap,goldLines)/goldLines:0,linePrecision:predLines?Math.min(overlap,predLines)/predLines:0,packedTokens:packed.tokens};
}
const details:any[]=[];let current='';let snapshot:Snapshot|undefined;
for(const sample of rows.filter(row=>selected.has(row.id))){
  const key=`${sample.repo}\0${sample.base_commit}`;
  if(key!==current){const path=manifest.get(key);if(!path)throw Error(`Missing corpus ${key}`);const records=(await readFile(path,'utf8')).trim().split('\n').map(line=>JSON.parse(line));snapshot=makeSnapshot(records);current=key;}
  for(const kind of ['original','dropout','no-command','line-order']){
    const query=perturb(queryText(sample),kind);
    for(const variant of ['v1','v2-pcr']){
      const ranked=variant==='v1'?rank(snapshot!,query):rankV2(snapshot!,query);
      details.push({sampleId:sample.id,repo:sample.repo,kind,variant,...metrics(sample,ranked)});
    }
  }
}
const groups=[];for(const variant of ['v1','v2-pcr'])for(const kind of ['original','dropout','no-command','line-order','all']){
  const s=details.filter(row=>row.variant===variant&&(kind==='all'||row.kind===kind));const mean=(key:string)=>s.reduce((a,r)=>a+Number(r[key]),0)/s.length;
  groups.push({variant,kind,n:s.length,mrr:mean('mrr'),any5:mean('any5'),any10:mean('any10'),any20:mean('any20'),recall20:mean('recall20'),hardNegative5:mean('hardNegative5'),lineRecall4k:mean('lineRecall'),linePrecision4k:mean('linePrecision'),meanPackedTokens:mean('packedTokens')});
}
const report={phase,protocol:'Official ARB v2 trace2code corpus. Deterministic sample-level 80:20 split. Original plus three query perturbations. Equal rank/4k budgets. No embedding model. First two dataset rows were inspected during evaluator development; metrics were not seen before freeze.',fingerprint:fingerprintHex,arbArchiveSha256:(await readFile('/private/tmp/arb-trace/trace.sha256','utf8')).trim().split(/\s+/)[0],groups,details};
await writeFile(`benchmarks/v2-arb-${phase}.json`,JSON.stringify(report,null,2)+'\n');
if(phase==='development')await writeFile('benchmarks/v2-freeze.json',JSON.stringify({fingerprint:fingerprintHex,rule:'No code, weights, query views, or evaluator changes after development; test run must match exactly.',developmentSamples:selected.size,testSamples:rows.length-selected.size},null,2)+'\n');
console.log(JSON.stringify(groups,null,2));
