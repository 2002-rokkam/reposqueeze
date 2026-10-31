/**
 * YAML outline by indentation (no full parse): mappings, sequence items, documents and block scalars.
 * Tuned for GitHub Actions, docker-compose, Kubernetes (multi-document), OpenAPI, Helm values and Ansible.
 */
import { type Scan, type TreeNode, RefSet, Source, lastSegment, looksLikeRef, tidy } from './common.js';

const MAX_DEPTH = 14;
const MAX_FLOW_LINES = 400;
const MAX_PARSE = 600;
/** Scalar keys that name the mapping or sequence item containing them, best first. */
const LABEL_KEYS = ['name', 'id', 'uses', 'title', 'key', 'image', 'hosts', 'role', 'task', 'job', 'stage', 'target', 'path', 'src', 'run'];
const CAPTURED = new Set([...LABEL_KEYS, 'operationId', 'summary']);
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

interface YNode extends TreeNode {
  indent: number;
  item: boolean;
  /** Dotted path from the document root, e.g. `jobs.build.steps[2]`. */
  path: string;
  /** The raw key, or `[i]` for sequence items. */
  key: string;
  parent: YNode | undefined;
  /** The key carries its value on the same line (scalar, flow collection or block scalar). */
  inline: boolean;
  itemCount: number;
  props: Map<string, string> | undefined;
  children: TreeNode[];
}

interface Doc {
  start: number;
  roots: TreeNode[];
  topItems: number;
  kind: string | undefined;
  metaName: string | undefined;
  end: number;
}

const isSpace = (c: number): boolean => c === 32 || c === 9;

function parseKey(s: string, from: number): { key: string; value: number } | undefined {
  const len = Math.min(s.length, from + MAX_PARSE);
  const c = s.charCodeAt(from);
  if (c === 34 || c === 39) {
    let j = from + 1;
    while (j < len) {
      const d = s.charCodeAt(j);
      if (d === c) {
        if (c === 39 && s.charCodeAt(j + 1) === 39) {
          j += 2;
          continue;
        }
        break;
      }
      if (d === 92 && c === 34) j++;
      j++;
    }
    if (j >= len) return undefined;
    let k = j + 1;
    while (isSpace(s.charCodeAt(k))) k++;
    const after = s.charCodeAt(k + 1);
    if (s.charCodeAt(k) === 58 && (Number.isNaN(after) || isSpace(after))) return { key: s.slice(from + 1, j), value: k + 1 };
    return undefined;
  }
  // Flow collections, tags, anchors, aliases, block indicators, directives and complex keys are not plain keys.
  if (c === 91 || c === 123 || c === 33 || c === 38 || c === 42 || c === 124 || c === 62 || c === 37 || c === 64 || c === 96) return undefined;
  if (c === 63 && (Number.isNaN(s.charCodeAt(from + 1)) || isSpace(s.charCodeAt(from + 1)))) return undefined;
  for (let j = from; j < len; j++) {
    const d = s.charCodeAt(j);
    if (d === 58) {
      const e = s.charCodeAt(j + 1);
      if (Number.isNaN(e) || isSpace(e)) return j > from ? { key: s.slice(from, j).trimEnd(), value: j + 1 } : undefined;
    } else if (d === 35 && j > from && isSpace(s.charCodeAt(j - 1))) {
      return undefined;
    }
  }
  return undefined;
}

/** Net open flow brackets ([ and {) in `s`, ignoring quoted text and comments. */
function flowBalance(s: string): number {
  const len = Math.min(s.length, 2000);
  let balance = 0;
  for (let j = 0; j < len; j++) {
    const d = s.charCodeAt(j);
    if (d === 34 || d === 39) {
      j++;
      while (j < len && s.charCodeAt(j) !== d) j += d === 34 && s.charCodeAt(j) === 92 ? 2 : 1;
    } else if (d === 91 || d === 123) balance++;
    else if (d === 93 || d === 125) balance--;
    else if (d === 35 && j > 0 && isSpace(s.charCodeAt(j - 1))) break;
  }
  return balance;
}

