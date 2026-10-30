import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Repository } from '../src/repository.js';
import { contextPackV2, rankV2 } from '../src/v2.js';

const exec=promisify(execFile),phase=process.argv[2],root=process.env.REPOSQUEEZE_SCALE_ROOT??'/private/tmp/reposqueeze-scale-50000';
if(!['development','test'].includes(phase))throw new Error('Choose development or test');
const FILES=50_000,TASKS=100,LINES=24;
const targetFor=(task:number)=>(task*499+137)%FILES;
const filePath=(index:number)=>`packages/p${String(index%250).padStart(3,'0')}/module_${String(index).padStart(5,'0')}.ts`;
const marker=join(root,'.scale-ready');
try{await stat(marker);}catch{
  await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
  const extras=new Map<number,string[]>();
  for(let task=0;task<TASKS;task++){
    const target=targetFor(task),id=String(task).padStart(3,'0');
    extras.set(target,[...(extras.get(target)??[]),`export function nebulaCheckpoint${id}() { return "rootCause${id}"; }`,`// incident${id} rootCause${id}`]);
    for(let d=1;d<=20;d++){const distractor=(target+d*977)%FILES;extras.set(distractor,[...(extras.get(distractor)??[]),`// incident${id} observed in downstream wrapper ${d}`]);}
  }
  for(let offset=0;offset<FILES;offset+=128){
    await Promise.all(Array.from({length:Math.min(128,FILES-offset)},async(_,j)=>{
      const index=offset+j,path=join(root,filePath(index));await mkdir(join(path,'..'),{recursive:true});
      const body=[`export const moduleId${index} = ${index};`,`export function routine${index}(value: number) { return value + ${index}; }`,...(extras.get(index)??[]),...Array.from({length:LINES-2},(_,line)=>`// deterministic subsystem ${index%97} pipeline ${line} invariant`)].join('\n')+'\n';
      await writeFile(path,body);
    }));
  }
  await writeFile(join(root,'.reposqueeze-v2ignore'),'.scale-ready\n');
  await exec('git',['init','-q'],{cwd:root});await exec('git',['add','.'],{cwd:root,maxBuffer:64*1024*1024});await writeFile(marker,'50k files; deterministic scale corpus v1\n');
}
const sourceFiles=['src/scale.ts','src/repository.ts','src/v2.ts','src/context.ts','scripts/benchmark-scale.ts'];
const fingerprint=createHash('sha256');for(const file of sourceFiles)fingerprint.update(await readFile(file));
const fingerprintHex=fingerprint.digest('hex');
if(phase==='test'){
  const frozen=JSON.parse(await readFile('benchmarks/scale-freeze.json','utf8'));
  if(frozen.fingerprint!==fingerprintHex)throw new Error('Scale retrieval or evaluator changed after development freeze');
}
const selected=phase==='development'?Array.from({length:80},(_,i)=>i):Array.from({length:20},(_,i)=>i+80);
const repo=new Repository(root),rows:any[]=[];
for(const task of selected){
  const id=String(task).padStart(3,'0'),query=`FAIL incident${id}: expected nebulaCheckpoint${id} to preserve rootCause${id}`;
  const started=performance.now(),snapshot=await repo.snapshot(query),ranked=rankV2(snapshot,query),files:string[]=[];
  for(const row of ranked)if(!files.includes(row.chunk.path))files.push(row.chunk.path);
  const gold=filePath(targetFor(task)),rank=files.indexOf(gold)+1,pack=contextPackV2(snapshot,query,3000);
  rows.push({task,gold,rank,any10:rank>0&&rank<=10,any20:rank>0&&rank<=20,inPack:pack.evidence.some(e=>e.path===gold),outputTokens:pack.stats.outputTokens,totalFiles:pack.stats.files,candidateFiles:pack.stats.candidateFiles,elapsedMs:performance.now()-started,rssBytes:process.memoryUsage().rss});
  if((rows.length%10)===0)console.error(`${phase}: ${rows.length}/${selected.length}`);
}
const sorted=rows.map(row=>row.elapsedMs).sort((a,b)=>a-b),mean=(key:string)=>rows.reduce((sum,row)=>sum+Number(row[key]),0)/rows.length;
const report={phase,protocol:'Deterministic 50,000-file TypeScript repository with at least 1.2 million generated lines, 100 query/gold pairs, fixed 80:20 task split, 20 same-incident distractors per task, 3,000-token packs.',fingerprint:fingerprintHex,files:FILES,minimumLines:FILES*LINES,developmentTasks:80,testTasks:20,metrics:{any10:mean('any10'),any20:mean('any20'),inPack:mean('inPack'),meanOutputTokens:mean('outputTokens'),meanCandidateFiles:mean('candidateFiles'),meanElapsedMs:mean('elapsedMs'),medianElapsedMs:sorted[Math.floor(sorted.length/2)],p95ElapsedMs:sorted[Math.floor(sorted.length*.95)],peakRssBytes:Math.max(...rows.map(row=>row.rssBytes))},rows};
await writeFile(`benchmarks/scale-${phase}.json`,JSON.stringify(report,null,2)+'\n');
if(phase==='development')await writeFile('benchmarks/scale-freeze.json',JSON.stringify({fingerprint:fingerprintHex,rule:'No scale retrieval, PCR, packing, or evaluator changes before held-out execution.',developmentTasks:80,testTasks:20},null,2)+'\n');
console.log(JSON.stringify(report.metrics,null,2));
