/**
 * Turns a structural outline (a tree of `TreeNode`s) into bounded, named spans.
 *
 * Policy, shared by every format:
 *  - A node that fits (<= maxLines and <= maxChars) becomes one span. If it is larger than
 *    `detailMinLines`, its significant descendants are emitted too as nested "detail" spans, but only
 *    when they are at most `detailRatio` of the enclosing span (wrappers that merely repeat their
 *    parent are looked through) and at most `maxNest` spans deep.
 *  - A node that is too large is not emitted; its children become the units instead. Runs of tiny
 *    children (< minLines) are merged into spans of at most `mergeLines`; text of the node that
 *    belongs to no child (headers, prose) becomes spans named after the node.
 *  - Leaves that are still too large are cut at blank lines near the size limit.
 * Spans never claim coverage: the caller adds plain line windows for the lines that remain.
 */
import {
  type PlanConfig,
  type StructuredSpan,
  type TreeNode,
  DEFAULT_PLAN,
  MAX_NAME,
  MAX_SCOPE,
  MAX_SIGNATURE,
  RefSet,
  Source,
  clipLeft,
  tidy,
} from './common.js';

interface Raw {
  start: number;
  end: number;
  name: string;
  kind: string;
  scope: string;
  nodes: readonly TreeNode[];
  /** 1 = primary span, 2+ = nested detail span. */
  level: number;
  /** Cut out of a larger span; its signature comes from its own first line. */
  piece: boolean;
}

interface Run {
  start: number;
  end: number;
  nodes: TreeNode[];
}

const MAX_COMMENT_ATTACH = 60;
const HARD_MAX_SPANS = 60_000;

export function planTree(src: Source, roots: readonly TreeNode[], overrides: Partial<PlanConfig> = {}): StructuredSpan[] {
  const cfg: PlanConfig = { ...DEFAULT_PLAN, ...overrides };
  const raws: Raw[] = [];
  const top = prepare(src, roots, 1, src.count, cfg.comment);
  new Planner(src, cfg, raws).split(null, 1, src.count, top, []);
  return finalize(src, cfg, raws);
}

/** Clamps, orders and (optionally) attaches leading comment lines to the nodes of one level. */
function prepare(src: Source, nodes: readonly TreeNode[], lo: number, hi: number, comment?: (line: number) => boolean): TreeNode[] {
  const list: TreeNode[] = [];
  for (const node of nodes) {
    if (node.end < lo || node.start > hi) continue;
    node.start = Math.max(node.start, lo);
    node.end = Math.min(node.end, hi);
    // Trailing blank lines are not content: a heading at the end of a file must size the same with or without them.
    while (node.end > node.start && src.isBlank(node.end)) node.end--;
    if (node.end >= node.start) list.push(node);
  }
  if (!isSorted(list)) list.sort((a, b) => a.start - b.start || b.end - a.end);
  let floor = lo;
  for (const node of list) {
    const header = node.start;
    if (comment) {
      let s = node.start;
      let budget = MAX_COMMENT_ATTACH;
      while (s > floor && budget-- > 0 && comment(s - 1)) s--;
      node.start = s;
    }
    if (node.children?.length) node.children = prepare(src, node.children, header, node.end, comment);
    floor = Math.max(floor, node.end + 1);
  }
  return list;
}

function isSorted(list: readonly TreeNode[]): boolean {
  for (let i = 1; i < list.length; i++) if (list[i].start < list[i - 1].start) return false;
  return true;
}

function joinNames(nodes: readonly TreeNode[]): string {
  const seen = new Set<string>();
  let out = '';
  for (const node of nodes) {
    if (!node.name || seen.has(node.name)) continue;
    seen.add(node.name);
    out += (out ? ', ' : '') + node.name;
    if (out.length > MAX_NAME * 2) break;
  }
  return out;
}

/** Breadcrumb of `node`; nodes with an empty `scopeName` (pure wrappers) do not appear in it. */
function extend(scope: string[], node: TreeNode): string[] {
  const part = node.scopeName ?? node.name;
  return part ? [...scope, part] : scope;
}

