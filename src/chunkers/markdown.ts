/** Markdown / MDX, reStructuredText and AsciiDoc: sections from headings, with code blocks and tables as detail nodes. */
import { type Scan, type TreeNode, RefSet, Source, lastSegment, tidy } from './common.js';

export type DocFlavor = 'md' | 'rst' | 'adoc';

interface Section extends TreeNode {
  level: number;
  children: TreeNode[];
}

const MIN_BLOCK_LINES = 5;
const MAX_FRONT_MATTER = 150;
const LINE_HEAD = 400;
/** Pseudo level of the text before the first heading; any real heading ends it. */
const INTRO_LEVEL = 99;

/** Builds the heading hierarchy; sections end where a heading of the same or a higher level begins. */
class SectionTree {
  readonly roots: TreeNode[] = [];
  private readonly stack: Section[] = [];

  constructor(
    private readonly src: Source,
    private readonly kind: string,
  ) {}

  open(level: number, start: number, name: string): void {
    while (this.stack.length && this.stack[this.stack.length - 1].level >= level) this.stack.pop()!.end = start - 1;
    const node: Section = { start, end: start, name, kind: this.kind, level, children: [] };
    this.attach(node);
    this.stack.push(node);
  }

  /** Starts the untitled section holding the text before the first heading. */
  intro(line: number): void {
    if (!this.stack.length && !this.src.isBlank(line)) this.open(INTRO_LEVEL, line, headingText(this.src.line(line)).slice(0, 80) || 'intro');
  }

  attach(node: TreeNode): void {
    (this.stack.length ? this.stack[this.stack.length - 1].children : this.roots).push(node);
  }

  finish(): TreeNode[] {
    for (const section of this.stack) section.end = this.src.count;
    return this.roots;
  }
}

