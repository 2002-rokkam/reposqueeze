import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, languageFor } from '../src/parser.js';
import { tokens } from '../src/tokens.js';
import { DEFAULT_PARAMS, buildRepoMap, extractFocusTerms, pageRank, parseRepoMapText, rankRepositoryFiles, type RankGraph } from '../src/repomap.js';
import type { Chunk, Snapshot, SourceFile } from '../src/types.js';

function snapshotFrom(files: SourceFile[], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    files, chunks: files.flatMap(file => file.chunks), revision: 'abcdef0123456789', skipped: 0, truncated: false, warnings: [], root: '/repo', elapsedMs: 0,
    totalFiles: files.length, candidateFiles: files.length, indexMode: 'full',
    inventory: files.map(file => ({ path: file.path, language: file.language, lines: file.text ? file.text.split('\n').length : 120 })), ...extra
  };
}

async function parsedFile(path: string, text: string): Promise<SourceFile> {
  const { chunks, parsed } = await parseSource(path, text);
  return { path, text, hash: path, language: languageFor(path), chunks, parsed };
}

async function snapshotOf(sources: Record<string, string>, extra: Partial<Snapshot> = {}): Promise<Snapshot> {
  const files: SourceFile[] = [];
  for (const [path, text] of Object.entries(sources)) files.push(await parsedFile(path, text));
  return snapshotFrom(files, extra);
}

