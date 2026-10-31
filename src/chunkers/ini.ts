/** TOML tables, INI sections and Java-style .properties: flat, header- or prefix-delimited configuration. */
import { type Scan, type TreeNode, RefSet, Source, looksLikeRef, tidy, walk } from './common.js';

const isSpace = (c: number): boolean => c === 32 || c === 9;
const MAX_MULTILINE = 5000;
const DEPENDENCY_TABLE = /(?:^|\.)(?:dev-|build-)?dependencies$/;

/** Net open brackets ([ and {) in a TOML value fragment, ignoring strings and comments. */
function bracketBalance(s: string): number {
  const len = Math.min(s.length, 2000);
  let balance = 0;
  for (let j = 0; j < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 34 || c === 39) {
      j++;
      while (j < len && s.charCodeAt(j) !== c) j += c === 34 && s.charCodeAt(j) === 92 ? 2 : 1;
    } else if (c === 91 || c === 123) balance++;
    else if (c === 93 || c === 125) balance--;
    else if (c === 35) break;
  }
  return balance;
}

function tomlKey(raw: string): { key: string; value: string } | undefined {
  const len = Math.min(raw.length, 400);
  let i = 0;
  while (i < len && isSpace(raw.charCodeAt(i))) i++;
  const start = i;
  while (i < len) {
    const c = raw.charCodeAt(i);
    if (c === 34 || c === 39) {
      const q = raw.indexOf(raw[i], i + 1);
      if (q < 0 || q >= len) return undefined;
      i = q + 1;
    } else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c === 46 || isSpace(c)) {
      i++;
    } else break;
  }
  if (raw.charCodeAt(i) !== 61 || i === start) return undefined;
  return { key: raw.slice(start, i).trim().replace(/\s*\.\s*/g, '.'), value: raw.slice(i + 1).trim() };
}

interface Table extends TreeNode {
  path: string;
  index: number;
  label: string | undefined;
  children: TreeNode[];
}

