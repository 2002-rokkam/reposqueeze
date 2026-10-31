/** Streaming JSON / JSONC / JSON5 scanner: an outline of object entries and array items without building values. */
import { type Scan, type TreeNode, RefSet, Source, looksLikeRef, tidy, walk } from './common.js';

/** Containers nested deeper than this are tracked for bracket matching only. */
const MAX_DEPTH = 10;
const MAX_NODES = 400_000;
const MAX_TOKEN = 200;
/** Keys whose scalar value names the object that contains them, best first. */
const LABEL_KEYS = ['name', 'id', 'title', 'key', 'label', 'operationId', '$id', 'path', 'type'];

/** Maps in well-known manifests whose single-line entries are worth their own span (`scripts.build`). */
const MANIFEST_MAPS: Record<string, ReadonlySet<string>> = {
  'package.json': new Set(['scripts', 'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'engines', 'bin']),
  'composer.json': new Set(['require', 'require-dev', 'scripts']),
  'bower.json': new Set(['dependencies', 'devDependencies']),
};
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

interface Frame {
  object: boolean;
  parent: Frame | undefined;
  top: boolean;
  /** Line where the entry holding this container begins (the key line for object entries). */
  start: number;
  path: string;
  /** Object key under which this container sits, or `[i]` for array items. */
  key: string;
  index: number;
  children: TreeNode[];
  expectKey: boolean;
  pendingKey: string | undefined;
  pendingLine: number;
  label: string | undefined;
  labelRank: number;
  manifest: boolean;
}

function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function unquote(raw: string): string {
  return raw.indexOf('\\') >= 0 ? raw.replace(/\\(["'\\/])/g, '$1') : raw;
}

export function scanJson(src: Source, path: string): Scan | undefined {
  const t = src.text;
  const n = t.length;
  if (n > 100_000 && n / src.count > 2000) return undefined;
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase();
  const manifestMaps = Object.hasOwn(MANIFEST_MAPS, base) ? MANIFEST_MAPS[base] : undefined;

  const roots: TreeNode[] = [];
  const stack: Frame[] = [];
  let top: Frame | undefined;
  let overflow = 0;
  let nodes = 0;
  let line = 1;
  let i = t.charCodeAt(0) === 0xfeff ? 1 : 0;

  const newFrame = (object: boolean): Frame | undefined => {
    const parent = top;
    let start = line;
    let key = '';
    let path = '';
    if (parent?.object) {
      key = parent.pendingKey ?? '';
      start = parent.pendingLine || line;
      parent.pendingKey = undefined;
      path = joinPath(parent.path, key);
    } else if (parent) {
      key = `[${parent.index}]`;
      path = `${parent.path}${key}`;
      parent.index++;
    }
    const manifest = !!parent?.top && !!manifestMaps?.has(key) && object;
    return { object, parent, top: !parent, start, path, key, index: 0, children: [], expectKey: object, pendingKey: undefined, pendingLine: 0, label: undefined, labelRank: 99, manifest };
  };

  const closeFrame = (endLine: number): void => {
    const frame = stack.pop()!;
    top = stack[stack.length - 1];
    if (frame.top) {
      for (const child of frame.children) roots.push(child);
      return;
    }
    const parent = frame.parent!;
    const item = !parent.object;
    let name = frame.path;
    let scopeName = frame.key;
    const grand = parent.parent;
    if (frame.object && HTTP_METHODS.has(frame.key) && parent.key.startsWith('/') && grand?.key === 'paths' && grand.parent?.top) {
      name = `${frame.key.toUpperCase()} ${parent.key}${frame.label ? ` ${frame.label}` : ''}`;
    } else if (!item && frame.key.startsWith('/') && parent.key === 'paths' && parent.parent?.top && frame.children.length === 1 && /^[A-Z]+ /.test(frame.children[0].name)) {
      // A path item with a single operation is named after that operation.
      name = frame.children[0].name;
    } else if (item && frame.label) {
      name = `${frame.path} ${frame.label}`;
      scopeName = frame.label;
    }
    parent.children.push({ start: frame.start, end: endLine, name, kind: item ? 'json_item' : 'json_key', scopeName, children: frame.children });
    nodes++;
  };

  const leaf = (frame: Frame, key: string, start: number, end: number, label: string | undefined): void => {
    const rank = LABEL_KEYS.indexOf(key);
    if (rank >= 0 && label !== undefined && rank < frame.labelRank) {
      frame.label = tidy(label, 60);
      frame.labelRank = rank;
    }
    if (nodes >= MAX_NODES) return;
    nodes++;
    const node: TreeNode = { start, end, name: joinPath(frame.path, key), kind: 'json_key', scopeName: key, refs: frame.manifest ? [key] : undefined };
    if (frame.manifest) node.force = true;
    frame.children.push(node);
  };

  /** A finished scalar (string, number, literal) that is a value, not a key. */
  const scalarValue = (startLine: number, endLine: number, text: string): void => {
    const frame = top;
    if (!frame) return;
    if (frame.object) {
      const key = frame.pendingKey ?? '';
      leaf(frame, key, frame.pendingLine || startLine, endLine, text);
      frame.pendingKey = undefined;
    } else {
      frame.index++;
    }
  };

  const keyToken = (key: string, atLine: number): void => {
    const frame = top!;
    frame.pendingKey = key;
    frame.pendingLine = atLine;
    frame.expectKey = false;
  };

  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 10) {
      line++;
      i++;
    } else if (c === 32 || c === 9 || c === 13 || c === 0xfeff) {
      i++;
    } else if (c === 34 || c === 39) {
      const startLine = line;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = t.charCodeAt(j);
        if (d === c) {
          closed = true;
          break;
        }
        if (d === 92) {
          if (t.charCodeAt(j + 1) === 10) line++;
          j += 2;
          continue;
        }
        if (d === 10) break;
        j++;
      }
      const end = Math.min(j, n);
      if (top) {
        const raw = t.slice(i + 1, Math.min(end, i + 1 + MAX_TOKEN));
        if (top.object && top.expectKey) keyToken(unquote(raw), startLine);
        else scalarValue(startLine, line, unquote(raw));
      }
      i = closed ? end + 1 : end;
    } else if (c === 123 || c === 91) {
      if (stack.length > MAX_DEPTH) {
        overflow++;
      } else {
        const frame = newFrame(c === 123)!;
        stack.push(frame);
        top = frame;
      }
      i++;
    } else if (c === 125 || c === 93) {
      if (overflow > 0) overflow--;
      else if (stack.length) closeFrame(line);
      i++;
    } else if (c === 44) {
      if (top?.object) top.expectKey = true;
      i++;
    } else if (c === 58) {
      i++;
    } else if (c === 47 && t.charCodeAt(i + 1) === 47) {
      const e = t.indexOf('\n', i + 2);
      i = e < 0 ? n : e;
    } else if (c === 47 && t.charCodeAt(i + 1) === 42) {
      const e = t.indexOf('*/', i + 2);
      const stop = e < 0 ? n : e + 2;
      for (let k = t.indexOf('\n', i); k >= 0 && k < stop; k = t.indexOf('\n', k + 1)) line++;
      i = stop;
    } else {
      // Bare token: number, true/false/null, or a JSON5 unquoted key.
      let j = i + 1;
      while (j < n) {
        const d = t.charCodeAt(j);
        if (d === 32 || d === 9 || d === 10 || d === 13 || d === 44 || d === 125 || d === 93 || d === 58 || d === 34 || d === 39 || d === 123 || d === 91) break;
        if (d === 47) {
          const e = t.charCodeAt(j + 1);
          if (e === 47 || e === 42) break;
        }
        j++;
      }
      if (top) {
        const word = t.slice(i, Math.min(j, i + MAX_TOKEN));
        if (top.object && top.expectKey) keyToken(word, line);
        else scalarValue(line, line, word);
      }
      i = j;
    }
  }
  while (stack.length) closeFrame(src.count);
  if (!roots.length) return { roots };

  const lines = src.lines;
  return {
    roots,
    plan: {
      maxLines: 60,
      maxChars: 4000,
      refs: (start, end, covered) => jsonRefs(lines, start, end, covered),
    },
  };
}

const STRING_LITERAL = /"((?:[^"\\\n]|\\.){3,120})"/g;

function jsonRefs(lines: readonly string[], start: number, end: number, covered: readonly TreeNode[]): string[] {
  const refs = new RefSet();
  walk(covered, node => {
    if (node.refs) for (const ref of node.refs) refs.add(ref);
  });
  for (let n = start; n <= end && !refs.full; n++) {
    const line = lines[n - 1];
    if (line.length > 2000 || line.indexOf('"') < 0) continue;
    for (const m of line.matchAll(STRING_LITERAL)) {
      const value = m[1];
      if (value.startsWith('#/')) refs.add(value.slice(value.lastIndexOf('/') + 1));
      else if (looksLikeRef(value)) refs.add(value);
    }
  }
  return refs.list;
}