/** A file whose chunks are written by hand: each definition has the given name and mentions the given identifiers. */
function fakeFile(path: string, definitions: { name: string; refs?: string[]; kind?: string }[], language = 'python'): SourceFile {
  const chunks: Chunk[] = definitions.map((definition, i) => ({
    id: `${path}:${i}`, path, start: 1 + i * 10, end: 8 + i * 10, name: definition.name, kind: definition.kind ?? 'function_definition',
    text: `def ${definition.name}(a):\n    return a\n`, terms: [], refs: [definition.name, ...(definition.refs ?? [])]
  }));
  return { path, text: '', hash: path, language, chunks, parsed: true };
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

function cpuMs<T>(work: () => T): { value: T; ms: number } {
  const before = process.cpuUsage();
  const value = work();
  const used = process.cpuUsage(before);
  return { value, ms: (used.user + used.system) / 1000 };
}

/** A small Python package with one obvious hub (`pkg/core.py`), feature modules, tests, docs and data. */
async function packageSnapshot(extra: Record<string, string> = {}): Promise<Snapshot> {
  const sources: Record<string, string> = {
    'pkg/core.py': 'class Engine:\n    def run(self, task):\n        return task\n\n    def stop(self):\n        return None\n\n\ndef load_config(path):\n    return path\n',
    'pkg/util.py': 'def slugify_text(value):\n    return value.lower()\n\n\ndef _private_helper(value):\n    return value\n',
    'README.md': '# Package\n\nSome text.\n',
    'data/blob.csv': 'a,b\n1,2\n',
    'docs/conf.py': 'def setup(app):\n    app.add(Engine)\n    return app\n',
    ...extra
  };
  for (let i = 0; i < 24; i++) {
    sources[`pkg/feature_${i}.py`] = `from .core import Engine, load_config\nfrom .util import slugify_text\n\n\ndef feature_${i}_handler(request):\n    engine = Engine()\n    config = load_config(request)\n    ${i % 3 === 0 ? 'slug = slugify_text(config)\n    ' : ''}return engine.run(config)\n`;
  }
  for (let i = 0; i < 10; i++) {
    sources[`tests/test_feature_${i}.py`] = `from pkg.feature_${i} import feature_${i}_handler\nfrom pkg.core import Engine\n\n\ndef test_feature_${i}():\n    engine = Engine()\n    assert feature_${i}_handler(engine)\n`;
  }
  return snapshotOf(sources);
}

test('the hub of the reference graph leads the map and tests rank below the code they exercise', async () => {
  const snapshot = await packageSnapshot();
  const result = buildRepoMap(snapshot, { budget: 1500 });
  assert.equal(result.ranked[0].path, 'pkg/core.py');
  assert(result.text.includes('class Engine:') && result.text.includes('def load_config(path):'));
  const scores = new Map(rankRepositoryFiles(snapshot).map(entry => [entry.path, entry.score]));
  assert(scores.get('pkg/core.py')! > scores.get('pkg/feature_1.py')!);
  assert(scores.get('pkg/feature_1.py')! > scores.get('tests/test_feature_1.py')!, 'tests rank below source files');
  assert(scores.get('pkg/util.py')! > scores.get('docs/conf.py')!);
  const small = buildRepoMap(snapshot, { budget: 256 });
  assert.equal(small.ranked[0].path, 'pkg/core.py', 'the hub survives the smallest budget');
  assert(small.describedFiles >= 1);
});

test('nested definitions are shown under their container with the line number of each', async () => {
  const text = buildRepoMap(await packageSnapshot(), { budget: 1500 }).text;
  const parsed = parseRepoMapText(text);
  const core = parsed.files.find(file => file.path === 'pkg/core.py')!;
  assert.equal(core.described, true);
  assert.equal(core.lines, 11, 'line counts follow the snapshot inventory (split on newline)');
  assert.deepEqual(core.definitions.slice(0, 1), [{ line: 1, text: 'class Engine:' }]);
  assert(core.definitions.some(def => def.text.startsWith('def run(self, task):')));
  assert(text.includes(' L2  def run(self, task):') || text.includes(' L2  def stop(self):') || text.includes(' L9 def load_config(path):'));
  assert(/^# repomap abcdef01 \| \d+ files, \d+ defs \| \d+ shown, \d+ with defs \| ranked by reference-graph centrality; not exhaustive$/.test(text.split('\n')[0]));
});

test('output is deterministic and independent of input order', async () => {
  const snapshot = await packageSnapshot();
  const first = buildRepoMap(snapshot, { budget: 900, focusTerms: ['Engine'] });
  assert.deepEqual(buildRepoMap(snapshot, { budget: 900, focusTerms: ['Engine'] }), first);
  const shuffled = snapshotFrom([...snapshot.files].reverse(), { inventory: [...snapshot.inventory!].reverse() });
  assert.equal(buildRepoMap(shuffled, { budget: 900, focusTerms: ['Engine'] }).text, first.text);
  const random = mulberry32(3);
  const mixed = snapshotFrom([...snapshot.files].sort(() => random() - 0.5));
  assert.equal(buildRepoMap(mixed, { budget: 900, focusTerms: ['Engine'] }).text, first.text);
});

test('the rendered map never exceeds the budget and uses most of small budgets', async () => {
  const snapshot = await packageSnapshot();
  for (const budget of [256, 257, 300, 400, 512, 777, 1000, 1500, 2048, 3000, 8000, 20000, 32000]) {
    const result = buildRepoMap(snapshot, { budget });
    assert(result.tokens <= budget, `${result.tokens} > ${budget}`);
    assert.equal(result.tokens, tokens(result.text));
    const parsed = parseRepoMapText(result.text);
    assert.deepEqual(new Set(parsed.files.map(file => file.path)), new Set(result.ranked.map(entry => entry.path)));
    assert.equal(result.files, parsed.files.length);
    assert.equal(result.describedFiles, parsed.files.filter(file => file.described).length);
    assert.equal(result.symbols, parsed.files.reduce((sum, file) => sum + file.definitions.length, 0));
    if (budget <= 512) assert(result.tokens >= 0.85 * budget, `${result.tokens} of ${budget} used`);
  }
  assert.equal(buildRepoMap(snapshot, { budget: 10 }).tokens <= 256, true, 'budgets below 256 are clamped up');
  assert(buildRepoMap(snapshot, { budget: 1e9 }).tokens <= 32000);
  assert(buildRepoMap(snapshot, { budget: Number.NaN }).tokens <= 1500);
});

test('budget exactness holds on a repository with long signatures and many definitions', async () => {
  const sources: Record<string, string> = {};
  const random = mulberry32(11);
  for (let f = 0; f < 60; f++) {
    let text = '';
    for (let d = 0; d < 12; d++) {
      const params = Array.from({ length: 1 + Math.floor(random() * 14) }, (_, p) => `argument_number_${p}: Optional[Dict[str, List[int]]] = None`).join(', ');
      text += `def function_${f}_${d}(${params}):\n    return ${d > 0 ? `function_${(f + 1) % 60}_${d - 1}(1)` : 'None'}\n\n\n`;
    }
    sources[`mod${f % 7}/sub${f % 3}/file_${f}.py`] = text;
  }
  const snapshot = await snapshotOf(sources);
  for (let budget = 256; budget <= 32000; budget = Math.ceil(budget * 1.9)) {
    const result = buildRepoMap(snapshot, { budget });
    assert(result.tokens <= budget && result.tokens === tokens(result.text), `budget ${budget}`);
  }
});

test('shared directory prefixes are printed once and every path can be reconstructed', async () => {
  const sources: Record<string, string> = { 'setup.py': 'def configure(app):\n    return app\n' };
  for (let i = 0; i < 12; i++) sources[`src/main/java/org/example/service/Service${i}.java`] = `package a;\npublic class Service${i} {\n    public void run${i}() {\n        go();\n    }\n}\n`;
  for (let i = 0; i < 5; i++) sources[`src/main/java/org/example/model/Model${i}.java`] = `package a;\npublic class Model${i} {\n    public int get${i}() {\n        return 1;\n    }\n}\n`;
  sources['docs/guide/intro.md'] = '# Intro\n';
  const snapshot = await snapshotOf(sources);
  const result = buildRepoMap(snapshot, { budget: 8000 });
  const lines = result.text.split('\n');
  assert.equal(lines.filter(line => line === 'src/main/java/org/example/').length, 1, 'the common prefix is a single header');
  assert(lines.some(line => line === ' service/') && lines.some(line => line === ' model/'), 'children are relative to the shared header');
  assert.equal(lines.filter(line => line.includes('org/example')).length, 1);
  assert.deepEqual(new Set(parseRepoMapText(result.text).files.map(file => file.path)), new Set(Object.keys(sources)));
  const single = buildRepoMap(await snapshotOf({ 'a/b/c/d.py': 'def only():\n    return 1\n' }), { budget: 400 });
  assert(single.text.split('\n').includes('a/b/c/'), 'a chain of directories without files collapses into one header');
});

test('unicode, quoting and very long paths round-trip and respect the budget', async () => {
  const odd = [
    'src/日本語/ファイル.py', 'emoji/🚀 rocket.py', 'quote/"x".py', 'a/also:', 'a/L12', 'a/12: x.py', 'sp ace/dir with spaces/f.py',
    `${'long'.repeat(75)}/${'file'.repeat(60)}.py`, 'ünï/çödé.py', 'rtl/\u202eevil.py', 'dots/.hidden/..file', 'back\u200bslash/zw.py'
  ];
  const snapshot = snapshotFrom(odd.map(path => fakeFile(path, [{ name: 'thing_one' }, { name: 'thing_two' }])));
  const big = buildRepoMap(snapshot, { budget: 32000 });
  assert.deepEqual(new Set(parseRepoMapText(big.text).files.map(file => file.path)), new Set(odd));
  assert(!/[\u202e\u200b]/.test(big.text), 'invisible and bidirectional controls are never printed raw');
  assert(!big.text.includes('\t'));
  assert(!buildRepoMap(snapshotFrom([fakeFile('tab\tname/x.py', [{ name: 'thing_one' }])]), { budget: 300 }).text.includes('tab'), 'control characters in a path are never printed');
  for (const budget of [256, 300, 1500]) {
    const result = buildRepoMap(snapshot, { budget });
    assert(result.tokens <= budget);
    for (const file of parseRepoMapText(result.text).files) assert(odd.includes(file.path), `${JSON.stringify(file.path)} is a real path`);
  }
  const huge = `${'segment/'.repeat(400)}file.py`;
  const withHuge = buildRepoMap(snapshotFrom([fakeFile(huge, [{ name: 'x_y' }]), fakeFile('small.py', [{ name: 'a_b' }])]), { budget: 256 });
  assert(withHuge.tokens <= 256);
  for (const file of parseRepoMapText(withHuge.text).files) assert([huge, 'small.py'].includes(file.path), 'a path is shown whole or not at all');
});

test('hostile paths in a snapshot are not printed', () => {
  const bad = ['../../etc/passwd', '/abs/path.py', 'a\\b.py', 'line\nbreak.py', 'nul\u0000.py', '..', '.', 'a//b.py', 'a/../b.py', 'a/./b.py', ''];
  const files = [...bad.map(path => fakeFile(path, [{ name: 'evil_name' }])), fakeFile('ok/fine.py', [{ name: 'good_name' }])];
  const result = buildRepoMap(snapshotFrom(files), { budget: 1000 });
  assert.deepEqual(parseRepoMapText(result.text).files.map(file => file.path), ['ok/fine.py']);
  assert(!result.text.includes('evil_name') && !result.text.includes('passwd'));
});

test('empty, text-only and definition-free snapshots produce a valid map', async () => {
  const empty = buildRepoMap(snapshotFrom([]), { budget: 256 });
  assert.equal(empty.files, 0);
  assert.deepEqual(empty.ranked, []);
  assert(empty.text.startsWith('# repomap ') && empty.tokens <= 256);
  const text = buildRepoMap(snapshotFrom([{ path: 'notes.txt', text: 'hello\nworld\n', hash: 'x', language: 'text', chunks: [], parsed: false }]), { budget: 256 });
  assert.deepEqual(parseRepoMapText(text.text).files.map(file => [file.path, file.described]), [['notes.txt', false]]);
  assert.equal(text.describedFiles, 0);
  const noInventory = snapshotFrom([fakeFile('a.py', [{ name: 'alpha_beta' }])], { inventory: undefined });
  const result = buildRepoMap(noInventory, { budget: 300 });
  assert.equal(result.describedFiles, 1);
  assert.equal(parseRepoMapText(result.text).files[0].lines, 1, 'line counts come from the text when there is no inventory');
  const none = await snapshotOf({ 'a.py': 'x = 1\n', 'b.js': 'let y = 2;\n' });
  assert.equal(buildRepoMap(none, { budget: 256 }).describedFiles, 0, 'single-line statements are not definitions');
});

test('maxFiles caps the number of files shown', async () => {
  const files = Array.from({ length: 500 }, (_, i) => fakeFile(`dir${i % 10}/file_${i}.py`, [{ name: `name_${i}`, refs: [`name_${(i + 1) % 500}`] }]));
  const snapshot = snapshotFrom(files);
  assert(buildRepoMap(snapshot, { budget: 32000 }).files <= 200, 'default cap is 200');
  assert(buildRepoMap(snapshot, { budget: 32000, maxFiles: 25 }).files <= 25);
  assert.equal(buildRepoMap(snapshot, { budget: 32000, maxFiles: 1 }).files, 1);
});

test('focus paths and focus terms pull a buried file into a small map', async () => {
  const snapshot = await packageSnapshot({ 'pkg/obscure/ledger_tools.py': 'def reconcile_ledger_entries(entries):\n    total = 0\n    return total\n' });
  const plain = buildRepoMap(snapshot, { budget: 256 });
  assert(!plain.ranked.some(entry => entry.path === 'pkg/obscure/ledger_tools.py'));
  for (const options of [{ focusTerms: ['reconcile_ledger_entries'] }, { focusTerms: ['reconcile', 'ledger'] }, { focusTerms: ['RECONCILE_LEDGER_ENTRIES()'] }, { focusPaths: ['pkg/obscure/ledger_tools.py'] }, { focusPaths: ['pkg/obscure/'] }, { focusPaths: ['ledger_tools.py'] }, { focusTerms: ['pkg/obscure/ledger_tools.py'] }]) {
    const focused = buildRepoMap(snapshot, { budget: 256, ...options });
    const file = parseRepoMapText(focused.text).files.find(entry => entry.path === 'pkg/obscure/ledger_tools.py');
    assert(file?.described, JSON.stringify(options));
    assert(focused.tokens <= 256);
  }
  const unrelated = buildRepoMap(snapshot, { budget: 256, focusTerms: ['no_such_identifier_anywhere'], focusPaths: ['nowhere/at/all.py'] });
  assert.equal(unrelated.text, plain.text, 'a focus that matches nothing changes nothing');
});

test('focus terms boost the definitions they name inside a file', async () => {
  const lines = ['class Big:'];
  for (let i = 0; i < 30; i++) lines.push(`    def method_${i}(self, value):\n        return value + ${i}\n`);
  const snapshot = await snapshotOf({ 'big.py': lines.join('\n'), 'other.py': 'def other_function(a):\n    return a\n' });
  const focused = buildRepoMap(snapshot, { budget: 256, focusTerms: ['method_23'] });
  assert(parseRepoMapText(focused.text).files.find(file => file.path === 'big.py')!.definitions.some(def => def.text.includes('method_23')));
});

test('cascade snapshots list the unparsed files of the inventory by name', () => {
  const parsed = [fakeFile('src/a.py', [{ name: 'alpha_one', refs: ['beta_two'] }]), fakeFile('src/b.py', [{ name: 'beta_two' }])];
  const inventory = [...parsed.map(file => ({ path: file.path, language: 'python', lines: 20 })), ...Array.from({ length: 100 }, (_, i) => ({ path: `lib/m${i}.py`, language: 'python', lines: 30 }))];
  const result = buildRepoMap(snapshotFrom(parsed, { inventory, indexMode: 'cascade', totalFiles: 102 }), { budget: 1500 });
  assert(result.text.split('\n')[0].includes('cascade: graph over 2 parsed of 102 files'));
  const paths = parseRepoMapText(result.text).files.map(file => file.path);
  assert(paths.includes('src/a.py') && paths.includes('lib/m3.py'));
  assert(new Set(paths).size === paths.length);
  assert(buildRepoMap(snapshotFrom(parsed, { truncated: true }), { budget: 300 }).text.split('\n')[0].endsWith('incomplete scan'));
});

test('a signature supplied by the chunker is used, and CRLF sources print without carriage returns', async () => {
  const file = fakeFile('sig.py', [{ name: 'custom_name' }]);
  (file.chunks[0] as Chunk & { signature?: string }).signature = 'def custom_name(alpha, beta) -> int';
  assert(buildRepoMap(snapshotFrom([file]), { budget: 300 }).text.includes('def custom_name(alpha, beta) -> int'));
  const source = 'class A:\r\n    def method_one(self,\r\n                   other):\r\n        return other\r\n';
  const result = buildRepoMap(await snapshotOf({ 'crlf.py': source }), { budget: 300 });
  assert(!result.text.includes('\r'));
  assert(result.text.includes('def method_one(self, other):'));
});

test('graph shapes: star, chain, cycle, complete, isolated and self-referencing files', () => {
  const finite = (scores: { score: number }[]) => scores.every(entry => Number.isFinite(entry.score) && entry.score >= 0);

  const star = [fakeFile('hub.py', [{ name: 'Hub' }]), ...Array.from({ length: 2000 }, (_, i) => fakeFile(`leaf/l${i}.py`, [{ name: `leaf_${i}`, refs: ['Hub'] }]))];
  const starRanks = rankRepositoryFiles(snapshotFrom(star));
  assert.equal(starRanks[0].path, 'hub.py');
  assert(finite(starRanks));
  assert.equal(buildRepoMap(snapshotFrom(star), { budget: 256 }).ranked[0].path, 'hub.py');

  const chainOf = (length: number) => Array.from({ length }, (_, i) => fakeFile(`c/f${String(i).padStart(3, '0')}.py`, [{ name: `link_${i}`, refs: i + 1 < length ? [`link_${i + 1}`] : [] }]));
  const short = rankRepositoryFiles(snapshotFrom(chainOf(8)));
  assert.equal(short[0].path, 'c/f007.py', 'rank accumulates at the end of a chain');
  assert.deepEqual(short.map(entry => entry.path), Array.from({ length: 8 }, (_, i) => `c/f${String(7 - i).padStart(3, '0')}.py`));
  const long = rankRepositoryFiles(snapshotFrom(chainOf(500)));
  assert(finite(long) && long.at(-1)!.path === 'c/f000.py', 'the head of a chain ranks last');

  const cycle = [fakeFile('x/a.py', [{ name: 'node_a', refs: ['node_b'] }]), fakeFile('x/b.py', [{ name: 'node_b', refs: ['node_a'] }])];
  const [first, second] = rankRepositoryFiles(snapshotFrom(cycle));
  assert(Math.abs(first.score - second.score) < 1e-12);

  const names = Array.from({ length: 40 }, (_, i) => `member_${i}`);
  const complete = names.map((name, i) => fakeFile(`k/m${i}.py`, [{ name, refs: names.filter(other => other !== name) }]));
  const completeRanks = rankRepositoryFiles(snapshotFrom(complete));
  assert(finite(completeRanks));
  assert(completeRanks[0].score - completeRanks.at(-1)!.score < 1e-9, 'symmetric graph, equal scores');

  const lonely = [fakeFile('l/a.py', [{ name: 'only_here', refs: ['only_here'] }]), fakeFile('l/b.py', [{ name: 'only_there' }]), fakeFile('l/c.py', [])];
  const lonelyRanks = rankRepositoryFiles(snapshotFrom(lonely));
  assert(finite(lonelyRanks));
  assert.deepEqual(lonelyRanks.map(entry => entry.path), ['l/a.py', 'l/b.py', 'l/c.py'], 'ties break by path');
  assert(Math.abs(lonelyRanks[0].score - lonelyRanks[1].score) < 1e-12, 'self references add no edges');
});

test('private, generic, over-defined and test-side names carry less weight', () => {
  // Every user mentions all candidates, so the multipliers decide how its single unit of rank is split.
  const candidates = ['visible_helper', '_hidden_helper', 'toString', 'shared_item'];
  const definers = candidates.map(name => fakeFile(`lib/${name}.py`, [{ name }]));
  const users = Array.from({ length: 12 }, (_, i) => fakeFile(`user/u${i}.py`, [{ name: `use_all_${i}`, refs: candidates }]));
  const scores = new Map(rankRepositoryFiles(snapshotFrom([...definers, ...users])).map(entry => [entry.path, entry.score]));
  assert(scores.get('lib/visible_helper.py')! > scores.get('lib/_hidden_helper.py')!, 'private names weigh less');
  assert(scores.get('lib/visible_helper.py')! > scores.get('lib/toString.py')!, 'generic names weigh less');
  assert(scores.get('lib/shared_item.py')! > scores.get('lib/toString.py')!);

  const referencing = (name: string) => Array.from({ length: 12 }, (_, i) => fakeFile(`user/${name}_${i}.py`, [{ name: `use_${name}_${i}`, refs: [name] }]));
  const scoreOf = (definer: SourceFile, name: string) => new Map(rankRepositoryFiles(snapshotFrom([definer, ...referencing(name)])).map(entry => [entry.path, entry.score])).get(definer.path)!;
  assert(scoreOf(fakeFile('lib/core.py', [{ name: 'shared_thing' }]), 'shared_thing') > scoreOf(fakeFile('tests/core.py', [{ name: 'shared_thing' }]), 'shared_thing'), 'test directories rank below equal source files');

  const overDefined = Array.from({ length: DEFAULT_PARAMS.maxDefiners + 5 }, (_, i) => fakeFile(`def/d${i}.py`, [{ name: 'process_item' }]));
  const callers = Array.from({ length: 20 }, (_, i) => fakeFile(`use/u${i}.py`, [{ name: `use_it_${i}`, refs: ['process_item'] }]));
  const ranks = rankRepositoryFiles(snapshotFrom([...overDefined, ...callers])).filter(entry => entry.path.startsWith('def/'));
  assert(ranks[0].score - ranks.at(-1)!.score < 1e-12, 'a name defined in too many files adds no edges');
});

test('pageRank basics: normalisation, personalisation, dangling nodes, bad weights', () => {
  const graph = (n: number, edges: [number, number, number][]): RankGraph => {
    const rowStart = new Uint32Array(n + 1);
    for (const [from] of edges) rowStart[from + 1]++;
    for (let i = 0; i < n; i++) rowStart[i + 1] += rowStart[i];
    const cursor = rowStart.slice(0, n);
    const target = new Uint32Array(edges.length);
    const weight = new Float64Array(edges.length);
    for (const [from, to, w] of edges) {
      target[cursor[from]] = to;
      weight[cursor[from]++] = w;
    }
    return { size: n, rowStart, target, weight };
  };
  const sum = (values: Float64Array) => values.reduce((a, b) => a + b, 0);
  assert.equal(pageRank(graph(0, [])).length, 0);
  assert.deepEqual([...pageRank(graph(1, []))], [1]);
  const ranks = pageRank(graph(3, [[0, 1, 1], [1, 2, 1]]));
  assert(Math.abs(sum(ranks) - 1) < 1e-9 && ranks[2] > ranks[1] && ranks[1] > ranks[0]);
  const personalised = pageRank(graph(3, [[0, 1, 1], [1, 2, 1]]), { teleport: Float64Array.from([0, 0, 1]) });
  assert(personalised[2] > 0.5, 'dangling mass returns to the teleport node');
  const noisy = pageRank(graph(3, [[0, 1, Number.NaN], [0, 2, -5], [1, 2, Number.POSITIVE_INFINITY]]));
  assert(Array.from(noisy).every(Number.isFinite) && Math.abs(sum(noisy) - 1) < 1e-9);
  const uniform = pageRank(graph(4, []), { teleport: new Float64Array(4) });
  assert(uniform.every(value => Math.abs(value - 0.25) < 1e-12), 'an all-zero teleport falls back to uniform');
  assert.deepEqual(pageRank(graph(3, [[0, 1, 1]]), { damping: 0 }).map(value => Math.round(value * 1e9) / 1e9), Float64Array.from([1 / 3, 1 / 3, 1 / 3]).map(value => Math.round(value * 1e9) / 1e9));
});

test('50,000 nodes rank within two seconds of CPU time, in the graph and in the whole map', () => {
  const n = 50_000;
  const random = mulberry32(99);
  const rowStart = new Uint32Array(n + 1);
  const targets: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 5; k++) targets.push(Math.floor(random() ** 3 * n));
    rowStart[i + 1] = targets.length;
  }
  const graph: RankGraph = { size: n, rowStart, target: Uint32Array.from(targets), weight: new Float64Array(targets.length).fill(1) };
  const ranked = cpuMs(() => pageRank(graph));
  assert(ranked.ms < 2000, `pageRank used ${ranked.ms.toFixed(0)} ms of CPU`);
  assert(Math.abs(ranked.value.reduce((a, b) => a + b, 0) - 1) < 1e-6);

  const files = Array.from({ length: n }, (_, i) => fakeFile(`p${i % 50}/q${i % 500}/f${i}.py`, [{ name: `symbol_${i}`, refs: [`symbol_${Math.floor(random() ** 3 * n)}`, `symbol_${Math.floor(random() ** 3 * n)}`, 'local_a', 'local_b'] }]));
  const snapshot = snapshotFrom(files);
  const built = cpuMs(() => buildRepoMap(snapshot, { budget: 1500 }));
  assert(built.ms < 2000, `buildRepoMap used ${built.ms.toFixed(0)} ms of CPU`);
  assert(built.value.tokens <= 1500 && built.value.describedFiles > 5);
});

