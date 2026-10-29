import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readdir,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/repository.js';
import { SemanticIndex } from '../src/semantic.js';
test('semantic cache stores vectors, refreshes changed source and model digests',async t=>{
  const root=await mkdtemp(join(tmpdir(),'reposqueeze-embed-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'a.py'),'def calculate_total(items):\n    return sum(items)\n');
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let digest='model-v1',embedded=0;
  globalThis.fetch=async (url,options)=>{
    assert(String(url).startsWith('http://127.0.0.1:11434/'));
    if(String(url).endsWith('/api/tags'))return new Response(JSON.stringify({models:[{name:'fixture:latest',digest}]}));
    const body=JSON.parse(String(options?.body));embedded+=body.input.length;
    return new Response(JSON.stringify({embeddings:body.input.map(()=>[0.5,0.75,0.1])}));
  };
  const repo=new Repository(root);const index=new SemanticIndex('fixture');const s=await repo.snapshot();
  const a=await index.scores(s,'total');assert(a.size>0);const first=embedded;
  await index.scores(s,'total');assert.equal(embedded,first+1,'unchanged document vectors should be reused; query is fresh');
  const files=await readdir(join(root,'.reposqueeze'));const stored=await readFile(join(root,'.reposqueeze',files[0]),'utf8');assert(!stored.includes('calculate_total'));assert(!stored.includes('return sum'));
  await writeFile(join(root,'a.py'),'def calculate_total(items):\n    return 0\n');const next=await repo.snapshot();
  const changed=await index.scores(next,'total');assert([...changed.keys()].every(k=>!a.has(k)));
  digest='model-v2';const before=embedded;await index.scores(next,'total');assert(embedded>before+1);
});
test('semantic cache refuses symlink directory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'reposqueeze-link-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>new Response(JSON.stringify({models:[{name:'fixture:latest',digest:'x'}]}));
  await symlink(tmpdir(),join(root,'.reposqueeze'));
  await assert.rejects(()=>new SemanticIndex('fixture').scores({root,files:[],chunks:[],revision:'x',skipped:0,truncated:false,warnings:[],elapsedMs:0},'x'),/symlink/);
});
