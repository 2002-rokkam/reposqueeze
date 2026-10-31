import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine, extractTerms } from '../bench/variants/ripgrep-naive/src/engine.js';
import { tokens } from '../src/tokens.js';
import { scratch, writeFiles } from './bench-helpers.js';

const hasRg = (() => {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function repo(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = await scratch(t, 'rg');
  await writeFiles(root, files);
  return root;
}

test('extractTerms prefers code identifiers, drops stop words and caps the term list', () => {
  const terms = extractTerms('The QuerySet.get_or_create() fails when using select_related and the usual words like error occur. HTTPError 404');
  const texts = terms.map(t => t.text);
  assert.ok(texts.includes('QuerySet') && texts.includes('get_or_create') && texts.includes('select_related') && texts.includes('HTTPError'));
  assert.ok(!texts.includes('the') && !texts.includes('when'));
  assert.equal(terms.find(t => t.text === 'QuerySet')!.caseSensitive, true);
  assert.equal(terms.find(t => t.text === 'usual')!.caseSensitive, false);
  const many = extractTerms(Array.from({ length: 500 }, (_, i) => `identifier_${i}`).join(' '));
  assert.equal(many.length, 40);
  assert.deepEqual(extractTerms('a an of it'), []);
  assert.doesNotThrow(() => extractTerms('x'.repeat(200_000)));
  assert.doesNotThrow(() => extractTerms('é'.repeat(1000) + ' ünïcödé_ident'));
});

test('ripgrep-naive ranks the file that contains the rare terms first and cites verbatim lines', { skip: !hasRg && 'ripgrep is not installed' }, async t => {
  const filler = Array.from({ length: 60 }, (_, i) => `def helper_${i}(value):\n    return value + ${i}\n`).join('\n');
  const root = await repo(t, {
    'src/parser.py': `${filler}\n\ndef parse_widget_frobnicator(text):\n    # frobnicator splits on semicolons\n    return text.split(';')\n`,
    'src/other.py': `${filler}\n\ndef unrelated():\n    return 'value'\n`,
    'docs/notes.md': 'The value of things.\n',
    'src/data.bin': 'binary\0frobnicator\0data',
  });
  const query = 'parse_widget_frobnicator drops the last semicolon, frobnicator should keep it';
  const pack = await new Engine(root).context(query, 600);
  assert.ok(pack.evidence.length >= 1);
  assert.equal(pack.evidence[0].path, 'src/parser.py');
  assert.ok(pack.evidence.every(e => !e.path.endsWith('.bin')), 'binary files are never packed');
  const lines = (await readFile(join(root, 'src/parser.py'), 'utf8')).split('\n');
  const first = pack.evidence[0];
  const excerpt = lines.slice(first.start - 1, first.end).join('\n');
  assert.ok(pack.text.includes(excerpt), 'the excerpt is the exact source text');
  assert.ok(first.start <= lines.findIndex(l => l.includes('parse_widget_frobnicator')) + 1 && first.end >= lines.findIndex(l => l.includes('parse_widget_frobnicator')) + 1);
  assert.ok(tokens(pack.text) <= 600);
  assert.equal(pack.stats.outputTokens, tokens(pack.text));
});

test('ripgrep-naive is deterministic and never exceeds the token budget', { skip: !hasRg && 'ripgrep is not installed' }, async t => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) files[`pkg/mod${i}.py`] = Array.from({ length: 80 }, (_, j) => `def widget_${i}_${j}(socket, buffer):\n    return socket.send(buffer) + ${j}`).join('\n');
  files['pkg/long.js'] = `const widget = "${'x'.repeat(50_000)}";\nsocket.send(widget);\n`;
  const root = await repo(t, files);
  const query = 'socket send buffer widget_3_4 widget_7_9 fails with unicode ünï 日本語 and long lines';
  for (const budget of [256, 500, 2000, 8000]) {
    const a = await new Engine(root).context(query, budget);
    const b = await new Engine(root).context(query, budget);
    assert.equal(a.text, b.text, 'same snapshot and query give identical output');
    assert.deepEqual(a.evidence, b.evidence);
    assert.ok(tokens(a.text) <= budget, `${tokens(a.text)} tokens exceed the ${budget} budget`);
  }
  await assert.rejects(new Engine(root).context(query, 100), /budget/);
  await assert.rejects(new Engine(root).context('   ', 1000), /empty/);
});

test('ripgrep-naive answers gracefully when nothing matches', { skip: !hasRg && 'ripgrep is not installed' }, async t => {
  const root = await repo(t, { 'a.txt': 'hello\n' });
  const pack = await new Engine(root).context('zzzqqq_nonexistent_identifier', 500);
  assert.deepEqual(pack.evidence, []);
  assert.ok(pack.text.includes('No matching evidence'));
});
