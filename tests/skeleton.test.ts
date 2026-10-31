import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, languageFor } from '../src/parser.js';
import { tokens } from '../src/tokens.js';
import { extractSignature, listDefinitions, renderSkeleton, type SkeletonResult } from '../src/skeleton.js';
import type { SourceFile } from '../src/types.js';

async function sourceFile(path: string, text: string): Promise<SourceFile> {
  const { chunks, parsed } = await parseSource(path, text);
  return { path, text, hash: path, language: languageFor(path), chunks, parsed };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PYTHON = `"""Module docstring."""
import os

CONFIG = {
    'a': 1,
    'b': 2,
}


class Foo(Base):
    """Foo does things.

    More text, line one.
    More text, line two.
    More text, line three.
    More text, line four.
    """

    def __init__(self, a, b=None):
        """Initialise."""
        self.a = a
        self.b = b

    @property
    def value(self):
        # compute the total
        total = 0
        for item in self.items:
            total += item
        return total

    def long_signature(
        self,
        alpha: int,
        beta: str = "x",
    ) -> Dict[str, int]:
        """Return stuff."""
        result = {
            'k': alpha,
        }
        return result


def helper(x):
    first = prepare(x)
    second = prepare(first)
    third = prepare(second)
    frobnicate(third)
    fourth = prepare(third)
    return fourth
`;

const TYPESCRIPT = `import { x } from './x';
/** A set of options. */
export interface Opts {
  a: number;
  b?: string;
}
export class Server<T extends { id: string }> extends Base implements Thing {
  private n = 0;
  /** Starts the server. */
  async start(port: number): Promise<Map<string, { a: number }>> {
    this.n++;
    return new Map();
  }
  stop(): void {
    this.n--;
    cleanup();
  }
}
export const handler = async (req: Request): Promise<Response> => {
  const { a, b } = req;
  return new Response(String(a + b));
};
function plain(a, b) {
  return a + b;
}
`;

const GO = `package main

import "fmt"

// Server handles requests.
type Server struct {
	addr string
	port int
}

type Handler interface {
	Serve(w int) error
}

// Start boots the server.
func (s *Server) Start(
	port int,
) error {
	fmt.Println("x")
	return nil
}

func main() {
	fmt.Println("x")
}
`;

const RUST = `use std::io;

/// Configuration of the thing.
pub struct Config {
    pub a: u32,
}

impl Config {
    /// Creates a config.
    pub fn new(a: u32) -> Self {
        Config { a }
    }
}

impl<T> Foo<T> for Bar<T> where T: Clone {
    fn foo(&self) -> T {
        todo!()
    }
}

pub fn run<'a, T: Clone>(
    x: &'a T,
) -> Result<&'a T, Error> {
    Ok(x)
}
`;

const JAVA = `package a;

import java.util.List;

/** The A class. */
public class A extends B {
    @Override
    public String name(
        String x) throws Exception {
        return x;
    }

    public static void main(String[] args) {
        System.out.println("x");
    }
}
`;

const C_SOURCE = `#include <stdio.h>

static int helper(int a,
                  int b)
{
    return a + b;
}

int main(int argc, char **argv) {
    printf("x");
    return 0;
}
`;

const RUBY = `module Foo
  # A bar.
  class Bar < Baz
    def initialize(a, b)
      @a = a
    end

    def self.create(x)
      new(x)
    end
  end
end
`;

const SAMPLES: [string, string][] = [
  ['a.py', PYTHON], ['a.ts', TYPESCRIPT], ['a.go', GO], ['a.rs', RUST], ['A.java', JAVA], ['a.c', C_SOURCE], ['a.rb', RUBY]
];

const MARKER = /^… \((\d+) lines elided, L(\d+)-L(\d+)\)$/;

function sourceLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => line.replace(/\r$/, ''));
}

