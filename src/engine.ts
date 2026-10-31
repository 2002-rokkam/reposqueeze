import { Repository } from './repository.js';
import { SemanticIndex } from './semantic.js';
import { contextPackV2, rankV2 } from './v2.js';
import { expand } from './context.js';
import { resolveFeatures, type FeatureSet } from './features.js';
import { checkBudget } from './tokens.js';
import { condenseQuery } from './trace.js';
import { loadGitSignals } from './gitsignals.js';
import type { Pack } from './types.js';

export interface EngineOptions {
  /** Local Ollama embedding model (for example all-minilm). Code is sent only to 127.0.0.1:11434. */
  semanticModel?: string;
  /** Feature switches, same syntax as RSQ_FEATURES (for example "-prf,-git"). */
  features?: string | FeatureSet;
}

const MAX_QUERY_CHARS = 8000;
const HARD_QUERY_LIMIT = 1_000_000;


export class Engine extends Repository {
  readonly features: FeatureSet;
  private semantic?: SemanticIndex;

  constructor(root: string, options: string | EngineOptions = {}) {
    super(root);
    const { semanticModel, features } = typeof options === 'string' ? { semanticModel: options, features: undefined } : options;
    this.features = typeof features === 'object' ? features : resolveFeatures(features);
    if (semanticModel) this.semantic = new SemanticIndex(semanticModel);
  }

  async context(query: string, budget = 3000, known: string[] = []): Promise<Pack> {
    const started = performance.now();
    checkBudget(budget);
    const raw = query.trim();
    if (!raw) throw new Error('query must not be empty');
    if (raw.length > HARD_QUERY_LIMIT) throw new Error('query is longer than 1,000,000 characters');
    if (raw.length > MAX_QUERY_CHARS && !this.features.has('condense')) throw new Error('query must contain 1–8000 characters');
    // Pasted issues and logs above the limit are condensed to their high-signal parts instead of being rejected.
    const text = raw.length > MAX_QUERY_CHARS ? condenseQuery(raw, 6000) : raw;
    const snapshot = await this.snapshot(text);
    let semanticScores: Map<string, number> | undefined;
    if (this.semantic) {
      // Embed only the strongest lexical candidates instead of an arbitrary slice of the repository.
      const candidates = rankV2(snapshot, text, undefined, undefined, this.features)
        .slice(0, 300)
        .map(row => row.chunk);
      semanticScores = await this.semantic.scores(snapshot, text, candidates);
    }
    // PCR is the default. Embeddings, when enabled, are fused as one more rank signal.
    const git = this.features.has('git') ? await loadGitSignals(this.root) : undefined;
    const pack = contextPackV2(snapshot, text, budget, known, undefined, semanticScores, this.features, git);
    pack.stats.elapsedMs = performance.now() - started;
    return pack;
  }

  async expandRange(path: string, start: number, end: number, budget = 3000): Promise<string> {
    return expand(await this.snapshot(path), path, start, end, budget);
  }
}
