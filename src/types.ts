export interface Chunk {
  id: string; path: string; start: number; end: number; name: string; kind: string;
  text: string; terms: string[]; refs: string[];
  signature?: string; scope?: string; doc?: string;
}
export interface SourceFile {
  path: string; text: string; hash: string; language: string; chunks: Chunk[]; parsed: boolean;
}
export interface Snapshot {
  files: SourceFile[]; chunks: Chunk[]; revision: string; skipped: number; truncated: boolean;
  warnings: string[]; root: string; elapsedMs: number;
  totalFiles?: number; totalBytes?: number; totalTokens?: number; candidateFiles?: number;
  indexMode?: 'full'|'cascade';
  inventory?: {path:string;language:string;lines:number}[];
}
export interface Pack {
  text: string;
  stats: { tokenizer: string; inputTokens: number; inputTokensEstimated?: boolean; outputTokens: number; reduction: number; selectedChunks: number; excerpts?: number; pointers?: number; totalChunks: number; files: number; candidateFiles?:number; indexMode?:'full'|'cascade'; elapsedMs: number; revision: string; budget: number; v2?: {views:number;obligations:string[];missing:string[];stability:number} };
  evidence: { path: string; start: number; end: number; id: string; kind?: 'excerpt'|'window'|'known'|'pointer' }[];
}
