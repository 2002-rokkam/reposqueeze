/**
 * XML, HTML and template scanner: one tolerant tag/directive tokenizer with an explicit element stack.
 *
 * Covers Maven poms, Spring/Blueprint beans, Android layouts, .csproj, AEM/Sling `.content.xml` (JCR
 * nodes are plain elements), HTML, Vue/Svelte single-file components and the block directives of
 * Jinja/Django/Twig/Liquid, Handlebars/Mustache, Go templates and Svelte.
 *
 * Robustness: no recursion over the input (explicit stack), depth capped at MAX_DEPTH nodes, tag length
 * capped, far-away searches (comment ends, quotes) memoised so malformed input cannot become quadratic.
 */
import { type Scan, type TreeNode, Cursor, Finder, RefSet, Source, clipLeft, lastSegment, looksLikeRef, tidy, walk } from './common.js';

export type MarkupMode = 'xml' | 'html' | 'vue' | 'svelte';

const MAX_DEPTH = 40;
const MAX_TAG = 100_000;
const MAX_NODES = 500_000;
const MAX_CLOSE_SEARCH = 256;
const MAX_ATTRS = 40;
const MAX_VALUE = 200;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'command', 'keygen', 'frame', 'basefont', 'bgsound']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
/** HTML elements whose end tag may be omitted: opening one of the keys closes an open element listed in its value. */
const IMPLIED_END: Record<string, readonly string[]> = {
  li: ['li'], p: ['p'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['td', 'th', 'tr'], td: ['td', 'th'], th: ['td', 'th'],
  option: ['option'], optgroup: ['option', 'optgroup'], thead: ['tbody', 'tfoot'], tbody: ['thead', 'tbody', 'tfoot'],
};

/** Attributes that identify an XML element, best first. */
const XML_IDENT = ['id', 'xml:id', 'name', 'Name', 'Id', 'jcr:title', 'fieldLabel', 'title', 'label', 'android:id', 'android:name', 'Include', 'Update', 'key', 'Key', 'ref', 'bean', 'class', 'path', 'sling:resourceType', 'cq:template', 'fragmentPath', 'jcr:primaryType'];
const XML_IDENT_SET = new Set(XML_IDENT);
const GENERIC_JCR_TYPES = new Set(['nt:unstructured', 'nt:folder', 'sling:Folder', 'sling:OrderedFolder']);
const HTML_INTEREST = new Set(['id', 'class', 'name', 'type', 'src', 'href', 'lang', 'setup', 'scoped', 'module', 'rel']);
/** Leaf elements whose text names their parent (`<artifactId>x</artifactId>`). */
const TEXT_IDENT = new Set(['groupId', 'artifactId', 'id', 'name', 'module', 'servlet-name', 'filter-name', 'param-name', 'display-name', 'key', 'title']);
/** Attributes shown first in an element signature. */
const SIGNATURE_FIRST = ['jcr:primaryType', 'sling:resourceType', 'sling:resourceSuperType', 'cq:template', 'fragmentPath', 'jcr:title', 'id', 'name', 'class', 'android:id'];
const REF_ATTRS = new Set(['class', 'ref', 'bean', 'parent', 'depends-on', 'type', 'extends', 'implements', 'src', 'href', 'path', 'file', 'include', 'update', 'package', 'base-package', 'layout', 'app:layout', 'tools:context', 'component', 'template', 'is', 'for']);

const TPL_BLOCKS = new Set([
  'block', 'if', 'for', 'macro', 'call', 'filter', 'with', 'autoescape', 'raw', 'verbatim', 'trans', 'blocktrans', 'cache', 'spaceless',
  'embed', 'apply', 'sandbox', 'capture', 'case', 'unless', 'form', 'paginate', 'tablerow', 'comment', 'schema', 'javascript',
  'stylesheet', 'ifchanged', 'ifequal', 'ifnotequal', 'language', 'localize', 'plural', 'translate', 'each', 'component', 'slot',
]);
const GO_BLOCKS = new Set(['if', 'range', 'with', 'define', 'block']);

interface Frame {
  tag: string;
  node: ENode;
  /** Offset just after the opening tag. */
  openEnd: number;
  props: Map<string, string> | undefined;
  hadChild: boolean;
  go: boolean;
  /** Name of the element before text-derived identification. */
  display: string;
  identified: boolean;
}

interface ENode extends TreeNode {
  tag: string;
  /** Offsets of the attribute text inside the opening tag. */
  attrStart: number;
  attrEnd: number;
  extra?: string[];
  children: ENode[];
}

interface TagInfo {
  name: string;
  start: number;
  end: number;
  nameEnd: number;
  closing: boolean;
  selfClosing: boolean;
  /** Offsets of the attribute text. */
  attrStart: number;
  attrEnd: number;
  /** Alternating name/value pairs of the attributes used for naming. */
  interest: string[];
}

const isWs = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** An attribute value without template expressions (`${...}`, `{{...}}`, `<%...%>`); empty when nothing static is left. */
function staticPart(value: string | undefined): string {
  return value ? value.replace(/\$\{[^}]*\}|\{\{[^}]*\}\}|<%[^%]*%>/g, ' ').trim() : '';
}