/** Checks every invariant of a skeleton against the source: exact lines, marker arithmetic, counts and the token cap. */
function verify(result: SkeletonResult, source: string[], range: { start: number; end: number }, options: { numbered?: boolean; maxTokens: number }): number[] {
  const end = Math.min(range.end, source.length);
  const span = end - range.start + 1;
  const kept: number[] = [];
  const elided: [number, number][] = [];
  if (result.text === '' && result.keptLines === 0) {
    assert.equal(result.elidedLines, span);
    assert.equal(result.tokens, 0);
    return kept;
  }
  let next = range.start;
  for (const row of result.text.split('\n')) {
    const marker = MARKER.exec(row);
    if (marker) {
      const [count, a, b] = [Number(marker[1]), Number(marker[2]), Number(marker[3])];
      assert.equal(a, next, `marker starts at ${a}, expected ${next}`);
      assert.equal(b - a + 1, count, 'marker count matches its range');
      elided.push([a, b]);
      next = b + 1;
      continue;
    }
    let line = row;
    if (options.numbered) {
      const prefix = /^ {2} *(\d+)│ /.exec(row);
      assert(prefix, `numbered prefix in ${JSON.stringify(row)}`);
      assert.equal(Number(prefix[1]), next);
      line = row.slice(prefix[0].length);
    }
    assert.equal(line, source[next - 1], `kept line ${next} is the exact source line`);
    kept.push(next++);
  }
  assert.equal(next, end + 1, 'output covers the whole range');
  assert.equal(result.keptLines, kept.length);
  assert.equal(result.keptLines + result.elidedLines, span);
  assert.deepEqual(result.elidedRanges, elided);
  assert.equal(result.tokens, tokens(result.text));
  assert(result.tokens <= options.maxTokens, `${result.tokens} tokens exceed the cap of ${options.maxTokens}`);
  assert(!result.text.includes('\r'));
  const fromRanges = result.keptRanges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
  assert.deepEqual(fromRanges, kept);
  return kept;
}

test('extractSignature keeps the header up to the body opener', () => {
  const cases: [string, string, string, string?][] = [
    ['python', 'def create_app(\n    test_config=None,\n    instance_path=None,\n) -> Flask:\n    """Create."""\n    return 1\n', 'def create_app(test_config=None, instance_path=None) -> Flask:'],
    ['python', 'class Foo(Base, metaclass=Meta):  # comment\n    pass\n', 'class Foo(Base, metaclass=Meta):'],
    ['python', 'def f(a: Dict[str, "x{y}"] = {1: 2}, *args, **kw):\n    pass\n', 'def f(a: Dict[str, "x{y}"] = {1: 2}, *args, **kw):'],
    ['python', 'CONFIG = {\n    "a": 1,\n}\n', 'CONFIG = {…}', 'variable'],
    ['typescript', 'export class Server<T extends { id: string }> extends Base implements Thing {\n  x = 1;\n}\n', 'export class Server<T extends { id: string }> extends Base implements Thing'],
    ['typescript', 'export const handler = async (req: Request): Promise<Response> => {\n  return 1;\n};\n', 'export const handler = async (req: Request): Promise<Response> =>', 'variable'],
    ['typescript', 'async start(port: number): Promise<Map<string, { a: number }>> {\n}\n', 'async start(port: number): Promise<Map<string, { a: number }>>'],
    ['typescript', '@Component({\n  selector: "x",\n})\nexport class A {\n}\n', 'export class A'],
    ['rust', "pub fn run<'a, T: Clone>(x: &'a T, y: char) -> Result<&'a T, Error>\nwhere\n    T: Send,\n{\n    todo!()\n}\n", "pub fn run<'a, T: Clone>(x: &'a T, y: char) -> Result<&'a T, Error> where T: Send,"],
    ['rust', 'const LIMITS: [u32; 3] = [\n    1, 2, 3,\n];\n', 'const LIMITS: [u32; 3] = […]', 'variable'],
    ['go', 'func (s *Server) Start(\n\tport int,\n) error {\n\treturn nil\n}\n', 'func (s *Server) Start(port int) error'],
    ['go', 'type Server struct {\n\taddr string\n}\n', 'type Server struct', 'container'],
    ['java', '    @Override\n    @SuppressWarnings("unchecked")\n    public String name(\n        String x) throws Exception {\n        return x;\n    }\n', 'public String name(String x) throws Exception'],
    ['java', '@Override public void run() {\n}\n', 'public void run()'],
    ['c', 'static int helper(int a,\n                  int b)\n{\n    return a + b;\n}\n', 'static int helper(int a, int b)'],
    ['ruby', 'def initialize(a, b)\n  @a = a\nend\n', 'def initialize(a, b)'],
    ['javascript', 'function foo(a, /* inline { */ b) { return a; }\n', 'function foo(a, b)'],
    ['rust', "fn f() { let c = '{'; }\n", 'fn f()']
  ];
  for (const [language, source, expected, role] of cases) {
    assert.equal(extractSignature(source, { language, role: role as 'variable' | 'container' | undefined }).text, expected, source.slice(0, 40));
  }
  assert.equal(extractSignature('', { language: 'python' }).text, '');
});

