/**
 * Generic scanner for languages whose structure is `prelude { body }`: stylesheets, HCL, protobuf, Thrift,
 * GraphQL, Gradle/Groovy/Kotlin DSL and nginx-style configuration.
 *
 * One pass, explicit stack, no recursion over the input. Strings, comments, heredocs, interpolation and
 * `url(...)` are skipped so braces inside them never count. A language plugs in how a prelude is named.
 */
import { type TreeNode, Cursor, Finder, Source, tidy } from './common.js';

export interface BraceInfo {
  name: string;
  kind: string;
  scopeName?: string;
  /** A definition worth its own span even when it fits on one line (`message Ping {}`). */
  anchor?: boolean;
}

export interface BraceLang {
  lineComments: readonly string[];
  blockComments: boolean;
  quotes: string;
  tripleQuotes?: boolean;
  /** `${...}` inside double-quoted strings (HCL, Groovy, Kotlin). */
  interpolation?: boolean;
  /** `<<EOT` heredocs. */
  heredoc?: boolean;
  /** Openers such as `#{` or `@{` whose braces belong to a selector or property. */
  embedded?: readonly string[];
  /** Unquoted `url(...)` may contain `;`, `{` and `//`. */
  urls?: boolean;
  /** A string right before a root-level definition documents it (GraphQL descriptions). */
  docStrings?: boolean;
  /** A root-level `{` without a prelude starts a block of this kind (GraphQL anonymous query). */
  anonymousRoot?: BraceInfo;
  statements: 'none' | 'semicolon' | 'line';
  statementDepth: 'root' | 'all';
  block(prelude: string, depth: number): BraceInfo | undefined;
  statement?(text: string, depth: number): BraceInfo | undefined;
}

