export interface Chunk {
  id: string; path: string; start: number; end: number; name: string; kind: string;
  text: string; terms: string[]; refs: string[];
  /** Declaration header up to the body opener, whitespace-collapsed, at most 240 characters. Derived text, not a source excerpt. */
  signature?: string;
  /** Breadcrumb of enclosing class/module/namespace names plus this definition, e.g. `UserService > save`. Only set for nested definitions. */
  scope?: string;
  /** Leading doc-comment (or Python docstring) text with comment markers removed, at most 400 characters. Derived text, not a source excerpt. */
  doc?: string;
  /** True when the chunk starts inside a definition that was split into several pieces (not at its first line). */
  cont?: true;
  /** True when the chunk belongs to a generated or minified file. */
  generated?: true;
}
export interface ParseResult {
  chunks: Chunk[]; parsed: boolean;
  /** Set when the file looks generated or minified; its chunking is capped and AST-free. */
  generated?: boolean;
  /** Why the file was flagged: `path`, `marker`, `sourcemap`, `minified` or `long-lines`. */
  generatedReason?: string;
}
export interface SourceFile {
  path: string; text: string; hash: string; language: string; chunks: Chunk[]; parsed: boolean;
  generated?: boolean; generatedReason?: string;
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
  stats: { tokenizer: string; inputTokens: number; outputTokens: number; reduction: number; selectedChunks: number; totalChunks: number; files: number; candidateFiles?:number; indexMode?:'full'|'cascade'; elapsedMs: number; revision: string; budget: number; v2?: {views:number;obligations:string[];missing:string[];stability:number} };
  evidence: { path: string; start: number; end: number; id: string }[];
}