test('extractSignature reports the physical lines of the header and skipped annotations', () => {
  const java = extractSignature('    @Override\n    @SuppressWarnings("unchecked")\n    public String name(\n        String x) throws Exception {\n        return x;\n    }\n', { language: 'java' });
  assert.deepEqual([java.lines, java.skipped], [4, 2]);
  const go = extractSignature('func (s *Server) Start(\n\tport int,\n) error {\n\treturn nil\n}\n', { language: 'go' });
  assert.deepEqual([go.lines, go.skipped], [3, 0]);
});

test('extractSignature truncates, strips invisible characters and survives pathological input', () => {
  const long = extractSignature(`def very_long_function_name_${'x'.repeat(300)}(a, b):\n    pass\n`, { language: 'python', maxChars: 110 });
  assert(long.text.length <= 110 && long.text.endsWith('…'));
  assert.equal(extractSignature('def bidi(\u202e evil, \u200b zero):\n    pass\n', { language: 'python' }).text, 'def bidi(evil, zero):');
  for (const source of ['('.repeat(50000), `def f(${'a,'.repeat(20000)}):\n`, '"'.repeat(30000), `${'a'.repeat(200000)}!`, '/*'.repeat(10000), '\u0000\u0001\u0002'.repeat(1000)]) {
    const started = performance.now();
    const signature = extractSignature(source, { language: 'typescript', maxChars: 160 });
    assert(signature.text.length <= 160);
    assert(performance.now() - started < 500, 'bounded work');
    assert(!/[\n\r\u0000-\u001f]/.test(signature.text));
  }
});

test('listDefinitions resolves names, nesting and locality across languages', async () => {
  const python = listDefinitions(await sourceFile('a.py', PYTHON));
  assert.deepEqual(python.map(def => [def.name, def.depth, def.local]), [
    ['CONFIG', 0, false], ['Foo', 0, false], ['__init__', 1, false], ['value', 1, false], ['long_signature', 1, false], ['result', 2, true], ['helper', 0, false]
  ], 'the Python module node is not a definition and a variable in a method is local');
  const foo = python.find(def => def.name === 'Foo')!;
  assert.equal(python.find(def => def.name === 'value')!.parent, python.indexOf(foo));

  const go = listDefinitions(await sourceFile('a.go', GO));
  assert.deepEqual(go.filter(def => def.role === 'container').map(def => def.name), ['Server', 'Handler'], 'Go type names are reduced to the identifier');

  const c = listDefinitions(await sourceFile('a.c', C_SOURCE));
  assert.deepEqual(c.map(def => def.name), ['helper', 'main'], 'C function names come from the declarator, not the return type');

  const rust = listDefinitions(await sourceFile('a.rs', RUST));
  assert.deepEqual(rust.filter(def => def.kind === 'impl_item').map(def => def.name), ['', ''], 'impl blocks are containers, not names');
  assert.equal(rust.find(def => def.name === 'new')!.depth, 1);
});