function headingText(raw: string): string {
  let s = raw.length > LINE_HEAD ? raw.slice(0, LINE_HEAD) : raw;
  s = s.replace(/[ \t]+#+[ \t]*$/, '').replace(/\{#[^}]*\}\s*$/, '');
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  s = s.replace(/<[^>]*>/g, ' ').replace(/[`*~]+/g, '').replace(/(^|\s)_+|_+(\s|$)/g, '$1$2');
  return tidy(s, 120);
}

function atxHeading(line: string): { level: number; text: string } | undefined {
  let p = 0;
  while (p < 3 && line.charCodeAt(p) === 32) p++;
  let hashes = 0;
  while (line.charCodeAt(p + hashes) === 35) hashes++;
  if (hashes < 1 || hashes > 6) return undefined;
  const after = line.charCodeAt(p + hashes);
  if (!Number.isNaN(after) && after !== 32 && after !== 9) return undefined;
  return { level: hashes, text: line.slice(p + hashes, p + hashes + LINE_HEAD) };
}

function fenceOpening(line: string): { char: string; length: number } | undefined {
  let p = 0;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  const c = line[p];
  if (c !== '`' && c !== '~') return undefined;
  let length = 0;
  while (line[p + length] === c) length++;
  if (length < 3) return undefined;
  if (c === '`' && line.indexOf('`', p + length) >= 0) return undefined;
  return { char: c, length };
}

function fenceClosing(line: string, char: string, length: number): boolean {
  let p = 0;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  let run = 0;
  while (line[p + run] === char) run++;
  if (run < length) return false;
  for (let q = p + run; q < line.length; q++) if (line[q] !== ' ' && line[q] !== '\t') return false;
  return true;
}

function setextUnderline(line: string): 1 | 2 | undefined {
  if (line.length > 200) return undefined;
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  if (!m) return undefined;
  return m[1][0] === '=' ? 1 : 2;
}

/** A line that can be the text of a setext heading (not a list, quote, table, fence, heading or code). */
function plainText(line: string): boolean {
  if (/^ {4}|^\t/.test(line)) return false;
  const t = line.length > LINE_HEAD ? line.slice(0, LINE_HEAD).trim() : line.trim();
  if (!t) return false;
  return !/^(?:[#>|<`~[]|[-*+]\s|\d+[.)]\s|={3,}|-{3,}|\*{3,}|_{3,})/.test(t);
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function frontMatterEnd(src: Source): number {
  const first = src.line(1).trim();
  const closer = first === '---' ? /^(?:---|\.\.\.)\s*$/ : first === '+++' ? /^\+\+\+\s*$/ : undefined;
  if (!closer) return 0;
  const limit = Math.min(src.count, MAX_FRONT_MATTER);
  for (let n = 2; n <= limit; n++) if (closer.test(src.line(n))) return n;
  return 0;
}

function frontMatterTitle(src: Source, end: number): string {
  for (let n = 2; n < end; n++) {
    const line = src.line(n);
    if (line.length > 300) continue;
    const m = /^(?:title|name)\s*[:=]\s*(.*)$/i.exec(line);
    if (m) return tidy(m[1].replace(/^["']|["']$/g, ''), 120);
  }
  return '';
}

function tableName(header: string): string {
  const cells = header.slice(0, LINE_HEAD).split('|').map(headingText).filter(Boolean);
  return cells.slice(0, 5).join(', ') || 'table';
}

function codeNode(src: Source, start: number, end: number, opening: string): TreeNode | undefined {
  if (end - start + 1 < MIN_BLOCK_LINES) return undefined;
  const info = opening.trim().replace(/^[`~]+\s*/, '').split(/[\s{]/)[0];
  const body = tidy(src.line(src.firstContent(start + 1, end)), 60);
  return { start, end, name: [info, body].filter(Boolean).join(': ') || 'code', kind: 'md_code', scopeName: 'code' };
}

function scanMarkdownLike(src: Source): { roots: TreeNode[]; fenced: Uint8Array } {
  const tree = new SectionTree(src, 'md_section');
  /** Lines of fences, HTML comments and front matter: not prose, so no refs and no headings. */
  const fenced = new Uint8Array(src.count + 2);
  let n = 1;

  const fm = frontMatterEnd(src);
  if (fm) {
    tree.attach({ start: 1, end: fm, name: frontMatterTitle(src, fm) || 'front matter', kind: 'md_frontmatter' });
    fenced.fill(1, 1, fm + 1);
    n = fm + 1;
  }

  let fence: { char: string; length: number; start: number } | undefined;
  let comment = false;
  let previousText = 0;

  for (; n <= src.count; n++) {
    const line = src.lines[n - 1];
    if (fence) {
      fenced[n] = 1;
      if (fenceClosing(line, fence.char, fence.length)) {
        const node = codeNode(src, fence.start, n, src.line(fence.start));
        if (node) tree.attach(node);
        fence = undefined;
      }
      previousText = 0;
      continue;
    }
    if (comment) {
      fenced[n] = 1;
      if (line.includes('-->')) comment = false;
      previousText = 0;
      continue;
    }
    const opening = fenceOpening(line.length > LINE_HEAD ? line.slice(0, LINE_HEAD) : line);
    if (opening) {
      tree.intro(n);
      fence = { ...opening, start: n };
      fenced[n] = 1;
      previousText = 0;
      continue;
    }
    const open = line.indexOf('<!--');
    if (open >= 0 && line.slice(0, open).trim() === '' && !line.includes('-->', open + 4)) {
      comment = true;
      fenced[n] = 1;
      previousText = 0;
      continue;
    }
    const atx = atxHeading(line);
    if (atx) {
      tree.open(atx.level, n, headingText(atx.text) || 'untitled');
      previousText = 0;
      continue;
    }
    const underline = previousText ? setextUnderline(line) : undefined;
    if (underline) {
      tree.open(underline, previousText, headingText(src.line(previousText)) || 'untitled');
      previousText = 0;
      continue;
    }
    if (line.includes('|') && n < src.count && TABLE_DELIMITER.test(src.line(n + 1)) && src.line(n + 1).includes('-')) {
      let last = n + 1;
      while (last < src.count && src.line(last + 1).includes('|') && !src.isBlank(last + 1)) last++;
      tree.intro(n);
      if (last - n + 1 >= MIN_BLOCK_LINES) tree.attach({ start: n, end: last, name: tableName(line), kind: 'md_table', scopeName: 'table' });
      previousText = 0;
      n = last;
      continue;
    }
    tree.intro(n);
    previousText = plainText(line) ? n : 0;
  }
  if (fence) {
    const node = codeNode(src, fence.start, src.count, src.line(fence.start));
    if (node) tree.attach(node);
  }
  return { roots: tree.finish(), fenced };
}

const INLINE_CODE = /`([^`\n]{1,80})`/g;
const LINK_TARGET = /\]\(\s*<?([^)\s>]{1,160})/g;
const CODE_REF = /^[A-Za-z_$@.~/-][\w$@.~/:#<>-]*(?:\(\))?$/;

function markdownRefs(src: Source, start: number, end: number, fenced: Uint8Array): string[] {
  const refs = new RefSet();
  for (let n = start; n <= end && !refs.full; n++) {
    if (fenced[n]) continue;
    const line = src.lines[n - 1];
    if (line.length > 2000 || (line.indexOf('`') < 0 && line.indexOf('](') < 0)) continue;
    for (const m of line.matchAll(INLINE_CODE)) {
      const text = m[1].trim().replace(/\(\)$/, '').replace(/^-+/, '');
      if (CODE_REF.test(text)) refs.add(text);
    }
    for (const m of line.matchAll(LINK_TARGET)) {
      const target = m[1].replace(/[#?].*$/, '');
      if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      refs.add(target);
      refs.add(lastSegment(target));
    }
  }
  return refs.list;
}

function markupRefs(src: Source, start: number, end: number, pattern: RegExp): string[] {
  const refs = new RefSet();
  for (let n = start; n <= end && !refs.full; n++) {
    const line = src.lines[n - 1];
    if (line.length > 2000) continue;
    for (const m of line.matchAll(pattern)) {
      const target = (m[1] ?? m[2] ?? '').trim().replace(/^[~!.]+/, '').replace(/[#?].*$/, '');
      if (!target || /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue;
      refs.add(target);
      if (/[./]/.test(target)) refs.add(lastSegment(target));
    }
  }
  return refs.list;
}

const RST_ROLE = /:[a-z:]{2,20}:`([^`\n]{1,100})`|``([^`\n]{1,80})``/g;
const ADOC_REF = /(?:xref:|include::|link:|image::?)([^\s[]{1,120})|<<([^>,\n]{1,80})/g;
const ADORNMENT = /^([!-/:-@[-`{-~])\1{2,}\s*$/;

function scanRst(src: Source): TreeNode[] {
  const tree = new SectionTree(src, 'rst_section');
  const styles: string[] = [];
  const level = (style: string): number => {
    const at = styles.indexOf(style);
    return at < 0 ? styles.push(style) : at + 1;
  };
  const adorned = (n: number): boolean => n >= 1 && n <= src.count && src.line(n).length < 400 && ADORNMENT.test(src.line(n));
  const title = (n: number): boolean => {
    const line = src.line(n);
    return n <= src.count && line.length > 0 && line.length < 200 && !/^\s/.test(line) && !ADORNMENT.test(line) && !/^(?:\.\.|[-*+•]\s|\d+[.)]\s|:\w)/.test(line);
  };
  const closed = (n: number): boolean => n >= src.count || src.isBlank(n + 1);

  for (let n = 1; n <= src.count; n++) {
    if (adorned(n) && title(n + 1) && adorned(n + 2) && src.line(n).trim()[0] === src.line(n + 2).trim()[0] && closed(n + 2)) {
      tree.open(level(src.line(n).trim()[0] + '+'), n, headingText(src.line(n + 1)) || 'untitled');
      n += 2;
    } else if (title(n) && adorned(n + 1) && (n === 1 || src.isBlank(n - 1)) && closed(n + 1)) {
      tree.open(level(src.line(n + 1).trim()[0]), n, headingText(src.line(n)) || 'untitled');
      n += 1;
    } else {
      tree.intro(n);
    }
  }
  return tree.finish();
}

const ADOC_DELIMITER = /^(?:-{4,}|\.{4,}|\+{4,}|\/{4,}|={4,}|\*{4,}|_{4,}|\|={3,})$/;

function scanAdoc(src: Source): TreeNode[] {
  const tree = new SectionTree(src, 'adoc_section');
  let block: { delimiter: string; start: number } | undefined;
  for (let n = 1; n <= src.count; n++) {
    const line = src.lines[n - 1];
    const trimmed = line.length > 200 ? '' : line.trim();
    if (block) {
      if (trimmed === block.delimiter) {
        if (n - block.start + 1 >= MIN_BLOCK_LINES) {
          const table = block.delimiter[0] === '|';
          const label = tidy(src.line(src.firstContent(block.start + 1, n - 1)), 60);
          tree.attach({ start: block.start, end: n, name: label || 'block', kind: table ? 'adoc_table' : 'adoc_code', scopeName: table ? 'table' : 'code' });
        }
        block = undefined;
      }
      continue;
    }
    if (ADOC_DELIMITER.test(trimmed)) {
      tree.intro(n);
      block = { delimiter: trimmed, start: n };
      continue;
    }
    const m = /^(={1,6})[ \t]+(\S.*)$/.exec(line.length > LINE_HEAD ? line.slice(0, LINE_HEAD) : line);
    if (m) tree.open(m[1].length, n, headingText(m[2].replace(/[ \t]+=+$/, '')) || 'untitled');
    else tree.intro(n);
  }
  return tree.finish();
}

export function scanMarkdown(src: Source, flavor: DocFlavor): Scan {
  if (flavor === 'rst') return { roots: scanRst(src), plan: { refs: (s, e) => markupRefs(src, s, e, RST_ROLE) } };
  if (flavor === 'adoc') return { roots: scanAdoc(src), plan: { refs: (s, e) => markupRefs(src, s, e, ADOC_REF) } };
  const { roots, fenced } = scanMarkdownLike(src);
  return { roots, plan: { refs: (s, e) => markdownRefs(src, s, e, fenced) } };
}
