import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const repos=JSON.parse(await readFile('benchmarks/repos.json','utf8'));
await mkdir('.bench-repos',{recursive:true});
const pinned = existsSync('benchmarks/lock.json') ? JSON.parse(await readFile('benchmarks/lock.json','utf8')) : [];
const lock=[];
for (const r of repos) {
  const path=`.bench-repos/${r.name}`;
  if (!existsSync(path)) execFileSync('git',['clone','--quiet','--depth','1','--branch',r.ref,`https://github.com/${r.repo}.git`,path],{stdio:'inherit'});
  const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:path,encoding:'utf8'}).trim();
  const expected=pinned.find(p=>p.name===r.name)?.sha;
  if (expected && expected!==sha) throw new Error(`Pinned SHA mismatch for ${r.name}: ${sha} != ${expected}`);
  lock.push({...r,sha});
  console.log(`${r.name} ${r.split} ${sha}`);
}
await writeFile('benchmarks/lock.json',JSON.stringify(lock,null,2)+'\n');