test('listDefinitions merges the pieces the chunker cuts long definitions into', async () => {
  const body = Array.from({ length: 300 }, (_, i) => `    value_${i} = ${i}`).join('\n');
  const file = await sourceFile('long.py', `import os\n\n\ndef giant(x):\n${body}\n    return x\n\n\ndef after(y):\n    return y\n`);
  assert(file.chunks.filter(chunk => chunk.name === 'giant').length > 2, 'the chunker splits the definition');
  const defs = listDefinitions(file);
  assert.deepEqual(defs.map(def => def.name), ['giant', 'after']);
  assert.equal(defs[0].start, 4);
  assert.equal(defs[0].end, 305);
  assert.equal(defs[1].depth, 0);
});

test('a skeleton keeps every definition header and elides bodies with exact markers', async () => {
  for (const [path, text] of SAMPLES) {
    const file = await sourceFile(path, text);
    const lines = sourceLines(text);
    const result = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens: 4000 });
    const kept = new Set(verify(result, lines, { start: 1, end: lines.length }, { maxTokens: 4000 }));
    for (const def of listDefinitions(file)) {
      if (def.local) continue;
      const header = extractSignature(lines.slice(def.start - 1, def.start + 11).join('\n'), { language: file.language, role: def.role, maxChars: 400 });
      for (let n = def.start; n < def.start + header.lines; n++) assert(kept.has(n), `${path}: header line ${n} of ${def.name} kept`);
    }
    assert(result.tokens <= tokens(text), `${path}: the skeleton is never larger than the source`);
  }
});

test('Python skeleton shows signatures and the first docstring line only', async () => {
  const file = await sourceFile('a.py', PYTHON);
  const lines = sourceLines(PYTHON);
  const result = renderSkeleton(file, { start: 10, end: 48 }, { maxTokens: 2000 });
  verify(result, lines, { start: 10, end: 48 }, { maxTokens: 2000 });
  assert(result.tokens < tokens(lines.slice(9, 48).join('\n')) * 0.8, 'clearly smaller than the source range');
  assert(result.text.includes('class Foo(Base):'));
  assert(result.text.includes('    """Foo does things.'));
  assert(!result.text.includes('line three'));
  assert(result.text.includes('        beta: str = "x",'), 'multi-line signatures stay whole');
  assert(result.text.includes('    def __init__(self, a, b=None):'));
  assert(result.text.includes('        """Initialise."""'));
  assert(!result.text.includes('total += item'));
  assert(/… \(\d+ lines elided, L\d+-L\d+\)/.test(result.text));
});

test('numbered output prefixes the original line numbers', async () => {
  const file = await sourceFile('a.py', PYTHON);
  const lines = sourceLines(PYTHON);
  const result = renderSkeleton(file, { start: 10, end: 48 }, { maxTokens: 2000, numbered: true });
  verify(result, lines, { start: 10, end: 48 }, { numbered: true, maxTokens: 2000 });
  assert(result.text.startsWith('  10│ class Foo(Base):'));
});

test('focus terms keep their lines with the requested context', async () => {
  const file = await sourceFile('a.py', PYTHON);
  const lines = sourceLines(PYTHON);
  const at = lines.findIndex(line => line.includes('frobnicate')) + 1;
  const plain = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens: 4000 });
  assert(!plain.text.includes('frobnicate'));
  const focused = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens: 4000, focusTerms: ['FROBNICATE'], contextLines: 0 });
  const kept = new Set(verify(focused, lines, { start: 1, end: lines.length }, { maxTokens: 4000 }));
  assert(kept.has(at));
  const wide = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens: 4000, focusTerms: ['frobnicate'], contextLines: 1 });
  const wideKept = new Set(verify(wide, lines, { start: 1, end: lines.length }, { maxTokens: 4000 }));
  assert(wideKept.has(at) && wideKept.has(at + 1));
  for (const term of ['a.b(', '[', '\\', '*', '', ' ', '(((', 'é'.repeat(200)]) {
    const odd = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens: 4000, focusTerms: [term] });
    verify(odd, lines, { start: 1, end: lines.length }, { maxTokens: 4000 });
  }
});