const MAX_DEPTH = 40;
const MAX_PRELUDE = 600;
const MAX_NODES = 300_000;
const HEREDOC = /<<-?\s*(["']?)([A-Za-z_][\w-]*)\1/y;

interface Block {
  node: TreeNode | undefined;
  children: TreeNode[];
}

const isWs = (c: number): boolean => c === 32 || c === 9 || c === 13 || c === 12 || c === 10;
const isIdent = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;

export function scanBraces(src: Source, lang: BraceLang): TreeNode[] {
  const t = src.text;
  const n = t.length;
  const cursor = new Cursor(src);
  const finder = new Finder(t);
  const roots: TreeNode[] = [];
  const stack: Block[] = [];
  const slashComments = lang.lineComments.includes('//');
  const hashComments = lang.lineComments.includes('#');
  const dashComments = lang.lineComments.includes('--');
  const embeddedHash = lang.embedded?.includes('#{') ?? false;
  const embeddedAt = lang.embedded?.includes('@{') ?? false;
  let nodeDepth = 0;
  let overflow = 0;
  let paren = 0;
  let nodes = 0;
  let ps = -1;
  let pline = 0;
  let plead = 0;
  let lead: { startLine: number; endLine: number; endPos: number } | undefined;
  let i = t.charCodeAt(0) === 0xfeff ? 1 : 0;

  const siblings = (): TreeNode[] => (stack.length ? stack[stack.length - 1].children : roots);

  const onlyWhitespace = (from: number, to: number): boolean => {
    if (to - from > 400) return false;
    for (let p = from; p < to; p++) if (!isWs(t.charCodeAt(p))) return false;
    return true;
  };

  /** Marks the first significant character of a prelude (and picks up a documenting comment above it). */
  const begin = (pos: number): void => {
    ps = pos;
    pline = cursor.to(pos);
    plead = lead && lead.endLine >= pline - 1 && onlyWhitespace(lead.endPos, pos) ? lead.startLine : pline;
    lead = undefined;
  };

  const noteComment = (from: number, end: number): void => {
    if (ps >= 0) return;
    const startLine = cursor.to(from);
    const endLine = cursor.to(Math.max(from, end - 1));
    if (lead && lead.endLine + 1 >= startLine && onlyWhitespace(lead.endPos, from)) {
      lead.endLine = endLine;
      lead.endPos = end;
    } else {
      lead = { startLine, endLine, endPos: end };
    }
  };

  const finishStatement = (endPos: number): void => {
    if (ps < 0) return;
    if (lang.statement && (lang.statementDepth === 'all' || stack.length === 0) && nodes < MAX_NODES) {
      const text = tidy(t.slice(ps, Math.min(endPos, ps + MAX_PRELUDE)), 400);
      const info = text ? lang.statement(text, nodeDepth) : undefined;
      if (info) {
        siblings().push({ start: plead, end: cursor.to(Math.max(ps, endPos - 1)), name: info.name, kind: info.kind, scopeName: info.scopeName ?? info.name, anchor: info.anchor });
        nodes++;
      }
    }
    ps = -1;
  };

  const open = (pos: number): void => {
    let info: BraceInfo | undefined;
    if (paren === 0 && nodeDepth < MAX_DEPTH && nodes < MAX_NODES) {
      if (ps >= 0) info = lang.block(tidy(t.slice(ps, Math.min(pos, ps + MAX_PRELUDE)), 400), nodeDepth);
      else if (lang.anonymousRoot && stack.length === 0) info = lang.anonymousRoot;
    }
    if (stack.length >= MAX_DEPTH) {
      overflow++;
    } else if (info) {
      const start = ps >= 0 ? plead : cursor.to(pos);
      const node: TreeNode = { start, end: start, name: info.name, kind: info.kind, scopeName: info.scopeName ?? info.name, anchor: info.anchor, children: [] };
      stack.push({ node, children: node.children! });
      nodeDepth++;
    } else {
      stack.push({ node: undefined, children: siblings() });
    }
    ps = -1;
    lead = undefined;
  };

  const close = (pos: number): void => {
    if (overflow > 0) {
      overflow--;
    } else {
      const block = stack.pop();
      if (block?.node) {
        block.node.end = Math.max(block.node.start, cursor.to(pos));
        nodeDepth--;
        siblings().push(block.node);
        nodes++;
      }
    }
    ps = -1;
    paren = 0;
    lead = undefined;
  };

  /** Does the statement being read continue on the next line? */
  const continues = (nl: number): boolean => {
    let k = nl - 1;
    while (k > ps && isWs(t.charCodeAt(k))) k--;
    const last = t.charCodeAt(k);
    if (last === 44 || last === 124 || last === 61 || last === 38 || last === 43 || last === 92 || last === 40 || last === 91) return true;
    let q = nl + 1;
    const limit = Math.min(n, nl + 200);
    while (q < limit && isWs(t.charCodeAt(q))) q++;
    const next = t.charCodeAt(q);
    return next === 123 || next === 124 || next === 38 || (next === 46 && isIdent(t.charCodeAt(q + 1)));
  };

  /** Index just past the string starting at `pos` (strings end at a newline unless triple-quoted). */
  const skipString = (pos: number, quote: number): number => {
    if (lang.tripleQuotes && t.charCodeAt(pos + 1) === quote && t.charCodeAt(pos + 2) === quote) {
      const e = finder.find(String.fromCharCode(quote).repeat(3), pos + 3);
      return e < 0 ? n : e + 3;
    }
    let j = pos + 1;
    while (j < n) {
      const c = t.charCodeAt(j);
      if (c === quote) return j + 1;
      if (c === 92) {
        j += 2;
        continue;
      }
      if (c === 10) return j;
      if (c === 36 && lang.interpolation && quote === 34 && t.charCodeAt(j + 1) === 123) {
        j = skipBraces(j + 2, true);
        continue;
      }
      j++;
    }
    return n;
  };

  /** Index just past the `}` matching an already opened `{` (nested plain strings are skipped). */
  const skipBraces = (from: number, strings: boolean): number => {
    let depth = 1;
    let k = from;
    const limit = Math.min(n, from + 4000);
    while (k < limit && depth > 0) {
      const c = t.charCodeAt(k);
      if (c === 123) depth++;
      else if (c === 125) depth--;
      else if (strings && (c === 34 || c === 39)) {
        const e = t.indexOf(String.fromCharCode(c), k + 1);
        if (e > 0 && e < limit) k = e;
      }
      k++;
    }
    return k;
  };

  const lineEnd = (pos: number): number => {
    const e = finder.find('\n', pos);
    return e < 0 ? n : e;
  };

  /** Terminator word of a `<<EOT` heredoc starting at `pos`, if there is one. */
  const heredocId = (pos: number): string | undefined => {
    HEREDOC.lastIndex = pos;
    return HEREDOC.exec(t)?.[2];
  };

  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 10) {
      if (lang.statements === 'line' && ps >= 0 && paren === 0 && !continues(i)) finishStatement(i);
      i++;
    } else if (isWs(c) || c === 0xfeff) {
      i++;
    } else if (c === 123) {
      open(i);
      i++;
    } else if (c === 125) {
      close(i);
      i++;
    } else if (c === 59 && paren === 0) {
      if (lang.statements === 'none') ps = -1;
      else finishStatement(i);
      i++;
    } else if (c === 47 && ((slashComments && t.charCodeAt(i + 1) === 47) || (lang.blockComments && t.charCodeAt(i + 1) === 42))) {
      let end: number;
      if (t.charCodeAt(i + 1) === 47) {
        end = lineEnd(i + 2);
      } else {
        const e = finder.find('*/', i + 2);
        end = e < 0 ? n : e + 2;
      }
      noteComment(i, end);
      i = end;
    } else if ((c === 35 && hashComments) || (c === 45 && dashComments && t.charCodeAt(i + 1) === 45)) {
      const end = lineEnd(i + 1);
      noteComment(i, end);
      i = end;
    } else if (lang.quotes.indexOf(String.fromCharCode(c)) >= 0) {
      const doc = !!lang.docStrings && ps < 0 && stack.length === 0;
      if (!doc && ps < 0) begin(i);
      const end = skipString(i, c);
      if (doc) noteComment(i, end);
      i = Math.max(end, i + 1);
    } else if (c === 60 && lang.heredoc && t.charCodeAt(i + 1) === 60 && heredocId(i)) {
      if (ps < 0) begin(i);
      const id = heredocId(i)!;
      let pos = lineEnd(i) + 1;
      let found = n;
      while (pos < n) {
        const eol = lineEnd(pos);
        if (t.slice(pos, eol).trim() === id) {
          found = eol;
          break;
        }
        pos = eol + 1;
      }
      i = Math.max(found, i + 2);
    } else if ((c === 117 || c === 85) && lang.urls && t.slice(i, i + 4).toLowerCase() === 'url(' && (i === 0 || !isIdent(t.charCodeAt(i - 1)))) {
      if (ps < 0) begin(i);
      let j = i + 4;
      while (isWs(t.charCodeAt(j))) j++;
      const q = t.charCodeAt(j);
      if (q === 34 || q === 39) j = skipString(j, q);
      const e = finder.find(')', j);
      i = e < 0 ? n : e + 1;
    } else if (((c === 35 && embeddedHash) || (c === 64 && embeddedAt)) && t.charCodeAt(i + 1) === 123) {
      if (ps < 0) begin(i);
      i = skipBraces(i + 2, false);
    } else {
      if (ps < 0) begin(i);
      if (c === 40 || c === 91) paren = Math.min(paren + 1, 1000);
      else if (c === 41 || c === 93) paren = Math.max(0, paren - 1);
      i++;
    }
  }
  if (lang.statements === 'line') finishStatement(n);
  while (stack.length) {
    const block = stack.pop();
    if (block?.node) {
      block.node.end = Math.max(block.node.start, src.count);
      siblings().push(block.node);
    }
  }
  return roots;
}
