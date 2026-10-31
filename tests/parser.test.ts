import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, languageFor, terms } from '../src/parser.js';
import { detectGenerated } from '../src/generated.js';
import type { Chunk } from '../src/types.js';

const definitions = (chunks: Chunk[]) => chunks.filter(chunk => chunk.kind !== 'window');
const named = (chunks: Chunk[], name: string) => definitions(chunks).find(chunk => chunk.name === name);

test('exposes the shared tokenizer and language labels', () => {
  assert.ok(terms('parseSource handles HTTPServer').includes('parsesource'));
  assert.equal(languageFor('a/b/Main.kt'), 'kotlin');
  assert.equal(languageFor('README.md'), 'text');
});

test('python: the module root is not a chunk, definitions carry signature, scope and docstring', async () => {
  const source = [
    '"""Module doc."""', 'import os', '', 'class Service:', '    """Stores things."""', '    def save(self, item):', '        # note', '        return item', '',
    '@cached', 'def helper():', '    return 1', '',
  ].join('\n');
  const { chunks, parsed } = await parseSource('svc.py', source);
  assert.ok(parsed);
  assert.equal(chunks.filter(chunk => chunk.kind === 'module').length, 0);
  assert.deepEqual(definitions(chunks).map(chunk => chunk.name), ['Service', 'save', 'helper']);
  const save = named(chunks, 'save')!;
  assert.equal(save.signature, 'def save(self, item):');
  assert.equal(save.scope, 'Service > save');
  assert.equal(named(chunks, 'Service')!.doc, 'Stores things.');
  assert.equal(named(chunks, 'helper')!.start, 10, 'the decorator line belongs to the chunk');
});

test('ruby: modules are definitions as long as they are not the file root', async () => {
  const { chunks } = await parseSource('m.rb', 'module Outer\n  class Inner\n    def run\n      1\n    end\n  end\nend\n');
  assert.deepEqual(definitions(chunks).map(chunk => [chunk.kind, chunk.name]), [['module', 'Outer'], ['class', 'Inner'], ['method', 'run']]);
  assert.equal(named(chunks, 'run')!.scope, 'Outer > Inner > run');
});

test('typescript: leading doc comments and decorators extend the chunk, only own-line and contiguous', async () => {
  const source = [
    'const before = 1;', '/** Documented class. */', '@Component()', 'export class Widget {', '  render(): void {', '    draw();', '  }', '}', '',
    '// detached by a blank line', '', 'function plain() {', '  return 2;', '}',
  ].join('\n');
  const { chunks } = await parseSource('w.ts', source);
  const widget = named(chunks, 'Widget')!;
  assert.equal(widget.start, 2);
  assert.equal(widget.doc, 'Documented class.');
  assert.equal(named(chunks, 'plain')!.start, 12);
  assert.equal(named(chunks, 'plain')!.doc, undefined);
});

test('go, rust, c, java and c# yield named definitions with scopes', async () => {
  const go = await parseSource('s.go', 'package p\n\n// Save persists the value.\nfunc (s *Store) Save(v int) error {\n\treturn nil\n}\n');
  assert.equal(named(go.chunks, 'Save')!.scope, 'Store > Save');
  assert.equal(named(go.chunks, 'Save')!.doc, 'Save persists the value.');
  const rust = await parseSource('s.rs', '/// A store.\nstruct Store {\n    a: i32,\n}\nimpl Store {\n    fn save(&self) {\n    }\n}\n');
  assert.equal(named(rust.chunks, 'save')!.scope, 'Store > save');
  const c = await parseSource('m.c', 'int main(void) {\n  return 0;\n}\n');
  assert.equal(named(c.chunks, 'main')!.signature, 'int main(void)');
  const java = await parseSource('A.java', 'class A {\n  void run() {\n    go();\n  }\n}\n');
  assert.equal(named(java.chunks, 'run')!.scope, 'A > run');
  const cs = await parseSource('A.cs', 'namespace N {\n  class C {\n    void M() {\n    }\n  }\n}\n');
  assert.equal(named(cs.chunks, 'M')!.scope, 'N > C > M');
});

test('additional grammars parse: php, kotlin, scala, bash, elixir, ocaml, objective-c, solidity, zig', async () => {
  const samples: [string, string, string][] = [
    ['a.php', '<?php\nclass Greeter {\n  public function hi() {\n    return 1;\n  }\n}\n', 'hi'],
    ['a.kt', 'class Greeter {\n  fun hi(): Int {\n    return 1\n  }\n}\n', 'hi'],
    ['a.scala', 'object Greeter {\n  def hi(): Int = {\n    1\n  }\n}\n', 'hi'],
    ['a.sh', 'hi() {\n  echo "${name#prefix}"\n}\n', 'hi'],
    ['a.ex', 'defmodule Greeter do\n  def hi(name) do\n    name\n  end\nend\n', 'hi'],
    ['a.ml', 'let hi x =\n  let y = x in\n  y + 1\n', 'hi'],
    ['a.m', '@interface Greeter : NSObject\n- (void)hi;\n@end\n@implementation Greeter\n- (void)hi {\n  NSLog(@"x");\n}\n@end\n', ''],
    ['a.sol', 'contract Greeter {\n  function hi() public {\n    x = 1;\n  }\n}\n', 'hi'],
    ['a.zig', 'pub fn hi() void {\n    run();\n}\n', 'hi'],
  ];
  for (const [path, source, name] of samples) {
    const { chunks, parsed } = await parseSource(path, source);
    assert.ok(parsed, `${path} parses without errors`);
    assert.ok(definitions(chunks).length > 0, `${path} has definition chunks`);
    if (name) assert.ok(named(chunks, name), `${path} defines ${name}`);
  }
});