test('a tight budget never exceeds the cap and drops the least important lines first', async () => {
  const file = await sourceFile('a.py', PYTHON);
  const lines = sourceLines(PYTHON);
  const kinds = new Map<number, number>();
  for (const maxTokens of [0, 1, 5, 10, 13, 14, 15, 16, 20, 30, 45, 60, 90, 130, 200, 400]) {
    const result = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens });
    verify(result, lines, { start: 1, end: lines.length }, { maxTokens });
    kinds.set(maxTokens, result.keptLines);
  }
  assert.equal(kinds.get(0), 0);
  assert(kinds.get(400)! > kinds.get(60)!, 'a larger budget keeps more');
  const single = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens: 16 });
  assert(single.text === '' || MARKER.test(single.text) || single.keptLines > 0);
  const shallow = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens: 70 });
  assert(shallow.text.includes('class Foo(Base):') && shallow.text.includes('def helper(x):'), 'top-level headers survive first');
});

test('property: random ranges, budgets, terms and numbering keep every invariant', async () => {
  const random = mulberry32(20260601);
  for (const [path, text] of SAMPLES) {
    for (const eol of ['\n', '\r\n']) {
      const crlf = text.replace(/\n/g, eol);
      const file = await sourceFile(path, crlf);
      const lines = sourceLines(crlf);
      const words = [...new Set(text.match(/[A-Za-z_]{4,}/g) ?? [])];
      for (let i = 0; i < 40; i++) {
        const start = 1 + Math.floor(random() * lines.length);
        const end = start + Math.floor(random() * (lines.length + 3 - start));
        const maxTokens = [0, 12, 20, 40, 80, 160, 400, 4000][Math.floor(random() * 8)];
        const numbered = random() < 0.5;
        const focusTerms = Array.from({ length: Math.floor(random() * 4) }, () => words[Math.floor(random() * words.length)]);
        const options = { maxTokens, numbered, focusTerms, contextLines: Math.floor(random() * 4) };
        const first = renderSkeleton(file, { start, end }, options);
        verify(first, lines, { start, end }, { numbered, maxTokens });
        assert.deepEqual(renderSkeleton(file, { start, end }, options), first, 'deterministic');
      }
    }
  }
});

test('CRLF sources produce the same skeleton as LF sources without carriage returns', async () => {
  const lf = await sourceFile('a.py', PYTHON);
  const crlf = await sourceFile('a.py', PYTHON.replace(/\n/g, '\r\n'));
  const range = { start: 1, end: sourceLines(PYTHON).length };
  const a = renderSkeleton(lf, range, { maxTokens: 1500, focusTerms: ['total'] });
  const b = renderSkeleton(crlf, range, { maxTokens: 1500, focusTerms: ['total'] });
  assert.equal(b.text, a.text);
  assert(!b.text.includes('\r'));
});

test('lines too long to keep are elided, never truncated, and cost little time', async () => {
  const huge = `x = "${'a'.repeat(300_000)}"`;
  const text = PYTHON.replace('def helper(x):\n', `def helper(x):\n    ${huge}\n`);
  const file = await sourceFile('a.py', text);
  const lines = sourceLines(text);
  const started = performance.now();
  const result = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens: 800, focusTerms: ['aaaa'] });
  assert(performance.now() - started < 3000);
  verify(result, lines, { start: 1, end: lines.length }, { maxTokens: 800 });
  assert(!result.text.includes('aaaaaaaaaa'));
});

test('binary noise and pathological text do not break the invariants', async () => {
  const random = mulberry32(7);
  let noise = '';
  for (let i = 0; i < 20000; i++) noise += random() < 0.04 ? '\n' : String.fromCharCode(Math.floor(random() * 256));
  const file = await sourceFile('noise.txt', noise);
  const lines = sourceLines(noise);
  for (const maxTokens of [0, 20, 200, 3000]) {
    verify(renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens, focusTerms: ['a', 'zz', '\u0000'] }), lines, { start: 1, end: lines.length }, { maxTokens });
  }
  const redos = `${'a'.repeat(50_000)}!\n${'('.repeat(50_000)}\nfunction f() {}\n${'/*'.repeat(25_000)}\n`;
  const started = performance.now();
  const pathological = await sourceFile('p.js', redos);
  const plines = sourceLines(redos);
  verify(renderSkeleton(pathological, { start: 1, end: plines.length }, { maxTokens: 500 }), plines, { start: 1, end: plines.length }, { maxTokens: 500 });
  assert(performance.now() - started < 4000);
});

