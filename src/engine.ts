import { Repository } from './repository.js';
import { SemanticIndex } from './semantic.js';
import { contextPackV2 } from './v2.js';
import { checkBudget } from './tokens.js';
export class Engine extends Repository {
  private semantic?: SemanticIndex;
  constructor(root:string,model?:string) {super(root);if(model)this.semantic=new SemanticIndex(model);}
  async context(query:string,budget=3000,known:string[]=[]) {
    const started=performance.now();
    checkBudget(budget);
    if(!query.trim() || query.length>8000) throw new Error('query must contain 1–8000 characters');
    const snapshot=await this.snapshot(query);
    const semanticScores=this.semantic ? await this.semantic.scores(snapshot,query) : undefined;
    // V2 is the default. Local embeddings remain available in V1 compatibility
    // benchmarks; PCR deliberately uses no model so query robustness is auditable.
    const pack=contextPackV2(snapshot,query,budget,known,undefined,semanticScores);
    pack.stats.elapsedMs=performance.now()-started;
    return pack;
  }
}
