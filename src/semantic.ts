import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hash } from './parser.js';
import { CacheStore } from './store.js';
import type { Chunk, Snapshot } from './types.js';

// Explicit opt-in. Code is sent only to this loopback Ollama instance.
const endpoint = 'http://127.0.0.1:11434/api/embed';
const DEFAULT_CHUNK_CAP = 6000;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
function validVector(v: unknown): v is number[] { return Array.isArray(v) && v.length>0 && v.length<=16384 && v.every(n=>typeof n==='number' && Number.isFinite(n)); }
function cosine(a: number[], b: number[]) {
  if (a.length!==b.length) throw new Error('Embedding dimensions changed; clear the RepoSqueeze cache and reindex');
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

  /**
   * Cosine similarity of the query to each candidate chunk (default: the first 6000 chunks). Pass the strongest
   * lexical candidates so the embedded set is the one that can change the ranking.
   * Vectors are cached in the repository's cache directory, keyed by chunk content id and embedding model identity.
   */
  async scores(s: Snapshot, query: string, candidates?: Chunk[]): Promise<Map<string,number>> {
    const response=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok) throw new Error('Cannot identify local embedding model');
    const tags=await response.json() as {models?:{name:string;model?:string;digest?:string}[]};
    const identity=tags.models?.find(m=>m.name===this.model || m.name===`${this.model}:latest` || m.model===this.model)?.digest;
    if(!identity) throw new Error('Install the embedding model in local Ollama before enabling semantic retrieval');
    const store=new CacheStore(await realpath(resolve(s.root)).catch(()=>resolve(s.root)));
    if(store.dir) {
      try { if((await lstat(store.dir)).isSymbolicLink()) throw new Error('Refusing symlinked semantic cache'); } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    }
    const name=`embeddings-${hash(this.model+identity).slice(0,16)}.json`;
    let cache: Record<string,number[]>={};
    const stored=await store.read(name,MAX_CACHE_BYTES);
    if(stored) {
      try {
        const parsed=JSON.parse(stored.toString('utf8'));
        if(parsed.model===this.model && parsed.identity===identity && parsed.version===1 && parsed.vectors && typeof parsed.vectors==='object') cache=parsed.vectors;
      } catch { /* unreadable cache: re-embed */ }
    }
    const chunks=candidates ?? s.chunks.slice(0,DEFAULT_CHUNK_CAP);
    if(!candidates && s.chunks.length>chunks.length) s.warnings.push(`Semantic index capped at ${DEFAULT_CHUNK_CAP} chunks; lexical search still covers the scanned corpus.`);
    if(candidates) s.warnings.push(`Semantic scores cover the ${chunks.length} strongest lexical candidates only.`);
    const missing=chunks.filter(c=>!validVector(cache[c.id]));
    for(let i=0;i<missing.length;i+=24) {
      const batch=missing.slice(i,i+24);
      const vectors=await this.embed(batch.map(c=>`${c.path}\n${c.name}\n${c.text.slice(0,6000)}`));
      batch.forEach((c,j)=>{cache[c.id]=vectors[j];});
    }
    // Retain only vectors of chunks that exist in the current snapshot; deleted or edited code cannot be recalled as current.
    const current=new Set(s.chunks.map(c=>c.id));
    const vectors: Record<string,number[]>={};
    for(const [id,vector] of Object.entries(cache)) if(current.has(id) && validVector(vector)) vectors[id]=vector;
    if(store.enabled) await store.write(name,[Buffer.from(JSON.stringify({version:1,model:this.model,identity,revision:s.revision,vectors}))]);
    const [q]=await this.embed([query]);
    return new Map(chunks.map(c=>[c.id,cosine(q,cache[c.id])]));
  }
}
