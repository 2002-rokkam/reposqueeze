import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Repository, allowedPath } from '../src/repository.js';
import { contextPack, expand, repositoryMap, DEFAULTS } from '../src/context.js';
import { parseSource } from '../src/parser.js';
import { tokens } from '../src/tokens.js';
import { compactLog } from '../src/compact.js';
import { compactJson } from '../src/structured.js';
import { decode } from '@toon-format/toon';

async function fixture(t: TestContext, files:Record<string,string>) {
  const root=await mkdtemp(join(tmpdir(),'reposqueeze-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const [path,text] of Object.entries(files)) {await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),text);}
  return root;
}
test('excludes ignored, secret, binary and symlinked files in non-git repositories',async t=>{
  const root=await fixture(t,{'.gitignore':'ignored/\n','src/.gitignore':'local.ts\n','.reposqueezeignore':'custom.txt\n','main.ts':'export const publicValue=3;','ignored/private.ts':'do not index','src/local.ts':'private','custom.txt':'private','.env':'SECRET=123','key.pem':'private','data.bin':'abc\0xyz','secret-inline.ts':'const api_key="abcdefghijklmnopqrstuvwxyz0123456789";'});
  await symlink('/etc/passwd',join(root,'outside.txt'));
  await symlink(join(root,'main.ts'),join(root,'alias.ts'));
  const s=await new Repository(root).snapshot();
  assert(s.files.some(f=>f.path==='main.ts'));
  for(const p of ['ignored/private.ts','src/local.ts','custom.txt','.env','key.pem','data.bin','secret-inline.ts','outside.txt','alias.ts']) assert(!s.files.some(f=>f.path===p),p);
});
test('git scan includes untracked files, excludes tracked secrets, works in subdirectory',async t=>{
  const root=await fixture(t,{'.gitignore':'ignored.txt\n','main.py':'def alpha():\n    return 1\n','sub/feature.py':'def beta():\n    return 2\n','.env':'secret','ignored.txt':'secret'});
  execFileSync('git',['init','-q',root]);
  execFileSync('git',['add','main.py','.env'],{cwd:root});
  const s=await new Repository(root).snapshot();
  assert(s.files.some(f=>f.path==='sub/feature.py'));assert(!s.files.some(f=>f.path==='.env'));
  const sub=await new Repository(join(root,'sub')).snapshot();
  assert.deepEqual(sub.files.map(f=>f.path),['feature.py']);
});
test('content hash invalidates cache after edits and removes deleted source',async t=>{
  const root=await fixture(t,{'a.py':'def add(a,b):\n    return a+b\n'});
  const repo=new Repository(root);const first=await repo.snapshot();
  await writeFile(join(root,'a.py'),'def add(a,b):\n    return a-b\n');
  const second=await repo.snapshot();assert.notEqual(first.revision,second.revision);assert.match(second.files[0].text,/a-b/);
  await rm(join(root,'a.py'));assert.equal((await repo.snapshot()).files.length,0);
});
const languages:Record<string,string>={
  'a.ts':'export function greet(name: string) {\n return name;\n}',
  'a.tsx':'export function View() {\n return <div>Hello</div>;\n}',
  'a.js':'function greet(name) {\n return name;\n}',
  'a.py':'def greet(name):\n    return name\n',
  'a.go':'package main\nfunc greet(name string) string {\n return name\n}',
  'a.rs':'fn greet(name: &str) -> &str {\n name\n}',
  'A.java':'class A {\n public String greet(String name) {\n return name;\n }\n}',
  'a.c':'int greet(int x) {\n return x;\n}',
  'a.cpp':'int greet(int x) {\n return x;\n}',
  'A.cs':'class A {\n public int Greet(int x) {\n return x;\n }\n}',
  'a.rb':'def greet(name)\n name\nend\n'
};
for(const [path,source] of Object.entries(languages)) test(`AST grammar loads and preserves source: ${path}`,async()=>{
  const parsed=await parseSource(path,source);assert(parsed.parsed,path);assert(parsed.chunks.some(c=>c.kind!=='window'),path);
  for(const c of parsed.chunks) assert.equal(c.text,source.split('\n').slice(c.start-1,c.end).join('\n'));
});
test('parse errors and unknown languages still retain searchable windows',async()=>{
  for(const path of ['invalid.py','code.custom']) {const p=await parseSource(path,'def invalid(:\nuniqueBoundary=42\n');assert(p.chunks.some(c=>c.text.includes('uniqueBoundary')));assert(!p.parsed);}
});
test('packs meet all budgets; every cited excerpt is verbatim and receipts cover actual ranges',async t=>{
  const root=await fixture(t,{'src/auth.ts':Array.from({length:180},(_,i)=>`// auth permission check ${i}`).join('\n'),'unrelated.py':'def weather():\n    return "sunny"\n'});
  const s=await new Repository(root).snapshot();
  for(const budget of [256,512,1000,3000]) {
    const pack=contextPack(s,'auth permission check',budget);assert(tokens(pack.text)<=budget);assert.equal(tokens(pack.text),pack.stats.outputTokens);
    for(const e of pack.evidence) {
      const raw=s.files.find(f=>f.path===e.path)!.text.split('\n').slice(e.start-1,e.end).join('\n');
      assert(pack.text.includes(`id=${e.id} ---\n${raw}\n--- END SOURCE ---`));
    }
  }
});
test('partial receipts never allow full unseen definitions to be suppressed',async t=>{
  const root=await fixture(t,{'a.ts':'function auth() {\n'+Array.from({length:80},(_,i)=>`  console.log("permission ${i}");`).join('\n')+'\n}'});
  const s=await new Repository(root).snapshot();const small=contextPack(s,'auth',256);
  const big=contextPack(s,'auth',3000,DEFAULTS,small.evidence.map(e=>e.id));
  assert(big.text.includes('permission 79'));assert(!big.text.includes('Previously supplied evidence'));
});
test('explicit known full receipts save repeat source and changed source is resent',async t=>{
  const root=await fixture(t,{'a.py':'def permission_check(user):\n    return user.is_admin\n'});const repo=new Repository(root);const s=await repo.snapshot();
  const first=contextPack(s,'permission_check',1000);const again=contextPack(s,'permission_check',1000,DEFAULTS,first.evidence.map(e=>e.id));
  assert(again.text.includes('Previously supplied evidence'));assert(!again.text.includes('return user.is_admin'));
  await writeFile(join(root,'a.py'),'def permission_check(user):\n    return False\n');
  const changed=contextPack(await repo.snapshot(),'permission_check',1000,DEFAULTS,first.evidence.map(e=>e.id));assert(changed.text.includes('return False'));
});
test('expansion rejects traversal and excluded paths, reports truncation',async t=>{
  const root=await fixture(t,{'a.ts':Array.from({length:400},(_,i)=>`line ${i} record`).join('\n')});const s=await new Repository(root).snapshot();
  for(const path of ['../outside','/etc/passwd','.env','a.ts/../x','a\\b']) assert.throws(()=>expand(s,path,1,5));
  assert.throws(()=>expand(s,'a.ts',0,3));assert.throws(()=>expand(s,'a.ts',999,1000));
  const text=expand(s,'a.ts',1,400,256);assert(tokens(text)<=256);assert.match(text,/Omitted requested lines/);
  assert(tokens(repositoryMap(s,256))<=256);
});
test('tokens accept literal special-token spellings and Unicode',()=>{assert(tokens('<|endoftext|> café 测试 🧪')>0);});
test('log folding retains errors and counts repeated lines',()=>{
  const input='PASS ok\n'.repeat(500)+'ERROR expected 42 actual 41\nexit 1';const out=compactLog(input,256);
  assert.match(out.text,/expected 42 actual 41/);assert.match(out.text,/500 times/);assert(out.stats.outputTokens<out.stats.inputTokens);
});
test('lossy logs explicitly declare omissions and respect budget',()=>{
  const input=Array.from({length:1000},(_,i)=>`unique progress item ${i}`).join('\n')+'\nFAIL: sentinel failure\nexit 1';const out=compactLog(input,256);
  assert(out.stats.lossy);assert.match(out.text,/LOSSY/);assert.match(out.text,/sentinel failure/);assert(tokens(out.text)<=256);
});
test('TOON chooser preserves values across random unseen data and never grows token count',()=>{
  let seed=997;const rng=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
  for(let j=0;j<100;j++) {
    const data={records:Array.from({length:rng()%30},(_,i)=>({id:i,name:['café','a,b','x\ny','quote"','🧪'][rng()%5],enabled:!!(rng()%2),value:rng()%10000,nested:j%3?null:{a:[1,2]}}))};
    const raw=JSON.stringify(data,null,2);const c=compactJson(raw);const round=c.format==='toon'?decode(c.text.split('\n').slice(1).join('\n')):JSON.parse(c.text);
    assert.deepEqual(round,data);assert(c.stats.outputTokens<=c.stats.inputTokens);
  }
});
test('JSON conversion rejects unsafe precision, duplicate keys, and negative zero',()=>{
  for(const raw of ['{"n":123456789012345678901}','{"n":0.123456789012345678901}','{"n":-0}','{"a":1,"a":2}']) assert.throws(()=>compactJson(raw));
});
test('input limits reject invalid queries, budgets and log sizes',async t=>{
  const root=await fixture(t,{'a.py':'def f():\n    return 1\n'});const s=await new Repository(root).snapshot();
  for(const n of [0,255,32001,NaN,1.5]) assert.throws(()=>contextPack(s,'f',n));
  assert.throws(()=>contextPack(s,''));assert.throws(()=>compactLog('x'.repeat(2*1024*1024+1)));
  assert(!allowedPath('bad\npath.ts'));
});
