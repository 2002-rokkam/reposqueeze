import { contextPack, rank, DEFAULTS, type Settings } from './context.js';
import { hash, terms } from './parser.js';
import type { Chunk, Snapshot } from './types.js';
import type { Pack } from './types.js';

export interface V2Ranked { chunk: Chunk; score: number; stability: number; obligations: string[] }

// Perturbation-consensus retrieval (PCR): rank several deterministic views of the
// same request and reward evidence that remains useful when wording is removed.
// It has no model calls and produces the same result for the same snapshot/query.
export function queryViews(query: string): string[] {
  const all = [...new Set(terms(query))];
  if (!all.length) return [];
  const views = [query];
  const diagnostic = query.split('\n').filter(line => /error|fail|exception|panic|undefined|not found|expected|actual|assert|traceback/i.test(line)).join('\n');
  if (diagnostic.trim()) views.push(diagnostic);
  const symbols = [...query.matchAll(/\b[A-Za-z_$][\w$]*(?:(?:::|\.|#)[A-Za-z_$][\w$]*)*\b/g)]
    .map(match => match[0]).filter(word => /[_$A-Z.]|::/.test(word) || word.length >= 9).join(' ');
  if (symbols.trim()) views.push(symbols);
  // Three leave-one-bucket-out views test whether a hit depends on one fragile term.
  for (let bucket = 0; bucket < 3; bucket++) {
    const kept = all.filter(term => parseInt(hash(term).slice(0, 2), 16) % 3 !== bucket);
    if (kept.length >= 2) views.push(kept.join(' '));
  }
  const unique = new Map<string,string>();
  for (const view of views) {
    const key = [...new Set(terms(view))].sort().join(' ');
    if (key && !unique.has(key)) unique.set(key,view);
  }
  return [...unique.values()].slice(0,6);
}

function isTrace(query: string): boolean {
  return /(?:^|\n).*(?:error|fail|exception|panic|traceback|undefined|assert)/i.test(query) || /(?:go test|pytest|cargo test|npm test|mvn test)/i.test(query);
}
function testLike(path: string): boolean {
  return /(?:^|\/)(?:tests?|specs?)(?:\/|$)|(?:^|[_.-])(?:test|spec)(?:[_.-]|$)/i.test(path);
}
function visibleSourceStems(query: string): Set<string> {
  const out = new Set<string>();
  for (const match of query.matchAll(/(?:^|[\s"'`(])([\w./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|cs|cpp|cc|h|hpp))(?::\d+)?/gim)) {
    const file = match[1].split(/[\\/]/).pop()!.replace(/\.[^.]+$/,'').replace(/(?:^|[_.-])(?:test|tests|spec|specs)(?:$|[_.-])/gi,'');
    if (file.length > 1) out.add(file.toLowerCase());
  }
  return out;
}

export function evidenceObligations(snapshot: Snapshot, query: string): string[] {
  const q = [...new Set(terms(query))].filter(t => t.length >= 3 && !/^\d+$/.test(t) && !/^[a-f\d]{12,}$/i.test(t));
  const df = new Map<string,number>();
  const qset = new Set(q);
  for (const chunk of snapshot.chunks) for (const term of new Set(chunk.terms)) if (qset.has(term)) df.set(term,(df.get(term) ?? 0)+1);
  return q.sort((a,b) => (df.get(a) ?? 0)-(df.get(b) ?? 0) || b.length-a.length).slice(0,12);
}

export function rankV2(snapshot: Snapshot, query: string, settings: Settings = DEFAULTS, semanticScores?:Map<string,number>): V2Ranked[] {
  const views = queryViews(query);
  if (!views.length) return [];
  const chunkById = new Map(snapshot.chunks.map(chunk => [chunk.id,chunk]));
  const fused = new Map<string,number>();
  const appearances = new Map<string,number>();
  const fileFused = new Map<string,number>();
  for (let viewIndex=0; viewIndex<views.length; viewIndex++) {
    const ranked = rank(snapshot,views[viewIndex],settings).slice(0,240);
    const seenFiles = new Set<string>();
    for (let i=0;i<ranked.length;i++) {
      const {chunk}=ranked[i];
      const weight = viewIndex===0 ? 1.35 : 1;
      fused.set(chunk.id,(fused.get(chunk.id) ?? 0)+weight/(30+i+1));
      if(i<80) appearances.set(chunk.id,(appearances.get(chunk.id) ?? 0)+1);
      if(!seenFiles.has(chunk.path)) {
        fileFused.set(chunk.path,(fileFused.get(chunk.path) ?? 0)+weight/(20+seenFiles.size+1));
        seenFiles.add(chunk.path);
      }
    }
  }
  if(semanticScores) {
    const semantic=[...semanticScores].sort((a,b)=>b[1]-a[1]).slice(0,240);
    for(let i=0;i<semantic.length;i++) fused.set(semantic[i][0],(fused.get(semantic[i][0]) ?? 0)+1/(30+i+1));
  }
  const obligations=evidenceObligations(snapshot,query);
  const trace=isTrace(query), stems=visibleSourceStems(query);
  const wantsTests=/\btests?|specs?|coverage\b/i.test(query) && !trace;
  const rows:V2Ranked[]=[];
  for(const [id,base] of fused) {
    const chunk=chunkById.get(id)!;
    const cterms=new Set(chunk.terms);
    const covered=obligations.filter(term=>cterms.has(term));
    const stability=(appearances.get(id) ?? 0)/views.length;
    let score=base + 0.16*(fileFused.get(chunk.path) ?? 0) + 0.004*stability + 0.0007*covered.length;
    if(trace && testLike(chunk.path) && !wantsTests) score*=0.48;
    if(trace && !testLike(chunk.path)) {
      const basename=chunk.path.split('/').pop()!.replace(/\.[^.]+$/,'').toLowerCase();
      if([...stems].some(stem=>basename.includes(stem)||stem.includes(basename))) score*=1.35;
    }
    rows.push({chunk,score,stability,obligations:covered});
  }
  return rows.sort((a,b)=>b.score-a.score || b.stability-a.stability || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.start-b.chunk.start);
}

export function v2Diagnostics(snapshot: Snapshot,query:string,selected:Chunk[]) {
  const obligations=evidenceObligations(snapshot,query);
  const covered=new Set(selected.flatMap(chunk=>chunk.terms));
  const missing=obligations.filter(term=>!covered.has(term));
  const ranked=rankV2(snapshot,query);
  const top=ranked.slice(0,Math.min(20,ranked.length));
  const stability=top.length?top.reduce((sum,row)=>sum+row.stability,0)/top.length:0;
  return {views:queryViews(query).length,obligations,missing,stability};
}

export function contextPackV2(snapshot:Snapshot,query:string,budget=3000,known:string[]=[],settings:Settings=DEFAULTS,semanticScores?:Map<string,number>):Pack {
  const ranked=rankV2(snapshot,query,settings,semanticScores);
  const pack=contextPack(snapshot,query,budget,settings,known,undefined,ranked,`V2 perturbation consensus: ${queryViews(query).length} deterministic query views; stability is a retrieval signal, not confidence.`);
  const selected=pack.evidence.flatMap(e=>snapshot.chunks.filter(c=>c.path===e.path && c.start<=e.end && c.end>=e.start));
  pack.stats.v2=v2Diagnostics(snapshot,query,selected);
  return pack;
}
