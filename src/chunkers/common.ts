/**
 * Shared types and text helpers for the structured (non tree-sitter) chunkers.
 *
 * Every scanner in this directory is pure, deterministic and linear-time: it reads a `Source`
 * and returns a tree of `TreeNode`s which `plan.ts` turns into bounded, named spans.
 */

export interface StructuredSpan {
  /** One-based inclusive line range; the chunk text is exactly lines[start-1..end-1] of `text.split('\n')`. */
  start: number;
  end: number;
  /** Symbol-like name used for ranking (heading text, key path, tag + id, selector, SQL object, ...). */
  name: string;
  /** Namespaced kind such as `md_section`, `yaml_key` or `xml_element`; never `window`. */
  kind: string;
  /** Breadcrumb from the document root to this span, e.g. `Installation > Docker`. */
  scope?: string;
  /** One-line header (at most 240 characters). */
  signature?: string;
  /** Unique identifier-like words that may refer to definitions elsewhere (at most 200). */
  refs?: string[];
}

export const MAX_NAME = 120;
export const MAX_SIGNATURE = 240;
export const MAX_SCOPE = 240;
export const MAX_REFS = 200;
export const MAX_REF_LENGTH = 120;

/** A node in the structural outline of a document. Ranges are one-based and inclusive. */
export interface TreeNode {
  start: number;
  end: number;
  name: string;
  kind: string;
  /** Breadcrumb element contributed by this node (defaults to `name`). */
  scopeName?: string;
  /** Complete breadcrumb override (used by flat formats such as TOML where nesting is in the key path). */
  scope?: string;
  signature?: string;
  /** Own references; scanners usually expose them through `PlanConfig.refs` instead. */
  refs?: readonly string[];
  /** Eligible as a stand-alone detail span even when smaller than the minimum span size. */
  force?: boolean;
  /** Worth its own span even when tiny, wherever it occurs (for example a one-line CREATE INDEX). */
  anchor?: boolean;
  children?: TreeNode[];
}

/** What a scanner returns: the outline plus any planner overrides appropriate for the format. */
export interface Scan {
  roots: TreeNode[];
  plan?: Partial<PlanConfig>;
}

export interface PlanConfig {
  /** Largest emitted span (lines). Larger nodes are split along their children, or by lines. */
  maxLines: number;
  /** Largest emitted span (characters); keeps dense or minified content from producing huge chunks. */
  maxChars: number;
  /** Nodes shorter than this are "tiny": merged with neighbours instead of becoming spans. */
  minLines: number;
  /** A merged run of tiny siblings must span at least this many lines to be emitted (default: minLines). */
  minRunLines?: number;
  /** Upper bound (lines) for a merged run of tiny siblings. */
  mergeLines: number;
  /** A fitting span only gets nested detail spans when it is longer than this. */
  detailMinLines: number;
  /** A nested detail span must be at most this fraction of its enclosing emitted span. */
  detailRatio: number;
  /** Maximum nesting of emitted spans (a line is covered by at most this many structural spans). */
  maxNest: number;
  /** Parents with more children than this never get detail spans; their small children are merged. */
  manySiblings: number;
  /** With `manySiblings` exceeded, children shorter than this are treated as tiny. */
  smallLines: number;
  /** Most lines allowed between tiny siblings of one merged run. */
  maxGap: number;
  /** Start a new merged run between two tiny siblings (for example when a key prefix changes). */
  breakRun?: (previous: TreeNode, next: TreeNode, runLines: number) => boolean;
  /** Is this (one-based) line a comment? Contiguous comment lines directly above a node are attached to it. */
  comment?: (line: number) => boolean;
  /** One-line header for a span; return undefined to fall back to the first non-blank line. */
  signature?: (start: number, end: number, nodes: readonly TreeNode[]) => string | undefined;
  /** References for a span covering `nodes` (empty for residual text) between `start` and `end`. */
  refs?: (start: number, end: number, nodes: readonly TreeNode[]) => readonly string[];
}

export const DEFAULT_PLAN: PlanConfig = {
  maxLines: 80,
  maxChars: 6000,
  minLines: 3,
  mergeLines: 40,
  detailMinLines: 16,
  detailRatio: 0.8,
  maxNest: 3,
  manySiblings: 300,
  smallLines: 12,
  maxGap: 6,
};

/** Line-oriented view of the text. Line numbering follows `text.split('\n')`, like the indexer. */
export class Source {
  readonly text: string;
  readonly count: number;
  /** Lines without the trailing carriage return (and without a leading BOM on line 1). */
  readonly lines: string[];
  /** offsets[i] is the character offset where line i+1 begins; offsets[count] is text.length + 1. */
  readonly offsets: Int32Array;

  constructor(text: string) {
    this.text = text;
    const raw = text.split('\n');
    this.count = raw.length;
    this.lines = new Array<string>(raw.length);
    this.offsets = new Int32Array(raw.length + 1);
    let offset = 0;
    for (let i = 0; i < raw.length; i++) {
      this.offsets[i] = offset;
      offset += raw[i].length + 1;
      let line = raw[i];
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      this.lines[i] = line;
    }
    this.offsets[raw.length] = offset;
    if (this.lines[0].charCodeAt(0) === 0xfeff) this.lines[0] = this.lines[0].slice(1);
  }

