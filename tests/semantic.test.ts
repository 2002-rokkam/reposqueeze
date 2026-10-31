import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readdir,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/repository.js';
import { SemanticIndex } from '../src/semantic.js';
import { summarizeCache } from '../src/store.js';

// Semantic vectors live in the repository's cache directory (not inside the repository): point it at a temp dir.
async function cacheEnv(t: TestContext,value?: string) {
  const dir=value ?? await mkdtemp(join(tmpdir(),'reposqueeze-embed-cache-'));
  const saved=process.env.REPOSQUEEZE_CACHE_DIR;process.env.REPOSQUEEZE_CACHE_DIR=dir;
  t.after(async()=>{if(saved===undefined)delete process.env.REPOSQUEEZE_CACHE_DIR;else process.env.REPOSQUEEZE_CACHE_DIR=saved;if(!value)await rm(dir,{recursive:true,force:true});});
}
test('semantic cache stores vectors, refreshes changed source and model digests',async t=>{
  await cacheEnv(t);
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
  const cacheDirectory=(await summarizeCache(root)).path!;
  const files=(await readdir(cacheDirectory)).filter(name=>name.startsWith('embeddings-'));assert.equal(files.length,1);
  assert(!(await readdir(root)).includes('.reposqueeze-v2'),'the repository working tree is not written to');
  const stored=await readFile(join(cacheDirectory,files[0]),'utf8');assert(!stored.includes('calculate_total'));assert(!stored.includes('return sum'));
  await writeFile(join(root,'a.py'),'def calculate_total(items):\n    return 0\n');const next=await repo.snapshot();
  const changed=await index.scores(next,'total');assert([...changed.keys()].every(k=>!a.has(k)));
  digest='model-v2';const before=embedded;await index.scores(next,'total');assert(embedded>before+1);
});
test('semantic cache refuses symlink directory',async t=>{
  await cacheEnv(t,'repo'); // legacy in-repository location, where a planted symlink must be refused
  const root=await mkdtemp(join(tmpdir(),'reposqueeze-link-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>new Response(JSON.stringify({models:[{name:'fixture:latest',digest:'x'}]}));
  await symlink(tmpdir(),join(root,'.reposqueeze-v2'));
  await assert.rejects(()=>new SemanticIndex('fixture').scores({root,files:[],chunks:[],revision:'x',skipped:0,truncated:false,warnings:[],elapsedMs:0},'x'),/symlink/);
});
test('semantic scores embed only the supplied lexical candidates and default to a bounded prefix',async t=>{
  await cacheEnv(t);
  const root=await mkdtemp(join(tmpdir(),'reposqueeze-embed-candidates-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(let i=0;i<8;i++)await writeFile(join(root,`m${i}.py`),`def handler_${i}(x):\n    return x + ${i}\n`);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let embedded=0;
  globalThis.fetch=async (url,options)=>{
    if(String(url).endsWith('/api/tags'))return new Response(JSON.stringify({models:[{name:'fixture:latest',digest:'d'}]}));
    const body=JSON.parse(String(options?.body));embedded+=body.input.length;
    return new Response(JSON.stringify({embeddings:body.input.map(()=>[0.5,0.75,0.1])}));
  };
  const s=await new Repository(root).snapshot();
  const picked=s.chunks.filter(c=>c.path==='m3.py'||c.path==='m5.py');assert(picked.length>=2);
  const scores=await new SemanticIndex('fixture').scores(s,'handler',picked);
  assert.deepEqual([...scores.keys()].sort(),picked.map(c=>c.id).sort());
  assert.equal(embedded,picked.length+1,'only the candidates and the query are embedded');
  assert(s.warnings.some(w=>/strongest lexical candidates/.test(w)));
  embedded=0;
  const all=await new SemanticIndex('fixture').scores(await new Repository(root).snapshot(),'handler');
  assert.equal(all.size,s.chunks.length);
  assert.equal(embedded,s.chunks.length-picked.length+1,'vectors cached for the candidates are reused');
});