const BLOCK_SCALAR = /^[|>][-+0-9]*\s*(?:#.*)?$/;
const OPEN_VALUE = /^(?:[&!]\S*\s*)*(?:#.*)?$/;

function unquoteScalar(value: string): string {
  const v = value.replace(/\s+#.*$/, '').trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

class YamlOutline {
  readonly docs: Doc[] = [];
  private doc: Doc = { start: 1, roots: [], topItems: 0, kind: undefined, metaName: undefined, end: 0 };
  private readonly stack: YNode[] = [];
  private last = 0;
  private block: { indent: number; owner: YNode | undefined; key: string; labelPending: boolean } | undefined;
  private flow = 0;
  private flowLines = 0;

  constructor(private readonly src: Source) {}

  run(): void {
    for (let n = 1; n <= this.src.count; n++) {
      const raw = this.src.lines[n - 1];
      if (this.continuation(n, raw)) continue;
      let p = 0;
      while (p < raw.length && isSpace(raw.charCodeAt(p))) p++;
      if (p >= raw.length) continue;
      const c = raw.charCodeAt(p);
      if (c === 35 || (p === 0 && c === 37)) continue;
      if (p === 0 && raw.startsWith('---') && (raw.length === 3 || isSpace(raw.charCodeAt(3)))) {
        this.endDoc();
        this.doc = { start: n, roots: [], topItems: 0, kind: undefined, metaName: undefined, end: 0 };
        continue;
      }
      if (p === 0 && raw.startsWith('...') && raw.trim() === '...') {
        this.endDoc();
        this.doc = { start: n + 1, roots: [], topItems: 0, kind: undefined, metaName: undefined, end: 0 };
        continue;
      }
      // Template directives on their own line (Helm, Jinja) do not take part in the structure.
      if (c === 123 && (raw.charCodeAt(p + 1) === 123 || raw.charCodeAt(p + 1) === 37 || raw.charCodeAt(p + 1) === 35)) continue;
      this.entry(n, raw, p);
    }
    this.endDoc();
  }

  /** Lines inside block scalars and multi-line flow collections are content of the node above. */
  private continuation(n: number, raw: string): boolean {
    if (this.block) {
      if (!raw.trim()) return true;
      let indent = 0;
      while (indent < raw.length && isSpace(raw.charCodeAt(indent))) indent++;
      if (indent > this.block.indent) {
        if (this.block.labelPending && this.block.owner) {
          (this.block.owner.props ??= new Map()).set(this.block.key, raw.trim());
          this.block.labelPending = false;
        }
        this.last = n;
        return true;
      }
      this.block = undefined;
    }
    if (this.flow > 0) {
      this.flow += flowBalance(raw);
      this.last = n;
      if (this.flow < 0 || ++this.flowLines > MAX_FLOW_LINES) this.flow = 0;
      return true;
    }
    return false;
  }

  private entry(n: number, raw: string, p: number): void {
    const dash = raw.charCodeAt(p) === 45 && (p + 1 >= raw.length || isSpace(raw.charCodeAt(p + 1)));
    let content = p;
    if (dash) {
      content = p + 1;
      while (content < raw.length && isSpace(raw.charCodeAt(content))) content++;
    }
    const key = content < raw.length ? parseKey(raw, content) : undefined;

    if (dash) this.pop(top => top.indent > p || (top.indent === p && (top.item || top.inline)));
    else this.pop(top => top.indent >= p);
    this.last = n;

    let owner = this.stack[this.stack.length - 1];
    let item: YNode | undefined;
    if (dash && this.stack.length < MAX_DEPTH) {
      const index = owner ? owner.itemCount++ : this.doc.topItems++;
      const path = `${owner ? owner.path : ''}[${index}]`;
      item = { start: n, end: n, name: path, kind: 'yaml_item', indent: p, item: true, path, key: `[${index}]`, parent: owner, inline: false, itemCount: 0, props: undefined, children: [] };
      this.attach(owner, item);
      owner = item;
    }

    const rest = raw.slice(key ? key.value : content, (key ? key.value : content) + MAX_PARSE).trim();
    if (key) {
      const created = this.stack.length <= MAX_DEPTH ? this.keyNode(n, content, key.key, owner) : undefined;
      this.value(rest, content, key.key, owner, created);
    } else if (item) {
      item.inline = rest !== '' && !rest.startsWith('#');
      if (item.inline) {
        if (BLOCK_SCALAR.test(rest)) this.block = { indent: p, owner: undefined, key: '', labelPending: false };
        else if (rest.charCodeAt(0) === 91 || rest.charCodeAt(0) === 123) this.openFlow(rest);
        else (item.props ??= new Map()).set('name', unquoteScalar(rest));
      }
    }
  }

  private attach(parent: YNode | undefined, node: YNode): void {
    (parent ? parent.children : this.doc.roots).push(node);
    this.stack.push(node);
  }

  private keyNode(n: number, col: number, key: string, parent: YNode | undefined): YNode {
    const path = parent ? `${parent.path}.${key}` : key;
    const node: YNode = { start: n, end: n, name: path, kind: 'yaml_key', scopeName: key, indent: col, item: false, path, key, parent, inline: false, itemCount: 0, props: undefined, children: [] };
    this.attach(parent, node);
    return node;
  }

  private value(rest: string, col: number, key: string, mapping: YNode | undefined, node: YNode | undefined): void {
    if (BLOCK_SCALAR.test(rest)) {
      if (node) node.inline = true;
      this.block = { indent: col, owner: mapping, key, labelPending: key === 'run' || key === 'script' };
    } else if (rest === '' || OPEN_VALUE.test(rest)) {
      if (node) node.inline = false;
    } else {
      if (node) node.inline = true;
      if (rest.charCodeAt(0) === 91 || rest.charCodeAt(0) === 123) {
        this.openFlow(rest);
        return;
      }
      const text = unquoteScalar(rest);
      if (mapping && CAPTURED.has(key)) (mapping.props ??= new Map()).set(key, text);
      if (!mapping && key === 'kind') this.doc.kind = text;
    }
  }

  private openFlow(rest: string): void {
    const balance = flowBalance(rest);
    if (balance > 0) {
      this.flow = balance;
      this.flowLines = 0;
    }
  }

  private pop(test: (top: YNode) => boolean): void {
    while (this.stack.length && test(this.stack[this.stack.length - 1])) this.finalize(this.stack.pop()!);
  }

  private finalize(node: YNode): void {
    node.end = Math.max(node.start, this.last);
    if (node.item) {
      const label = LABEL_KEYS.map(k => node.props?.get(k)).find(v => v);
      if (label) {
        node.name = `${node.path} ${tidy(label, 60)}`;
        node.scopeName = tidy(label, 60);
      } else {
        node.scopeName = node.key;
      }
      return;
    }
    const top = !node.parent;
    if (top && node.key === 'metadata') this.doc.metaName = node.props?.get('name');
    const path = node.parent;
    if (HTTP_METHODS.has(node.key) && path?.key.startsWith('/') && path.parent?.key === 'paths' && !path.parent.parent) {
      const label = node.props?.get('operationId') ?? node.props?.get('summary');
      node.name = `${node.key.toUpperCase()} ${path.key}${label ? ` ${tidy(label, 60)}` : ''}`;
    } else if (node.key.startsWith('/') && path?.key === 'paths' && !path.parent && node.children.length === 1 && /^[A-Z]+ /.test(node.children[0].name)) {
      // A path item with a single operation is named after that operation.
      node.name = node.children[0].name;
    }
  }

  private endDoc(): void {
    this.pop(() => true);
    this.doc.end = this.last;
    if (this.doc.roots.length) this.docs.push(this.doc);
  }
}

function docName(doc: Doc, index: number): string {
  if (doc.kind && doc.metaName) return `${doc.kind}/${tidy(doc.metaName, 60)}`;
  return doc.kind ?? `document ${index + 1}`;
}

/** One document keeps its keys as the outline; several (or a Kubernetes manifest) get a node per document. */
function assemble(docs: Doc[]): TreeNode[] {
  if (docs.length === 0) return [];
  if (docs.length === 1 && !docs[0].kind) return docs[0].roots;
  return docs.map((doc, index) => ({
    start: doc.start,
    end: Math.max(doc.end, doc.roots[doc.roots.length - 1].end),
    name: docName(doc, index),
    kind: 'yaml_doc',
    children: doc.roots,
  }));
}

const SCALAR_LINE = /^\s*(?:-\s+)?(?:([\w$.@/-]{1,60}):\s+)?(.{1,200}?)\s*$/;
const ID_LIKE = /^[A-Za-z_][\w.-]{2,60}$/;
const IDENTIFIER_KEYS = new Set(['needs', 'depends_on', 'extends', 'service', 'servicename', 'secretname', 'configmapname', 'claimname', 'targetref', 'include', 'import']);

function yamlRefs(lines: readonly string[], start: number, end: number): string[] {
  const refs = new RefSet();
  for (let n = start; n <= end && !refs.full; n++) {
    const line = lines[n - 1];
    if (line.length > 1000 || line.charCodeAt(0) === 35) continue;
    const m = SCALAR_LINE.exec(line);
    if (!m) continue;
    const key = (m[1] ?? '').toLowerCase();
    const value = unquoteScalar(m[2]);
    if (!value || value.startsWith('#')) continue;
    if (key === 'uses') {
      const action = value.replace(/@.*$/, '');
      refs.add(action);
      refs.add(lastSegment(action));
    } else if (key === 'image') {
      const image = value.replace(/[@:][^/]*$/, '');
      refs.add(image);
      refs.add(lastSegment(image));
    } else if (key === '$ref') {
      refs.add(value.slice(value.lastIndexOf('/') + 1));
    } else if (IDENTIFIER_KEYS.has(key)) {
      for (const part of value.replace(/^\[|\]$/g, '').split(',')) if (ID_LIKE.test(part.trim())) refs.add(part.trim());
    } else if (looksLikeRef(value) && /[./]/.test(value)) {
      refs.add(value);
    }
  }
  return refs.list;
}

export function scanYaml(src: Source): Scan {
  const outline = new YamlOutline(src);
  outline.run();
  return {
    roots: assemble(outline.docs),
    plan: { comment: n => /^\s*#/.test(src.lines[n - 1] ?? ''), refs: (s, e) => yamlRefs(src.lines, s, e) },
  };
}