function isNameChar(c: number): boolean {
  return !(isWs(c) || c === 47 || c === 62 || c === 60 || c === 61 || c === 34 || c === 39 || Number.isNaN(c));
}

class Markup {
  private readonly t: string;
  private readonly n: number;
  private readonly html: boolean;
  private readonly find: Finder;
  private readonly cursor: Cursor;
  private readonly stack: Frame[] = [];
  private readonly roots: ENode[] = [];
  private overflow = 0;
  private nodes = 0;
  private comment: { startLine: number; endLine: number; endPos: number } | undefined;
  private readonly noClose = new Set<string>();
  private readonly templates: boolean;

  constructor(
    private readonly src: Source,
    private readonly mode: MarkupMode,
  ) {
    this.t = src.text;
    this.n = this.t.length;
    this.html = mode !== 'xml';
    this.templates = mode !== 'xml';
    this.find = new Finder(this.t);
    this.cursor = new Cursor(src);
  }

  run(): ENode[] {
    const t = this.t;
    const n = this.n;
    let i = t.charCodeAt(0) === 0xfeff ? 1 : 0;
    const next = this.templates ? /[<{]/g : /</g;
    while (i < n) {
      next.lastIndex = i;
      const m = next.exec(t);
      if (!m) break;
      i = m.index;
      if (t.charCodeAt(i) === 123) {
        i = this.template(i);
        continue;
      }
      i = this.markup(i);
    }
    this.closeAll();
    return this.roots;
  }

  private get top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** Handles `<...` at offset i; returns the offset to continue from. */
  private markup(i: number): number {
    const t = this.t;
    const c = t.charCodeAt(i + 1);
    if (c === 33) {
      if (t.startsWith('<!--', i)) return this.skipComment(i);
      if (t.startsWith('<![CDATA[', i)) {
        const e = this.find.find(']]>', i + 9);
        return e < 0 ? this.n : e + 3;
      }
      return this.skipDeclaration(i);
    }
    if (c === 63) {
      const e = this.find.find('?>', i + 2);
      return e < 0 ? this.n : e + 2;
    }
    const info = this.parseTag(i);
    if (!info) return i + 1;
    this.comment = this.comment && this.onlyWhitespace(this.comment.endPos, i) ? this.comment : undefined;
    if (info.closing) {
      this.closeTag(info);
      this.comment = undefined;
      return info.end;
    }
    return this.openTag(info);
  }

  private onlyWhitespace(from: number, to: number): boolean {
    if (to - from > 400) return false;
    for (let p = from; p < to; p++) if (!isWs(this.t.charCodeAt(p))) return false;
    return true;
  }

  private skipComment(i: number): number {
    const e = this.find.find('-->', i + 4);
    const end = e < 0 ? this.n : e + 3;
    this.comment = { startLine: this.cursor.to(i), endLine: this.cursor.to(Math.max(i, end - 1)), endPos: end };
    return end;
  }

  /** `<!DOCTYPE ...>` and friends, including an internal `[...]` subset. */
  private skipDeclaration(i: number): number {
    const t = this.t;
    let depth = 0;
    const limit = Math.min(this.n, i + MAX_TAG);
    for (let p = i + 2; p < limit; p++) {
      const c = t.charCodeAt(p);
      if (c === 91) depth++;
      else if (c === 93) depth = Math.max(0, depth - 1);
      else if (c === 62 && depth === 0) return p + 1;
    }
    return i + 2;
  }

  private parseTag(i: number): TagInfo | undefined {
    const t = this.t;
    const n = this.n;
    let j = i + 1;
    const closing = t.charCodeAt(j) === 47;
    if (closing) j++;
    const first = t.charCodeAt(j);
    const letter = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
    if (!(letter || (!this.html && (first === 95 || first === 58 || first > 127)))) return undefined;
    const nameStart = j;
    while (j < n && isNameChar(t.charCodeAt(j))) j++;
    const name = t.slice(nameStart, j);
    const info: TagInfo = { name: this.html ? name.toLowerCase() : name, start: i, end: 0, nameEnd: j, closing, selfClosing: false, attrStart: j, attrEnd: j, interest: [] };
    if (closing) {
      const e = this.find.find('>', j);
      if (e < 0 || e - i > MAX_TAG) return undefined;
      info.end = e + 1;
      return info;
    }

    const interesting = this.html ? HTML_INTEREST : null;
    let k = j;
    while (k < n) {
      if (k - i > MAX_TAG) return undefined;
      const c = t.charCodeAt(k);
      if (isWs(c)) {
        k++;
      } else if (c === 62) {
        info.end = k + 1;
        info.attrEnd = k;
        return info;
      } else if (c === 47) {
        if (t.charCodeAt(k + 1) === 62) {
          info.end = k + 2;
          info.attrEnd = k;
          info.selfClosing = true;
          return info;
        }
        k++;
      } else if (c === 60) {
        // A new tag starts inside this one: treat the broken tag as ending here.
        info.end = k;
        info.attrEnd = k;
        return info;
      } else if (c === 34 || c === 39) {
        k++;
      } else {
        const nameFrom = k;
        while (k < n && isNameChar(t.charCodeAt(k))) k++;
        if (k === nameFrom) k++;
        const attr = t.slice(nameFrom, k);
        let q = k;
        while (isWs(t.charCodeAt(q))) q++;
        let value = '';
        if (t.charCodeAt(q) === 61) {
          q++;
          while (isWs(t.charCodeAt(q))) q++;
          const quote = t.charCodeAt(q);
          if (quote === 34 || quote === 39) {
            const close = this.find.find(quote === 34 ? '"' : "'", q + 1);
            if (close < 0 || close - i > MAX_TAG) return undefined;
            if (!this.html) {
              const lt = this.find.find('<', q + 1);
              if (lt >= 0 && lt < close) return undefined;
            }
            value = t.slice(q + 1, Math.min(close, q + 1 + MAX_VALUE));
            k = close + 1;
          } else {
            let e = q;
            while (e < n && !isWs(t.charCodeAt(e)) && t.charCodeAt(e) !== 62) e++;
            value = t.slice(q, Math.min(e, q + MAX_VALUE));
            k = e;
          }
        }
        if (info.interest.length < 24 && (interesting ? interesting.has(attr) || attr.startsWith('data-sly-template') : XML_IDENT_SET.has(attr))) info.interest.push(attr, value);
      }
    }
    return undefined;
  }

  private attr(info: TagInfo, name: string): string | undefined {
    const pairs = info.interest;
    for (let at = 0; at < pairs.length; at += 2) if (pairs[at] === name) return pairs[at + 1];
    return undefined;
  }

  private openTag(info: TagInfo): number {
    const tag = info.name;
    const startLine = this.cursor.to(info.start);
    const endLine = this.cursor.to(info.end > info.start ? info.end - 1 : info.start);
    let start = startLine;
    // A comment right above an element documents it, except at the root where it is a file header.
    if (this.comment && this.stack.length && this.comment.endLine >= startLine - 1) start = Math.min(start, this.comment.startLine);
    this.comment = undefined;

    if (this.html) {
      const implied = IMPLIED_END[tag];
      if (implied) {
        while (this.top && !this.top.go && implied.includes(this.top.tag)) this.popFrame(Math.max(this.top.node.start, startLine - 1));
      }
    }
    const parent = this.top;
    if (parent) parent.hadChild = true;

    const [display, ident, kind] = this.describe(info);
    const node: ENode = {
      start, end: endLine, name: ident ? `${display} ${ident}` : display, kind, scopeName: !this.html && tag === 'items' ? '' : display, tag,
      attrStart: info.attrStart, attrEnd: info.attrEnd, children: [],
    };
    if (this.mode === 'vue' && !this.stack.length) node.kind = 'vue_block';
    if (this.mode === 'svelte' && !this.stack.length && (tag === 'script' || tag === 'style' || tag.startsWith('svelte:'))) node.kind = 'svelte_block';

    const selfClosing = info.selfClosing || (this.html && VOID.has(tag));
    if (selfClosing) {
      this.attachLeaf(node);
      return info.end;
    }
    if (this.html && RAW_TEXT.has(tag)) return this.rawText(node, info);
    if (this.stack.length >= MAX_DEPTH) {
      this.overflow++;
      return info.end;
    }
    this.stack.push({ tag, node, openEnd: info.end, props: undefined, hadChild: false, go: false, display, identified: !!ident });
    return info.end;
  }

  /** Display name, identifying value and kind of an element. */
  private describe(info: TagInfo): [string, string, string] {
    const tag = info.name;
    if (!this.html) {
      for (const key of XML_IDENT) {
        const value = this.attr(info, key);
        if (!value) continue;
        if (key === 'jcr:primaryType' && GENERIC_JCR_TYPES.has(value)) continue;
        const text = key === 'android:id' ? value.replace(/^@\+?id\//, '') : value;
        return [tag, /[/]/.test(text) ? clipLeft(text, 60) : tidy(text, 60), 'xml_element'];
      }
      return [tag, '', 'xml_element'];
    }
    const template = info.interest.findIndex((v, i) => i % 2 === 0 && v.startsWith('data-sly-template'));
    if (template >= 0) {
      const suffix = info.interest[template].slice('data-sly-template'.length).replace(/^\./, '');
      return [`template ${suffix}`.trim(), '', 'html_template'];
    }
    if (tag === 'template') return [tag, '', 'html_template'];
    if (tag === 'script' || tag === 'style') {
      const bits = ['src', 'type', 'lang', 'setup', 'scoped', 'module'].map(k => {
        const v = this.attr(info, k);
        return v === undefined ? '' : v ? `${k}=${tidy(v, 40)}` : k;
      });
      return [[tag, ...bits.filter(Boolean)].join(' '), '', tag === 'script' ? 'html_script' : 'html_style'];
    }
    const id = staticPart(this.attr(info, 'id'));
    if (id) return [`${tag}#${tidy(id, 50)}`, '', 'html_element'];
    const cls = staticPart(this.attr(info, 'class'));
    if (cls) return [`${tag}.${tidy(cls, 60).split(' ').slice(0, 2).join('.')}`, '', 'html_element'];
    const name = staticPart(this.attr(info, 'name'));
    if (name) return [`${tag}[name=${tidy(name, 40)}]`, '', 'html_element'];
    return [tag, '', 'html_element'];
  }

  private attachLeaf(node: ENode): void {
    const parent = this.top;
    if (this.stack.length >= MAX_DEPTH || (this.nodes >= MAX_NODES && node.end - node.start < 2)) return;
    this.nodes++;
    (parent ? parent.node.children : this.roots).push(node);
  }

  /** Skips the content of <script>/<style>/<textarea>/<title> up to its end tag. */
  private rawText(node: ENode, info: TagInfo): number {
    const tag = info.name;
    const t = this.t;
    let p = info.end;
    let end = -1;
    if (!this.noClose.has(tag)) {
      while (p < this.n) {
        const lt = this.find.find('</', p);
        if (lt < 0) break;
        if (t.slice(lt + 2, lt + 2 + tag.length).toLowerCase() === tag && !isNameChar(t.charCodeAt(lt + 2 + tag.length))) {
          const gt = this.find.find('>', lt);
          end = gt < 0 ? this.n : gt + 1;
          break;
        }
        p = lt + 2;
      }
      if (end < 0) this.noClose.add(tag);
    }
    if (end < 0) end = this.n;
    node.end = Math.max(node.start, this.cursor.to(Math.max(info.start, end - 1)));
    this.attachLeaf(node);
    return end;
  }

  private closeTag(info: TagInfo): void {
    if (this.overflow > 0) {
      this.overflow--;
      return;
    }
    let k = this.stack.length - 1;
    for (let steps = 0; k >= 0 && steps < MAX_CLOSE_SEARCH; k--, steps++) if (this.stack[k].tag === info.name) break;
    if (k < 0 || this.stack[k]?.tag !== info.name) return;
    const closeLine = this.cursor.to(info.start);
    while (this.stack.length - 1 > k) this.popFrame(Math.max(this.top!.node.start, closeLine - 1));
    this.popFrame(this.cursor.to(info.end - 1), info.start);
  }

  /** Closes the top frame at `endLine`; `closeAt` is the offset of its end tag (for text capture). */
  private popFrame(endLine: number, closeAt = -1): void {
    const frame = this.stack.pop()!;
    const node = frame.node;
    node.end = Math.max(node.start, endLine);
    const parent = this.top;
    if (!this.html && closeAt >= 0 && !frame.hadChild && TEXT_IDENT.has(frame.tag)) {
      // Text-only elements such as <artifactId>: they name their parent and carry their value in their own name.
      const text = this.t.slice(frame.openEnd, Math.min(closeAt, frame.openEnd + 200)).trim();
      if (text && text.length < 120 && text.indexOf('<') < 0) {
        if (parent) (parent.props ??= new Map()).set(frame.tag, text);
        if (!frame.identified) node.name = `${frame.display} ${tidy(text, 80)}`;
      }
    }
    if (frame.props && !frame.identified) this.identifyFromText(frame);
    if (this.nodes < MAX_NODES || node.end - node.start >= 2) {
      this.nodes++;
      (parent ? parent.node.children : this.roots).push(node);
    }
  }

  private identifyFromText(frame: Frame): void {
    const props = frame.props!;
    const group = props.get('groupId');
    const artifact = props.get('artifactId');
    let ident: string | undefined;
    if (artifact) ident = group && frame.tag !== 'project' ? `${group}:${artifact}` : artifact;
    else ident = ['id', 'name', 'servlet-name', 'filter-name', 'display-name', 'param-name', 'module', 'key', 'title'].map(k => props.get(k)).find(v => v);
    if (!ident) return;
    frame.node.name = `${frame.display} ${tidy(ident, 80)}`;
    frame.node.extra = [group, artifact].filter((v): v is string => !!v);
  }

  private closeAll(): void {
    while (this.stack.length) this.popFrame(this.src.count);
  }

  // ---- template directives -------------------------------------------------------------------

  private template(i: number): number {
    const t = this.t;
    const c = t.charCodeAt(i + 1);
    if (c === 37) return this.jinja(i);
    if (c === 123) return this.moustache(i);
    if (this.mode === 'svelte' && (c === 35 || c === 47)) return this.svelte(i, c === 35);
    return i + 1;
  }

  private tpl(start: number, end: number, word: string, arg: string, go: boolean): void {
    const startLine = this.cursor.to(start);
    const endLine = this.cursor.to(end - 1);
    const parent = this.top;
    if (parent) parent.hadChild = true;
    if (this.stack.length >= MAX_DEPTH) {
      this.overflow++;
      return;
    }
    const name = tidy(`${word} ${arg}`, 80);
    const node: ENode = { start: startLine, end: endLine, name, kind: 'tpl_block', scopeName: name, tag: `tpl:${word}`, attrStart: start, attrEnd: start, children: [] };
    this.stack.push({ tag: `tpl:${word}`, node, openEnd: end, props: undefined, hadChild: false, go, display: name, identified: true });
  }

  private endTpl(start: number, end: number, word: string, go: boolean): void {
    let k = this.stack.length - 1;
    for (let steps = 0; k >= 0 && steps < MAX_CLOSE_SEARCH; k--, steps++) {
      const frame = this.stack[k];
      if (go ? frame.go : frame.tag === `tpl:${word}`) break;
    }
    if (k < 0 || (go ? !this.stack[k].go : this.stack[k].tag !== `tpl:${word}`)) return;
    const closeLine = this.cursor.to(start);
    while (this.stack.length - 1 > k) this.popFrame(Math.max(this.top!.node.start, closeLine - 1));
    this.popFrame(this.cursor.to(end - 1));
  }

  /** `{% ... %}` (Jinja, Django, Twig, Nunjucks, Liquid). */
  private jinja(i: number): number {
    const e = this.find.find('%}', i + 2);
    if (e < 0 || e - i > 2000) return i + 2;
    const end = e + 2;
    const body = this.t.slice(i + 2, e).replace(/^[-+~]|[-+~]$/g, '').trim();
    const m = /^(\w+)\s*([\s\S]*)$/.exec(body);
    if (!m) return end;
    const word = m[1];
    if (word.startsWith('end') && word.length > 3) this.endTpl(i, end, word.slice(3), false);
    else if (TPL_BLOCKS.has(word) || (word === 'set' && !m[2].includes('='))) this.tpl(i, end, word, m[2], false);
    return end;
  }

  /** `{{#block}}`/`{{/block}}` (Handlebars, Mustache) and Go template actions. */
  private moustache(i: number): number {
    const e = this.find.find('}}', i + 2);
    if (e < 0 || e - i > 2000) return i + 2;
    const end = e + 2;
    const body = this.t.slice(i + 2, e).replace(/^[-~]|[-~]$/g, '').trim();
    if (body.startsWith('/')) {
      this.endTpl(i, end, body.slice(1).trim().split(/\s+/)[0], false);
    } else if (body.startsWith('#') || body.startsWith('^')) {
      const rest = body.replace(/^[#^]\s*[>*]?\s*/, '');
      const word = /^[\w.@-]+/.exec(rest)?.[0];
      if (word && body.startsWith('#')) this.tpl(i, end, word, rest.slice(word.length).trim(), false);
    } else {
      const m = /^(\w+)\s+(\S[\s\S]*)$/.exec(body);
      if (m && GO_BLOCKS.has(m[1])) this.tpl(i, end, m[1], m[2], true);
      else if (body === 'end') this.endTpl(i, end, 'end', true);
    }
    return end;
  }

  /** `{#if cond}` ... `{/if}` (Svelte). */
  private svelte(i: number, opening: boolean): number {
    const e = this.find.find('}', i + 2);
    if (e < 0 || e - i > 2000) return i + 2;
    const body = this.t.slice(i + 2, e).trim();
    const m = /^(\w+)\s*([\s\S]*)$/.exec(body);
    if (m) {
      if (opening) this.tpl(i, e + 1, m[1], m[2], false);
      else this.endTpl(i, e + 1, m[1], false);
    }
    return e + 1;
  }
}

// ---- lazily computed attribute details ---------------------------------------------------------

function parseAttrs(t: string, from: number, to: number): [string, string][] {
  const out: [string, string][] = [];
  let k = from;
  const end = Math.min(to, from + MAX_TAG);
  while (k < end && out.length < MAX_ATTRS) {
    const c = t.charCodeAt(k);
    if (isWs(c) || c === 47 || c === 34 || c === 39) {
      k++;
      continue;
    }
    const nameFrom = k;
    while (k < end && isNameChar(t.charCodeAt(k))) k++;
    if (k === nameFrom) {
      k++;
      continue;
    }
    const name = t.slice(nameFrom, k);
    while (isWs(t.charCodeAt(k))) k++;
    let value = '';
    if (t.charCodeAt(k) === 61) {
      k++;
      while (isWs(t.charCodeAt(k))) k++;
      const quote = t.charCodeAt(k);
      if (quote === 34 || quote === 39) {
        const close = t.indexOf(quote === 34 ? '"' : "'", k + 1);
        const stop = close < 0 || close > end ? end : close;
        // Whitespace is collapsed before clipping so CRLF and indentation never change which part of the value is kept.
        value = t.slice(k + 1, Math.min(stop, k + 1 + MAX_VALUE * 4)).replace(/\s+/g, ' ').slice(0, MAX_VALUE);
        k = stop + 1;
      } else {
        let e = k;
        while (e < end && !isWs(t.charCodeAt(e))) e++;
        value = t.slice(k, Math.min(e, k + MAX_VALUE));
        k = e;
      }
    }
    out.push([name, value]);
  }
  return out;
}

function signatureOf(t: string, node: ENode): string {
  if (node.kind === 'tpl_block') return node.name;
  const attrs = parseAttrs(t, node.attrStart, node.attrEnd).filter(([name]) => !name.startsWith('xmlns'));
  const rank = (name: string): number => {
    const at = SIGNATURE_FIRST.indexOf(name);
    return at < 0 ? SIGNATURE_FIRST.length : at;
  };
  const ordered = attrs.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a[0]) - rank(y.a[0]) || x.i - y.i);
  let out = `<${node.tag}`;
  for (const { a } of ordered) {
    // Collapse whitespace first so line-ending style never changes how many attributes fit.
    const value = a[1].replace(/\s+/g, ' ');
    const piece = value ? ` ${a[0]}="${value}"` : ` ${a[0]}`;
    if (out.length + piece.length > 230) break;
    out += piece;
  }
  return `${out}>`;
}

function nodeRefs(t: string, node: ENode, refs: RefSet): void {
  if (node.extra) for (const ref of node.extra) refs.add(ref);
  if (node.kind === 'tpl_block' || node.attrEnd <= node.attrStart) return;
  for (const [name, value] of parseAttrs(t, node.attrStart, node.attrEnd)) {
    if (!value || name.startsWith('xmlns') || value.length > 160) continue;
    if (/^(?:https?:|mailto:|data:|#)/i.test(value)) continue;
    if (name === 'jcr:primaryType' && GENERIC_JCR_TYPES.has(value)) continue;
    if (/^@(?:\+?id|string|layout|drawable|style|color|dimen)\//.test(value)) {
      refs.add(value);
      refs.add(value.slice(value.lastIndexOf('/') + 1));
    } else if (name.startsWith('data-sly-') || name.startsWith('th:') || name.startsWith('v-') || name.startsWith(':')) {
      const m = /^\$\{\s*([\w.@/-]+)/.exec(value);
      const target = m ? m[1] : value;
      if (looksLikeRef(target)) {
        refs.add(target);
        if (/[./]/.test(target)) refs.add(lastSegment(target));
      }
    } else if (REF_ATTRS.has(name) || looksLikeRef(value)) {
      if (!looksLikeRef(value) && !/^[A-Za-z_][\w$.-]*$/.test(value)) continue;
      refs.add(value);
      if (/[./]/.test(value)) refs.add(lastSegment(value));
    }
  }
}

export function scanMarkup(src: Source, mode: MarkupMode): Scan {
  const roots = new Markup(src, mode).run();
  const t = src.text;
  return {
    roots,
    plan: {
      signature: (_s, _e, nodes) => (nodes.length === 1 ? signatureOf(t, nodes[0] as ENode) : undefined),
      refs: (_s, _e, nodes) => {
        const refs = new RefSet();
        walk(nodes, node => nodeRefs(t, node as ENode, refs));
        return refs.list;
      },
    },
  };
}
