import Parser from 'web-tree-sitter';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Chunk } from './types.js';
import { chunkStructured } from './chunkers.js';

const assetDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const languages: Record<string, string> = { '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'tsx', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'c_sharp', '.rb': 'ruby' };
const definitions = new Set(['function_declaration', 'function_definition', 'method_definition', 'method_declaration', 'function_item', 'class_declaration', 'class_definition', 'struct_item', 'interface_declaration', 'type_alias_declaration', 'type_declaration', 'enum_item', 'impl_item', 'lexical_declaration', 'variable_declaration', 'assignment', 'const_item', 'method', 'singleton_method', 'class', 'module']);
const stop = new Set('the a an is are of to for from in on at and or how what where when why does do can with this that it by be as return const let var def function class public private import export true false null none use implementation code'.split(' '));
export function terms(text: string): string[] {
  const split = text.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase();
  return (split.match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length > 1 && !stop.has(t));
}
export function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function languageFor(path: string): string { return languages[extname(path).toLowerCase()] ?? 'text'; }
let init: Promise<void> | undefined;
const parsers = new Map<string, Promise<Parser>>();
async function getParser(lang: string): Promise<Parser> {
  init ??= Parser.init({ locateFile: () => join(assetDir, 'tree-sitter.wasm') });
  await init;
  if (!parsers.has(lang)) parsers.set(lang, (async () => {
    const p = new Parser(); p.setLanguage(await Parser.Language.load(join(assetDir, `tree-sitter-${lang}.wasm`))); return p;
  })());
  return parsers.get(lang)!;
}

export async function parseSource(path: string, text: string): Promise<{chunks: Chunk[]; parsed: boolean}> {
  const lines = text.split('\n');
  const spans: {start: number; end: number; name: string; kind: string; refs: string[]}[] = [];
  let parsed = false;
  const lang = languageFor(path);
  if (lang !== 'text') {
    try {
      const parser = await getParser(lang);
      const tree = parser.parse(text);
      parsed = !tree.rootNode.hasError;
      const visit = (node: Parser.SyntaxNode, depth: number) => {
        if (depth > 100) return;
        if (definitions.has(node.type) && node.endPosition.row > node.startPosition.row) {
          const named = node.childForFieldName('name') ?? node.childForFieldName('left');
          const name = named?.text.slice(0, 120) ?? node.firstNamedChild?.text.split(/[\n=({]/)[0].trim().slice(0, 80) ?? node.type;
          const refs = node.descendantsOfType(['identifier', 'property_identifier', 'type_identifier']).slice(0, 2000).map(n => n.text);
          spans.push({start: node.startPosition.row + 1, end: node.endPosition.row + 1, name, kind: node.type, refs: [...new Set(refs)]});
        }
        for (const child of node.namedChildren) visit(child, depth + 1);
      };
      visit(tree.rootNode, 0);
      tree.delete();
    } catch { parsed = false; }
  } else {
    // Documentation, configuration, markup, SQL and build files: structure-aware spans instead of windows only.
    for (const s of chunkStructured(path, text) ?? []) spans.push({start: s.start, end: s.end, name: s.name, kind: s.kind, refs: s.refs ?? []});
  }
  // Every line remains searchable, including imports, comments and unsupported languages.
  for (let start = 1; start <= lines.length; start += 48) {
    spans.push({start, end: Math.min(lines.length, start + 63), name: '', kind: 'window', refs: []});
  }
  const chunks: Chunk[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    // Bound huge classes/functions without dropping their internal definitions.
    for (let start = span.start; start <= span.end; start += 80) {
      const end = Math.min(span.end, start + 95);
      const key = `${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const body = lines.slice(start - 1, end).join('\n');
      if (!body.trim()) continue;
      chunks.push({id: hash(`${path}:${start}:${end}:${body}`).slice(0, 16), path, start, end, name: span.name, kind: span.kind, text: body, terms: terms(`${path} ${span.name} ${body}`), refs: span.refs});
      if (end === span.end) break;
    }
  }
  return { chunks, parsed };
}