export function scanToml(src: Source): Scan {
  const roots: TreeNode[] = [];
  const counts = new Map<string, number>();
  let table: Table | undefined;
  let last = 0;
  let open: TreeNode | undefined;
  let multi: string | undefined;
  let depth = 0;
  let openLines = 0;

  const closeTable = (): void => {
    if (!table) return;
    table.end = Math.max(table.start, last);
    if (table.label) table.name = `${table.path}${table.index >= 0 ? `[${table.index}]` : ''} ${tidy(table.label, 60)}`;
  };

  for (let n = 1; n <= src.count; n++) {
    const raw = src.lines[n - 1];
    if (multi) {
      if (raw.indexOf(multi) >= 0 || ++openLines > MAX_MULTILINE) multi = undefined;
      last = n;
      if (open) open.end = n;
      continue;
    }
    if (depth > 0) {
      depth += bracketBalance(raw);
      if (depth < 0 || ++openLines > MAX_MULTILINE) depth = 0;
      last = n;
      if (open) open.end = n;
      continue;
    }
    let p = 0;
    while (p < raw.length && isSpace(raw.charCodeAt(p))) p++;
    if (p >= raw.length || raw.charCodeAt(p) === 35) continue;

    if (raw.charCodeAt(p) === 91) {
      const arrayTable = raw.charCodeAt(p + 1) === 91;
      const close = raw.indexOf(']', p + 1);
      if (close < 0) {
        last = n;
        continue;
      }
      closeTable();
      const path = raw.slice(p + (arrayTable ? 2 : 1), close).trim().replace(/\s*\.\s*/g, '.');
      const index = arrayTable ? (counts.get(path) ?? 0) : -1;
      if (arrayTable) counts.set(path, index + 1);
      table = {
        start: n, end: n, name: arrayTable ? `${path}[${index}]` : path, kind: 'toml_table',
        scopeName: path.replace(/"([^"]*)"|'([^']*)'/g, '$1$2').split('.').join(' > '), path, index, label: undefined, children: [],
      };
      roots.push(table);
      last = n;
      continue;
    }

    const kv = tomlKey(raw);
    last = n;
    if (!kv) continue;
    const bare = kv.key.replace(/["']/g, '');
    const dependency = !!table && DEPENDENCY_TABLE.test(table.path);
    const leaf: TreeNode = {
      start: n, end: n, name: dependency ? `${table!.path}.${bare}` : bare, kind: 'toml_key', scopeName: bare,
      refs: dependency ? [bare] : undefined, force: dependency || undefined,
    };
    (table ? table.children : roots).push(leaf);
    const value = kv.value;
    if (table && (bare === 'name' || bare === 'id') && !table.label && /^["']/.test(value)) table.label = value.replace(/^["']|["'].*$/g, '');
    openLines = 0;
    if (value.startsWith('"""') || value.startsWith("'''")) {
      if (value.indexOf(value.slice(0, 3), 3) < 0) {
        multi = value.slice(0, 3);
        open = leaf;
      }
    } else if (value.startsWith('[') || value.startsWith('{')) {
      depth = Math.max(0, bracketBalance(value));
      if (depth > 0) open = leaf;
    }
  }
  closeTable();
  return { roots, plan: { minLines: 2, comment: n => src.line(n).trimStart().startsWith('#'), refs: (s, e, covered) => configRefs(src.lines, s, e, covered) } };
}

export function scanIni(src: Source): Scan {
  const roots: TreeNode[] = [];
  let section: (TreeNode & { children: TreeNode[] }) | undefined;
  let leaf: TreeNode | undefined;
  let last = 0;

  for (let n = 1; n <= src.count; n++) {
    const raw = src.lines[n - 1];
    let p = 0;
    while (p < raw.length && isSpace(raw.charCodeAt(p))) p++;
    if (p >= raw.length) continue;
    const c = raw.charCodeAt(p);
    if (c === 35 || c === 59) continue;
    if (c === 91 && p === 0) {
      const close = raw.lastIndexOf(']');
      if (section) section.end = Math.max(section.start, last);
      const name = tidy(raw.slice(1, close > 0 ? close : raw.length), 120) || 'section';
      section = { start: n, end: n, name, kind: 'ini_section', children: [] };
      roots.push(section);
      leaf = undefined;
      last = n;
      continue;
    }
    last = n;
    if (p > 0 && leaf) {
      leaf.end = n;
      continue;
    }
    const m = /^([^=:\s][^=:]{0,200}?)\s*(?:[=:]|\s|$)/.exec(raw.length > 600 ? raw.slice(0, 600) : raw);
    if (!m) continue;
    leaf = { start: n, end: n, name: m[1].trim(), kind: 'ini_key', scopeName: m[1].trim() };
    (section ? section.children : roots).push(leaf);
  }
  if (section) section.end = Math.max(section.start, last);
  return { roots, plan: { minLines: 2, comment: n => /^\s*[#;]/.test(src.line(n)), refs: (s, e, covered) => configRefs(src.lines, s, e, covered) } };
}

/** Leading dotted segments of a property key: `spring.datasource.url` -> `spring.datasource`. */
function propertyPrefix(name: string): string {
  const parts = name.split('.');
  return parts.length > 2 ? `${parts[0]}.${parts[1]}` : parts[0];
}

export function scanProperties(src: Source): Scan {
  const roots: TreeNode[] = [];
  let continued = false;
  let leaf: TreeNode | undefined;
  for (let n = 1; n <= src.count; n++) {
    const raw = src.lines[n - 1];
    if (continued && leaf) {
      leaf.end = n;
      continued = endsWithOddBackslashes(raw);
      continue;
    }
    let p = 0;
    while (p < raw.length && isSpace(raw.charCodeAt(p))) p++;
    if (p >= raw.length) continue;
    const c = raw.charCodeAt(p);
    if (c === 35 || c === 33) continue;
    let q = p;
    const limit = Math.min(raw.length, p + 300);
    while (q < limit) {
      const d = raw.charCodeAt(q);
      if (d === 92) q++;
      else if (d === 61 || d === 58 || isSpace(d)) break;
      q++;
    }
    const key = raw.slice(p, Math.min(q, limit));
    if (!key) continue;
    leaf = { start: n, end: n, name: key, kind: 'properties_key', scopeName: key };
    roots.push(leaf);
    continued = endsWithOddBackslashes(raw);
  }
  return {
    roots,
    plan: {
      minLines: 3,
      comment: n => /^\s*[#!]/.test(src.line(n)),
      breakRun: (previous, next, lines) => lines >= 4 && propertyPrefix(previous.name) !== propertyPrefix(next.name),
      refs: (s, e, covered) => configRefs(src.lines, s, e, covered),
    },
  };
}

function endsWithOddBackslashes(line: string): boolean {
  let count = 0;
  for (let i = line.length - 1; i >= 0 && line.charCodeAt(i) === 92; i--) count++;
  return count % 2 === 1;
}

const PLACEHOLDER = /\$\{([\w.:-]{2,60})/g;

/** Reference-like values (paths, class names, URLs excluded) and `${placeholders}` in key/value lines. */
function configRefs(lines: readonly string[], start: number, end: number, covered: readonly TreeNode[]): string[] {
  const refs = new RefSet();
  walk(covered, node => {
    if (node.refs) for (const ref of node.refs) refs.add(ref);
  });
  for (let n = start; n <= end && !refs.full; n++) {
    const line = lines[n - 1];
    if (line.length > 1000) continue;
    const t = line.trimStart();
    if (!t || t[0] === '#' || t[0] === ';' || t[0] === '!') continue;
    const eq = t.search(/[=:]/);
    if (eq < 0) continue;
    const value = t.slice(eq + 1).trim().replace(/\s+[#;].*$/, '').replace(/^["']|["']$/g, '');
    if (looksLikeRef(value)) refs.add(value);
    for (const m of value.matchAll(PLACEHOLDER)) refs.add(m[1]);
  }
  return refs.list;
}
