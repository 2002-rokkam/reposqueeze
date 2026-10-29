export interface Chunk {
  id: string; path: string; start: number; end: number; name: string; kind: string;
  text: string; terms: string[]; refs: string[];
}
export interface SourceFile {
  path: string; text: string; hash: string; language: string; chunks: Chunk[]; parsed: boolean;
}
export interface Snapshot {
  files: SourceFile[]; chunks: Chunk[]; revision: string; skipped: number; truncated: boolean;
  warnings: string[]; root: string; elapsedMs: number;
}
export interface Pack {
  text: string;
  stats: { tokenizer: string; inputTokens: number; outputTokens: number; reduction: number; selectedChunks: number; totalChunks: number; files: number; elapsedMs: number; revision: string; budget: number };
  evidence: { path: string; start: number; end: number; id: string }[];
}
