import { Repository, SourceChangedError } from './repository.js';
import { SearchIndex } from './search-index.js';
import { SemanticIndex } from './semantic.js';
import { terms } from './tokenize.js';
import { checkBudget, warmTokenizer } from './tokens.js';
import { contextPackV2 } from './v2.js';
import type { Pack, Snapshot } from './types.js';

// Candidates handed to the optional embedding model: the strongest lexical hits, not an arbitrary prefix of the chunks.
const SEMANTIC_CANDIDATES = 600;

export class Engine extends Repository {
  private semantic?: SemanticIndex;
  constructor(root:string,model?:string) {super(root);if(model)this.semantic=new SemanticIndex(model);}
  async context(query:string,budget=3000,known:string[]=[]): Promise<Pack> {
    const started=performance.now();
    checkBudget(budget);
    if(!query.trim() || query.length>8000) throw new Error('query must contain 1–8000 characters');
    // A file edited between indexing and reading its text raises SourceChangedError; the second attempt re-indexes.
    for(let attempt=0;;attempt++) {
      try {
        const pack=await this.attempt(query,budget,known);
        pack.stats.elapsedMs=performance.now()-started;
        return pack;
      } catch(error) {
        if(!(error instanceof SourceChangedError) || attempt>=1) throw error;
      }
    }
  }
  private async attempt(query:string,budget:number,known:string[]): Promise<Pack> {
    const pending=this.snapshot(query);
    // Build the tokenizer (a few hundred ms of CPU) once the first file-system and Git work is already in flight.
    await new Promise<void>(resolve=>setImmediate(resolve));
    warmTokenizer();
    const snapshot=await pending;
    const semanticScores=this.semantic ? await this.semantic.scores(snapshot,query,this.lexicalCandidates(snapshot,query)) : undefined;
    // V2 is the default. Local embeddings remain available in V1 compatibility
    // benchmarks; PCR deliberately uses no model so query robustness is auditable.
    const pack=contextPackV2(snapshot,query,budget,known,undefined,semanticScores);
    pack.stats.inputTokensEstimated=!!snapshot.totalTokensEstimated;
    return pack;
  }
  private lexicalCandidates(snapshot:Snapshot,query:string) {
    return SearchIndex.build(snapshot).retrieve(terms(query),{limit:SEMANTIC_CANDIDATES}).map(hit=>hit.chunk);
  }
}
