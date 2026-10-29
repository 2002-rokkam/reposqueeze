import { Repository } from './repository.js';
import { SemanticIndex } from './semantic.js';
import { contextPack, DEFAULTS } from './context.js';
import { checkBudget } from './tokens.js';
export class Engine extends Repository {
  private semantic?: SemanticIndex;
  constructor(root:string,model?:string) {super(root);if(model)this.semantic=new SemanticIndex(model);}
  async context(query:string,budget=3000,known:string[]=[]) {
    const started=performance.now();
    checkBudget(budget);
    if(!query.trim() || query.length>8000) throw new Error('query must contain 1–8000 characters');
    const snapshot=await this.snapshot();
    const semanticScores=this.semantic ? await this.semantic.scores(snapshot,query) : undefined;
    const pack=contextPack(snapshot,query,budget,DEFAULTS,known,semanticScores);
    pack.stats.elapsedMs=performance.now()-started;
    return pack;
  }
}