  line(n: number): string {
    return this.lines[n - 1] ?? '';
  }

  isBlank(n: number): boolean {
    const line = this.lines[n - 1];
    if (line === undefined) return true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9 && c !== 13 && c !== 0xfeff && c !== 0xa0) return false;
    }
    return true;
  }

  /** Characters in lines a..b inclusive, newlines included. */
  chars(a: number, b: number): number {
    return this.offsets[Math.min(b, this.count)] - this.offsets[a - 1];
  }

  /** One-based line containing the character offset `pos` (binary search). */
  lineOf(pos: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** First non-blank line in [start, end], or start when all are blank. */
  firstContent(start: number, end: number): number {
    for (let n = start; n <= end; n++) if (!this.isBlank(n)) return n;
    return start;
  }
}

/** Cuts `s` to `max` characters (adding an ellipsis) without splitting a surrogate pair. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max - 1;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return s.slice(0, cut) + '…';
}

/** Collapses whitespace and control characters; the input is pre-cut so long lines stay cheap. */
export function tidy(s: string, max: number): string {
  const cut = s.length > max * 4 + 32 ? s.slice(0, max * 4 + 32) : s;
  return clip(cut.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(), max);
}

/** Keeps the tail of a breadcrumb: the innermost element is the informative part. */
export function clipLeft(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.length - max + 1;
  const c = s.charCodeAt(cut);
  if (c >= 0xdc00 && c <= 0xdfff) cut++;
  return '…' + s.slice(cut);
}

/** Literal values that carry no information as references. */
const LITERAL_WORDS = new Set(['true', 'false', 'null', 'none', 'nil', 'undefined']);

/** Order-preserving set of references that stops accepting entries at `limit`. */
export class RefSet {
  private readonly seen = new Set<string>();
  readonly list: string[] = [];

  constructor(private readonly limit = MAX_REFS) {}

  get full(): boolean {
    return this.list.length >= this.limit;
  }

  add(ref: string | undefined): void {
    if (ref === undefined || this.full) return;
    const r = ref.length > MAX_REF_LENGTH ? ref.slice(0, MAX_REF_LENGTH) : ref;
    if (r.length < 2 || this.seen.has(r) || LITERAL_WORDS.has(r)) return;
    this.seen.add(r);
    this.list.push(r);
  }
}

const FILE_EXTENSION = /^(?:html?|xml|json|jsonc|ya?ml|js|jsx|ts|tsx|css|scss|less|java|py|properties|txt|md|sql|sh|vue|svelte|hbs|xhtml)$/i;

/** Last segment of a path or dotted identifier: `a/b/c.html` -> `c`, `com.x.Foo` -> `Foo`. */
export function lastSegment(ref: string): string {
  const slash = ref.lastIndexOf('/');
  if (slash >= 0) {
    const tail = ref.slice(slash + 1);
    const dot = tail.lastIndexOf('.');
    return dot > 0 ? tail.slice(0, dot) : tail;
  }
  const dot = ref.lastIndexOf('.');
  if (dot <= 0 || dot === ref.length - 1) return ref;
  const ext = ref.slice(dot + 1);
  return FILE_EXTENSION.test(ext) ? ref.slice(0, dot) : ext;
}

/** True for strings that look like a reference rather than prose: paths, dotted names, ns:Names. */
export function looksLikeRef(value: string): boolean {
  if (value.length < 3 || value.length > 160) return false;
  if (/\s/.test(value)) return false;
  if (/^(?:https?:|mailto:|data:|javascript:|#|\$\{|\{\{)/i.test(value)) return false;
  return /^[A-Za-z_@./~$][\w@$./:+#~-]*$/.test(value) && /[./:]|[a-z][A-Z]/.test(value);
}

/** Iterative pre-order walk with a visit limit (guards against pathological trees). */
export function walk(nodes: readonly TreeNode[], visit: (node: TreeNode) => void, limit = 5000): void {
  const stack: TreeNode[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i]);
  let seen = 0;
  while (stack.length && seen++ < limit) {
    const node = stack.pop()!;
    visit(node);
    const kids = node.children;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

/** indexOf with memoisation of far results: successive searches from nearby offsets cost O(1). */
export class Finder {
  private readonly memo = new Map<string, { from: number; at: number }>();

  constructor(private readonly t: string) {}

  find(pattern: string, from: number): number {
    const m = this.memo.get(pattern);
    if (m && from >= m.from && (m.at < 0 || from <= m.at)) return m.at;
    const at = this.t.indexOf(pattern, from);
    this.memo.set(pattern, { from, at });
    return at;
  }
}

/** Monotonic offset -> line mapping (falls back to binary search when asked about the past). */
export class Cursor {
  private pos = 0;
  private line = 1;
  private nextBreak: number;

  constructor(private readonly src: Source) {
    this.nextBreak = src.text.indexOf('\n');
  }

  to(pos: number): number {
    if (pos < this.pos) return this.src.lineOf(pos);
    const t = this.src.text;
    // nextBreak caches the end of the current line so repeated queries inside one huge line stay O(1).
    while (this.nextBreak >= 0 && this.nextBreak < pos) {
      this.line++;
      this.nextBreak = t.indexOf('\n', this.nextBreak + 1);
    }
    this.pos = pos;
    return this.line;
  }
}
