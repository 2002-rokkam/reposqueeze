export interface Chunk {
  id: string; path: string; start: number; end: number; name: string; kind: string;
  text: string; terms: string[]; refs: string[];
  // Optional additive fields written by language-aware chunkers; the index carries unknown optional fields through its cache.
  signature?: string; scope?: string; doc?: string;
}
export interface SourceFile {
  path: string; text: string; hash: string; language: string; chunks: Chunk[]; parsed: boolean;
  generated?: boolean;
}
export interface Snapshot {
  files: SourceFile[]; chunks: Chunk[]; revision: string; skipped: number; truncated: boolean;
  warnings: string[]; root: string; elapsedMs: number;
  totalFiles?: number; totalBytes?: number; totalTokens?: number; candidateFiles?: number;
  // True when totalTokens is a sampled estimate rather than an exact o200k_base count (see REPOSQUEEZE_EXACT_STATS).
  totalTokensEstimated?: boolean;
  indexMode?: 'full'|'cascade';
  // Cache statistics that differ between cold and warm runs; kept out of `warnings`, which are embedded in pack text.
  diagnostics?: string[];
  inventory?: {path:string;language:string;lines:number}[];
}
export interface Pack {
  text: string;
  stats: { tokenizer: string; inputTokens: number; inputTokensEstimated?: boolean; outputTokens: number; reduction: number; selectedChunks: number; totalChunks: number; files: number; candidateFiles?:number; indexMode?:'full'|'cascade'; elapsedMs: number; revision: string; budget: number; v2?: {views:number;obligations:string[];missing:string[];stability:number} };
  evidence: { path: string; start: number; end: number; id: string }[];
}