test('range validation and clamping', async () => {
  const file = await sourceFile('a.py', PYTHON);
  const n = sourceLines(PYTHON).length;
  for (const range of [{ start: 0, end: 5 }, { start: 5, end: 4 }, { start: 1.5, end: 3 }, { start: 1, end: NaN }, { start: n + 1, end: n + 5 }]) {
    assert.throws(() => renderSkeleton(file, range, { maxTokens: 100 }), RangeError, JSON.stringify(range));
  }
  assert.throws(() => renderSkeleton(file, { start: 1, end: 5 }, { maxTokens: -1 }), RangeError);
  assert.throws(() => renderSkeleton(file, { start: 1, end: 5 }, { maxTokens: 1.5 }), RangeError);
  const clamped = renderSkeleton(file, { start: n - 3, end: n + 100 }, { maxTokens: 1000 });
  verify(clamped, sourceLines(PYTHON), { start: n - 3, end: n + 100 }, { maxTokens: 1000 });
  const one = renderSkeleton(file, { start: 1, end: 1 }, { maxTokens: 100 });
  verify(one, sourceLines(PYTHON), { start: 1, end: 1 }, { maxTokens: 100 });
});

test('tiny gaps are kept instead of being replaced by a longer marker', async () => {
  const text = 'def a():\n    pass\n\ndef b():\n    pass\n';
  const file = await sourceFile('t.py', text);
  const lines = sourceLines(text);
  const result = renderSkeleton(file, { start: 1, end: lines.length }, { maxTokens: 400 });
  verify(result, lines, { start: 1, end: lines.length }, { maxTokens: 400 });
  assert(!/\(1 lines elided/.test(result.text), 'no marker for a single short line');
});

test('files without chunks fall back to textual headers', async () => {
  const paragraph = (word: string) => Array.from({ length: 6 }, (_, i) => `${word} sentence number ${i} with a few more words in it.`).join('\n');
  const markdown = `# Title\n\n${paragraph('First')}\n\n## Install\n\n${paragraph('Second')}\n\n### Details\n\n${paragraph('Third')}\n`;
  const md = await sourceFile('README.md', markdown);
  const mdLines = sourceLines(markdown);
  const mdResult = renderSkeleton(md, { start: 1, end: mdLines.length }, { maxTokens: 300 });
  verify(mdResult, mdLines, { start: 1, end: mdLines.length }, { maxTokens: 300 });
  assert(mdResult.text.includes('# Title') && mdResult.text.includes('## Install') && mdResult.text.includes('### Details') && !mdResult.text.includes('Second sentence number 3'));

  const kotlin = 'package a\n\nclass Box(val x: Int) {\n    fun open(): Int {\n        return x\n    }\n}\n\nfun top() {\n    println(1)\n}\n';
  const kt = await sourceFile('a.kt', kotlin);
  const ktLines = sourceLines(kotlin);
  const ktResult = renderSkeleton(kt, { start: 1, end: ktLines.length }, { maxTokens: 300 });
  verify(ktResult, ktLines, { start: 1, end: ktLines.length }, { maxTokens: 300 });
  assert(ktResult.text.includes('class Box(val x: Int) {') && ktResult.text.includes('fun open(): Int {') && ktResult.text.includes('fun top() {'));
});

test('skeletons of real chunks never contain text that is not in the source', async () => {
  const file = await sourceFile('a.ts', TYPESCRIPT);
  const lines = sourceLines(TYPESCRIPT);
  const sourceSet = new Set(lines);
  for (const chunk of file.chunks.filter(c => c.kind !== 'window')) {
    const result = renderSkeleton(file, { start: chunk.start, end: chunk.end }, { maxTokens: 300, focusTerms: ['port'] });
    for (const row of result.text.split('\n')) assert(MARKER.test(row) || sourceSet.has(row), `unexpected line ${JSON.stringify(row)}`);
  }
});