class Planner {
  constructor(
    private readonly src: Source,
    private readonly cfg: PlanConfig,
    private readonly out: Raw[],
  ) {}

  private fits(start: number, end: number): boolean {
    return end - start + 1 <= this.cfg.maxLines && this.src.chars(start, end) <= this.cfg.maxChars;
  }

  private push(start: number, end: number, name: string, kind: string, scope: string, nodes: readonly TreeNode[], level: number, piece = false): void {
    this.out.push({ start, end, name, kind, scope, nodes, level, piece });
  }

  /**
   * `owner` is too large to emit (or is the whole document when null): its children are the units.
   * `scope` is the breadcrumb of the owner, owner included.
   */
  split(owner: TreeNode | null, lo: number, hi: number, children: readonly TreeNode[], scope: string[]): void {
    const cfg = this.cfg;
    const many = children.length > cfg.manySiblings;
    let cursor = lo;
    let run: Run | undefined;
    const flush = (): void => {
      if (run) this.flush(run, scope);
      run = undefined;
    };

    for (const child of children) {
      if (owner && child.start > cursor) this.residual(owner, cursor, child.start - 1, scope, flush);
      const size = child.end - child.start + 1;
      const tiny = (size < cfg.minLines && !child.anchor) || (many && size < cfg.smallLines);
      if (tiny) {
        if (run && (child.start - run.end - 1 > cfg.maxGap || child.end - run.start + 1 > cfg.mergeLines || this.src.chars(run.start, child.end) > cfg.maxChars || cfg.breakRun?.(run.nodes[run.nodes.length - 1], child, run.end - run.start + 1))) flush();
        if (!run) run = { start: child.start, end: child.end, nodes: [] };
        run.nodes.push(child);
        run.end = Math.max(run.end, child.end);
      } else {
        flush();
        this.unit(child, scope);
      }
      cursor = Math.max(cursor, child.end + 1);
    }
    if (owner && cursor <= hi) this.residual(owner, cursor, hi, scope, flush);
    flush();
  }

  /** A non-tiny child of a container that is being split. */
  private unit(node: TreeNode, scope: string[]): void {
    // Pure wrappers (empty scopeName) have no identity of their own: their children become the units.
    const wrapper = node.scopeName === '' && !!node.children?.length;
    if (!wrapper && this.fits(node.start, node.end)) {
      this.emit(node, scope, 1);
      return;
    }
    const here = extend(scope, node);
    if (node.children?.length) this.split(node, node.start, node.end, node.children, here);
    else this.range(node, node.start, node.end, node.scope ?? here.join(' > '));
  }

  private emit(node: TreeNode, scope: string[], level: number): void {
    const cfg = this.cfg;
    const here = extend(scope, node);
    this.push(node.start, node.end, node.name, node.kind, node.scope ?? here.join(' > '), [node], level);
    const kids = node.children;
    const size = node.end - node.start + 1;
    if (kids && kids.length && level < cfg.maxNest && size > cfg.detailMinLines && kids.length <= cfg.manySiblings) {
      this.details(kids, here, level + 1, size);
    }
  }

  private details(children: readonly TreeNode[], scope: string[], level: number, enclosing: number): void {
    const cfg = this.cfg;
    for (const child of children) {
      const size = child.end - child.start + 1;
      if (size < cfg.minLines && !child.force && !child.anchor) continue;
      if (!child.force && !child.anchor && (child.scopeName === '' || size > cfg.detailRatio * enclosing)) {
        // Wrapper that carries no identity or mostly repeats the enclosing span: look through it.
        if (child.children?.length) this.details(child.children, extend(scope, child), level, enclosing);
        continue;
      }
      this.emit(child, scope, level);
    }
  }

  /** Lines of `owner` that belong to none of its children; emitted only when substantial. */
  private residual(owner: TreeNode, a: number, b: number, scope: string[], flush: () => void): boolean {
    let content = 0;
    for (let n = a; n <= b && content < this.cfg.minLines; n++) if (!this.src.isBlank(n)) content++;
    if (content < this.cfg.minLines) return false;
    flush();
    this.range(owner, a, b, scope.join(' > '));
    return true;
  }

