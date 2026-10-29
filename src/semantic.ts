import { readFile, writeFile, mkdir, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from './parser.js';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from './types.js';

// Explicit opt-in. Code is sent only to this loopback Ollama instance.
const endpoint = 'http://127.0.0.1:11434/api/embed';
function validVector(v: unknown): v is number[] { return Array.isArray(v) && v.length>0 && v.length<=16384 && v.every(n=>typeof n==='number' && Number.isFinite(n)); }
function cosine(a: number[], b: number[]) {
  if (a.length!==b.length) throw new Error('Embedding dimensions changed; clear .reposqueeze and reindex');
  let dot=0,aa=0,bb=0;
  for(let i=0;i<a.length;i++) {dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  return aa && bb ? dot/Math.sqrt(aa*bb) : 0;
}
export class SemanticIndex {
  constructor(readonly model: string) { if(!model || model.length>200) throw new Error('Invalid embedding model'); }
  private async embed(input: string[]): Promise<number[][]> {
    const response = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:this.model,input,truncate:true}),signal:AbortSignal.timeout(120000),redirect:'error'});
    if(!response.ok) throw new Error(`Local Ollama embeddings failed (${response.status}). Install the selected embedding model or disable semantic mode.`);
    const body=await response.json() as {embeddings?:unknown[]};
    if(!Array.isArray(body.embeddings) || body.embeddings.length!==input.length || !body.embeddings.every(validVector)) throw new Error('Invalid embedding response');
    return body.embeddings as number[][];
  }
  async scores(s: Snapshot, query: string): Promise<Map<string,number>> {
    const response=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok) throw new Error('Cannot identify local embedding model');
    const tags=await response.json() as {models?:{name:string;model?:string;digest?:string}[]};
    const identity=tags.models?.find(m=>m.name===this.model || m.name===`${this.model}:latest` || m.model===this.model)?.digest;
    if(!identity) throw new Error('Install the embedding model in local Ollama before enabling semantic retrieval');
    const dir=join(s.root,'.reposqueeze');
    try { if((await lstat(dir)).isSymbolicLink()) throw new Error('Refusing symlinked semantic cache'); } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    await mkdir(dir,{recursive:true,mode:0o700});
    const file=join(dir,`embeddings-${hash(this.model+identity).slice(0,16)}.json`);
    let cache: Record<string,number[]>={};
    try {
      const stat=await lstat(file); if(stat.isSymbolicLink() || stat.size>128*1024*1024) throw new Error('Unsafe semantic cache');
      const parsed=JSON.parse(await readFile(file,'utf8'));
      if(parsed.model===this.model && parsed.identity===identity && parsed.version===1 && parsed.vectors && typeof parsed.vectors==='object') cache=parsed.vectors;
    } catch(e) { if((e as Error).message==='Unsafe semantic cache') throw e; }
    const chunks=s.chunks.slice(0,6000);
    if(s.chunks.length>chunks.length) s.warnings.push('Semantic index capped at 6000 chunks; lexical search still covers the scanned corpus.');
    const missing=chunks.filter(c=>!validVector(cache[c.id]));
    for(let i=0;i<missing.length;i+=24) {
      const batch=missing.slice(i,i+24);
      const vectors=await this.embed(batch.map(c=>`${c.path}\n${c.name}\n${c.text.slice(0,6000)}`));
      batch.forEach((c,j)=>{cache[c.id]=vectors[j];});
    }
    // Retain only current content hashes; deleted or edited code cannot be recalled as current.
    const vectors=Object.fromEntries(chunks.map(c=>[c.id,cache[c.id]]));
    const tmp=`${file}.${randomUUID()}.tmp`;
    await writeFile(tmp,JSON.stringify({version:1,model:this.model,identity,revision:s.revision,vectors}),{mode:0o600,flag:'wx'});
    await rename(tmp,file);
    const [q]=await this.embed([query]);
    return new Map(chunks.map(c=>[c.id,cosine(q,cache[c.id])]));
  }
}
