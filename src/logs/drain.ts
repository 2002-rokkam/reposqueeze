// Bounded, deterministic Drain-style log template miner (He et al., ICWS 2017), simplified for single-pass use.
// Lines are routed through a fixed-depth prefix tree keyed on token count and the first tokens, then matched against the
// few clusters in the leaf by positional token similarity. All limits are hard caps, so the work per line is O(length).

export const WILDCARD = '<*>';

export interface Cluster {
  id: number;
  template: string[];
  size: number;
}

export interface DrainOptions {
  /** Number of leading tokens used for tree routing. */
  depth?: number;
  /** Minimum share of positions where line and template agree (wildcards never agree). */
  similarity?: number;
  maxChildren?: number;
  maxClusters?: number;
  maxPerLeaf?: number;
  /** Tokens beyond this position are ignored for clustering. */
  maxTokens?: number;
}

interface Node {
  children: Map<string, Node>;
  clusters: Cluster[];
}

const newNode = (): Node => ({ children: new Map(), clusters: [] });

/** Tokens that look like variables (digits, placeholders) route through the wildcard branch. */
function isVariable(token: string): boolean {
  return token.charCodeAt(0) === 60 /* < */ || /\d/.test(token);
}

export class DrainMiner {
  readonly clusters: Cluster[] = [];
  private readonly roots = new Map<number, Node>();
  private readonly depth: number;
  private readonly similarity: number;
  private readonly maxChildren: number;
  private readonly maxClusters: number;
  private readonly maxPerLeaf: number;
  private readonly maxTokens: number;

  constructor(options: DrainOptions = {}) {
    this.depth = options.depth ?? 1;
    this.similarity = options.similarity ?? 0.5;
    this.maxChildren = options.maxChildren ?? 48;
    this.maxClusters = options.maxClusters ?? 2048;
    this.maxPerLeaf = options.maxPerLeaf ?? 48;
    this.maxTokens = options.maxTokens ?? 48;
  }

  /** Assign a token sequence to a cluster, or return null when every cap is exhausted (the line is then treated as unique). */
  add(input: readonly string[]): Cluster | null {
    if (input.length === 0) return null;
    const tokens = input.length > this.maxTokens ? input.slice(0, this.maxTokens) : input;
    const steps = Math.min(this.depth, tokens.length);

    let node = this.roots.get(tokens.length);
    for (let i = 0; i < steps && node; i++) {
      let key = isVariable(tokens[i]) ? WILDCARD : tokens[i];
      let child = node.children.get(key);
      if (!child && key !== WILDCARD && node.children.size >= this.maxChildren) {
        key = WILDCARD;
        child = node.children.get(key);
      }
      node = child;
    }
    if (node) {
      const match = this.bestMatch(node.clusters, tokens);
      if (match) {
        for (let i = 0; i < tokens.length; i++) if (match.template[i] !== tokens[i]) match.template[i] = WILDCARD;
        match.size++;
        return match;
      }
      if (node.clusters.length >= this.maxPerLeaf) return null;
    }
    if (this.clusters.length >= this.maxClusters) return null;
    return this.create(tokens, steps);
  }

  private create(tokens: readonly string[], steps: number): Cluster {
    let node = this.roots.get(tokens.length);
    if (!node) this.roots.set(tokens.length, (node = newNode()));
    for (let i = 0; i < steps; i++) {
      let key = isVariable(tokens[i]) ? WILDCARD : tokens[i];
      if (key !== WILDCARD && !node.children.has(key) && node.children.size >= this.maxChildren) key = WILDCARD;
      let child = node.children.get(key);
      if (!child) node.children.set(key, (child = newNode()));
      node = child;
    }
    const cluster: Cluster = { id: this.clusters.length, template: tokens.slice(), size: 1 };
    node.clusters.push(cluster);
    this.clusters.push(cluster);
    return cluster;
  }

  private bestMatch(candidates: readonly Cluster[], tokens: readonly string[]): Cluster | null {
    let best: Cluster | null = null, bestSim = -1, bestWild = -1;
    for (const cluster of candidates) {
      let same = 0, wild = 0;
      const template = cluster.template;
      for (let i = 0; i < tokens.length; i++) {
        if (template[i] === WILDCARD) wild++;
        else if (template[i] === tokens[i]) same++;
      }
      const sim = same / tokens.length;
      if (sim > bestSim || (sim === bestSim && wild > bestWild)) { best = cluster; bestSim = sim; bestWild = wild; }
    }
    return best && bestSim >= this.similarity ? best : null;
  }
}