  private flush(run: Run, scope: string[]): void {
    if (run.nodes.length < 2 || run.end - run.start + 1 < (this.cfg.minRunLines ?? this.cfg.minLines)) return;
    this.push(run.start, run.end, joinNames(run.nodes), run.nodes[0].kind, scope.join(' > '), run.nodes, 1);
  }

  /** Emits a line range as one span, or as evenly sized pieces when it is too large. */
  private range(owner: TreeNode, a: number, b: number, scope: string): void {
    if (this.fits(a, b)) {
      this.push(a, b, owner.name, owner.kind, scope, [], 1);
      return;
    }
    for (const [s, e] of this.pieces(a, b)) this.push(s, e, owner.name, owner.kind, scope, [], 1, true);
  }

  private pieces(a: number, b: number): [number, number][] {
    const total = b - a + 1;
    const target = Math.ceil(total / Math.max(1, Math.ceil(total / this.cfg.maxLines)));
    const out: [number, number][] = [];
    let s = a;
    while (s <= b) {
      let e = this.limitChars(s, Math.min(b, s + target - 1));
      if (e < b) e = this.preferBreak(s, e);
      out.push([s, e]);
      s = e + 1;
    }
    return out;
  }

  /** Largest end <= e such that lines s..end fit the character budget (at least one line). */
  private limitChars(s: number, e: number): number {
    if (this.src.chars(s, e) <= this.cfg.maxChars) return e;
    let lo = s;
    let hi = e;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.src.chars(s, mid) <= this.cfg.maxChars) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Prefer to cut next to a blank line in the last 40% of a piece. */
  private preferBreak(s: number, e: number): number {
    const floor = s + Math.floor((e - s) * 0.6);
    for (let k = e; k > floor; k--) if (this.src.isBlank(k) || this.src.isBlank(k + 1)) return k;
    return e;
  }
}

function finalize(src: Source, cfg: PlanConfig, raws: readonly Raw[]): StructuredSpan[] {
  let kept: Raw[] = [];
  for (const raw of raws) {
    let { start, end } = raw;
    start = Math.max(1, start);
    end = Math.min(src.count, end);
    while (start <= end && src.isBlank(start)) start++;
    while (end >= start && src.isBlank(end)) end--;
    if (start > end) continue;
    // A single enormous line cannot be bounded by a line-range span.
    if (start === end && src.chars(start, end) > cfg.maxChars * 2) continue;
    raw.start = start;
    raw.end = end;
    kept.push(raw);
  }

  const cap = Math.min(HARD_MAX_SPANS, Math.max(24, Math.ceil(src.count / 3)));
  if (kept.length > cap) {
    const dropFirst = kept
      .map((_, i) => i)
      .sort((x, y) => kept[y].level - kept[x].level || kept[x].end - kept[x].start - (kept[y].end - kept[y].start) || kept[x].start - kept[y].start || x - y);
    const drop = new Set(dropFirst.slice(0, kept.length - cap));
    kept = kept.filter((_, i) => !drop.has(i));
  }

  kept.sort((a, b) => a.start - b.start || b.end - a.end || a.level - b.level);
  const spans: StructuredSpan[] = [];
  let previous: Raw | undefined;
  for (const raw of kept) {
    if (previous && previous.start === raw.start && previous.end === raw.end) continue;
    previous = raw;
    const first = src.line(src.firstContent(raw.start, raw.end));
    const name = tidy(raw.name, MAX_NAME) || tidy(first, 60) || raw.kind;
    const signature = tidy((raw.piece ? undefined : cfg.signature?.(raw.start, raw.end, raw.nodes)) ?? first, MAX_SIGNATURE);
    const scope = clipLeft(tidy(raw.scope, MAX_SCOPE * 4), MAX_SCOPE);
    const span: StructuredSpan = { start: raw.start, end: raw.end, name, kind: raw.kind };
    if (scope) span.scope = scope;
    if (signature) span.signature = signature;
    if (cfg.refs) {
      const refs = new RefSet();
      for (const ref of cfg.refs(raw.start, raw.end, raw.nodes)) refs.add(ref);
      if (refs.list.length) span.refs = refs.list;
    }
    spans.push(span);
  }
  return spans;
}