test('every line stays covered by some chunk', async () => {
  const source = Array.from({ length: 300 }, (_, i) => i % 40 === 0 ? `def f${i}():\n    pass` : `# line ${i}`).join('\n');
  const { chunks } = await parseSource('cover.py', source);
  const covered = new Set<number>();
  for (const chunk of chunks) for (let line = chunk.start; line <= chunk.end; line++) covered.add(line);
  assert.equal(covered.size, source.split('\n').length);
});

test('oversized definitions are split into pieces that are flagged as continuations', async () => {
  const body = Array.from({ length: 400 }, (_, i) => `    x${i} = ${i}`).join('\n');
  const { chunks } = await parseSource('big.py', `def big():\n${body}\n`);
  const pieces = chunks.filter(chunk => chunk.name === 'big');
  assert.ok(pieces.length > 1);
  assert.equal(pieces[0].cont, undefined);
  assert.ok(pieces[0].signature);
  assert.ok(pieces.slice(1).every(piece => piece.cont === true && piece.signature === undefined));
  assert.ok(pieces.every(piece => piece.end - piece.start < 96));
});

test('generated and minified files get a bounded, AST-free chunking', async () => {
  const minified = await parseSource('app.min.js', 'var a=function(){return 1};'.repeat(5000));
  assert.equal(minified.generated, true);
  assert.equal(minified.generatedReason, 'path');
  assert.ok(minified.chunks.length <= 64);
  assert.ok(minified.chunks.every(chunk => chunk.generated === true));
  const marked = await parseSource('api.ts', '// Code generated by protoc. DO NOT EDIT.\nexport function a() {\n  return 1;\n}\n');
  assert.equal(marked.generatedReason, 'marker');
  assert.equal(detectGenerated('x.ts', 'export function a() {}\n// mentions auto-generated output in prose\n').generated, false);
  assert.equal(detectGenerated('x.js', `${'a'.repeat(3000)}\n`.repeat(3)).reason, 'long-lines');
  assert.equal(detectGenerated('src/a.ts', 'export const a = 1;\n').generated, false);
});

test('adversarial input never throws and stays deterministic', async () => {
  const inputs: [string, string][] = [
    ['huge.py', `x = "${'a'.repeat(600_000)}"\n`],
    ['nul.py', 'def f():\n\0\0    return 1\n'],
    ['crlf.py', 'def f():\r\n    return 1\r\n\r\nclass C:\r\n    def g(self):\r\n        pass\r\n'],
    ['bom.js', '\ufefffunction f() {\n  return 1;\n}\n'],
    ['unicode.go', 'package p\n\nfunc Größe() int {\n\treturn 1 // 日本語 🚀\n}\n'],
    ['deep.js', `${'['.repeat(5000)}${']'.repeat(5000)}\n`],
    ['redos.ts', `// ${'!'.repeat(50_000)}\nfunction f() {\n  return "${'a'.repeat(50_000)}b";\n}\n`],
    ['noise.rs', String.fromCharCode(...Array.from({ length: 4000 }, (_, i) => (i * 7919) % 256))],
    ['empty.c', ''],
    ['unterminated.java', 'class A {\n  void f() {\n    if (x) {\n'],
  ];
  for (const [path, source] of inputs) {
    const started = Date.now();
    const first = await parseSource(path, source);
    const second = await parseSource(path, source);
    assert.deepEqual(first, second, `${path} is deterministic`);
    assert.ok(Date.now() - started < 10_000, `${path} finishes quickly`);
    for (const chunk of first.chunks) assert.ok(chunk.start >= 1 && chunk.end >= chunk.start, `${path} has valid ranges`);
  }
  const crlf = await parseSource('crlf.py', inputs[2][1]);
  assert.ok(named(crlf.chunks, 'g'));
  const unicode = await parseSource('unicode.go', inputs[4][1]);
  assert.ok(named(unicode.chunks, 'Größe'));
  const bom = await parseSource('bom.js', inputs[3][1]);
  assert.ok(named(bom.chunks, 'f'));
});

test('a parse timeout falls back to line windows instead of hanging', async () => {
  const source = Array.from({ length: 20_000 }, (_, i) => `def f${i}(a, b):\n    return [a, b, {${i}: (a + b)}]`).join('\n');
  const { chunks } = await parseSource('slow.py', source, { timeoutMs: 1 });
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every(chunk => chunk.kind === 'window' || chunk.kind === 'function_definition'));
});

test('rich mode adds extra definition kinds without changing the default', async () => {
  const source = 'enum Color {\n  Red,\n  Green,\n}\n\nfunction f() {\n  return 1;\n}\n';
  const plain = await parseSource('e.ts', source);
  const rich = await parseSource('e.ts', source, { rich: true });
  assert.equal(named(plain.chunks, 'Color'), undefined);
  assert.ok(named(rich.chunks, 'Color'));
});