test('the shapes of a chain and a star of 50,000 files stay fast', () => {
  const n = 50_000;
  const chain = Array.from({ length: n }, (_, i) => fakeFile(`c/f${i}.py`, [{ name: `link_${i}`, refs: i + 1 < n ? [`link_${i + 1}`] : [] }]));
  const chained = cpuMs(() => buildRepoMap(snapshotFrom(chain), { budget: 800 }));
  assert(chained.ms < 2000, `${chained.ms.toFixed(0)} ms`);
  const star = [fakeFile('hub.py', [{ name: 'Hub' }]), ...Array.from({ length: n }, (_, i) => fakeFile(`s/f${i}.py`, [{ name: `leaf_${i}`, refs: ['Hub'] }]))];
  const starred = cpuMs(() => buildRepoMap(snapshotFrom(star), { budget: 800 }));
  assert(starred.ms < 2000, `${starred.ms.toFixed(0)} ms`);
  assert.equal(starred.value.ranked[0].path, 'hub.py');
});

test('extractFocusTerms finds identifiers, dotted names and file paths without a model', () => {
  const text = 'Calling `Session.send` with `prepare_url("http://x")` raises requests.exceptions.InvalidURL in src/requests/models.py.\nThe HTTPAdapter handles this poorly when MAX_RETRIES is set, and the quick brown fox does nothing special.';
  const terms = extractFocusTerms(text);
  for (const expected of ['prepare_url', 'HTTPAdapter', 'MAX_RETRIES', 'src/requests/models.py', 'InvalidURL', 'Session']) assert(terms.includes(expected), `${expected} in ${terms.join(' ')}`);
  for (const stop of ['with', 'when', 'the', 'This']) assert(!terms.includes(stop));
  assert.deepEqual(extractFocusTerms(text), terms);
  assert.equal(extractFocusTerms(text, 3).length, 3);
  assert.deepEqual(extractFocusTerms(''), []);
  const started = performance.now();
  const noise = extractFocusTerms(`${'a_b '.repeat(50_000)}${'x'.repeat(100_000)} ${'é'.repeat(50_000)}`);
  assert(performance.now() - started < 1500 && noise.length <= 32);
});
