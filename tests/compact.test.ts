import test from 'node:test';
import assert from 'node:assert/strict';
import { compactLog } from '../src/compact.js';
import { tokens } from '../src/tokens.js';
import { cleanLine, detectPrefix, detectWorkspacePrefix, goTestEventToText, normalizeKey, shortenPrefix, squashRuns } from '../src/logs/normalize.js';
import { DrainMiner } from '../src/logs/drain.js';
import { Kind, Tier, explainLine } from '../src/logs/patterns.js';
import { countTokens } from '../src/logs/safe-tokens.js';
import { FIXTURES } from './log-fixtures.js';

// Deterministic generator (no Math.random in anything that influences results).
function rng(seed: number) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
}

const MARKER = /^\[\.\.\. L(\d+)-L(\d+) \((\d+) lines?\)/;
const REPEAT_NOTE = /  \[x\d+ total; also [^\]]*\]$/;

/**
 * Check the line arithmetic of a compacted log: verbatim lines count one each, markers state their exact range, and the
 * ranges must tile the original line numbers without gaps or overlaps. Returns the verbatim lines with their numbers.
 */
function account(text: string, expected: readonly string[], checkContent = true) {
  let cursor = 0;
  const verbatim: { n: number; text: string }[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('[RepoSqueeze log:') || line.startsWith('[job: ')) continue;
    const m = MARKER.exec(line);
    if (m) {
      const [a, b, count] = [Number(m[1]), Number(m[2]), Number(m[3])];
      assert.equal(a, cursor + 1, `marker starts at ${a} but ${cursor + 1} expected: ${line}`);
      assert.equal(b - a + 1, count, `marker count mismatch: ${line}`);
      cursor = b;
      continue;
    }
    cursor++;
    verbatim.push({ n: cursor, text: line });
    if (checkContent) assert.equal(line.replace(REPEAT_NOTE, ''), expected[cursor - 1], `line ${cursor} differs from the input`);
  }
  assert.equal(cursor, expected.length, 'every input line must be covered exactly once');
  return verbatim;
}

const inputLines = (text: string) => {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map(l => cleanLine(l).text);
};

// --- normalization ------------------------------------------------------------------------------------------------------

test('volatile tokens normalize to stable keys (timestamps, ids, addresses, durations, sizes, progress)', () => {
  const table: [string, string][] = [
    ['2025-03-01T10:15:02.114Z worker started', '<TS> worker started'],
    ['2025-03-01 10:15:02,114 INFO ready', '<TS> INFO ready'],
    ['2025/03/01 10:15:02 listening', '<TS> listening'],
    ['Mar  1 10:15:02 host sshd[991]: ok', '<TS> host sshd[991]: ok'],
    ['Sat, 01 Mar 2025 10:15:02 GMT', '<TS>'],
    ['request 3f2504e0-4f89-41d3-9a0c-0305e82c3301 done', 'request <UUID> done'],
    ['segfault at 0x7ffd1234abcd ip 0x55d0c0', 'segfault at <HEX> ip <HEX>'],
    ['checkout 3fa9c2e1d4b7 into /work', 'checkout <HASH> into /work'],
    ['connect 10.0.12.7:5432 refused', 'connect <IP> refused'],
    ['test_login passed (0.34s)', 'test_login passed (<DUR>)'],
    ['took 1m23s', 'took <DUR>'],
    ['downloaded 12.5 MB', 'downloaded <SIZE>'],
    ['[ 45%] Building CXX object', '[ <PCT>] Building CXX object'],
    ['spawned pid=4410', 'spawned pid=<N>'],
    ['wrote /tmp/tmpab12cd34ef/out.txt', 'wrote /tmp/<RAND>/out.txt']
  ];
  for (const [line, key] of table) assert.equal(normalizeKey(line, 'strict'), key, line);
  // strict keys keep plain integers (test parameters, line numbers); loose keys fold them.
  assert.equal(normalizeKey('FAILED test_case[17] at src/a.ts:42:7', 'strict'), 'FAILED test_case[17] at src/a.ts:42:7');
  assert.equal(normalizeKey('FAILED test_case[17] at src/a.ts:42:7', 'loose'), 'FAILED test_case[<N>] at src/a.ts:<N>');
  assert.equal(normalizeKey('item 17 of 400', 'loose'), 'item <N> of <N>');
  assert.equal(normalizeKey('opaque 9xKq83Lm20ZsPq77vNd4Rr1 token', 'loose'), 'opaque <ID> token');
  assert.equal(normalizeKey('⠋ Installing dependencies', 'strict'), 'Installing dependencies');
  assert.equal(normalizeKey('[=======>      ] building', 'strict'), '<BAR> building');
});

test('normalization is linear-time on hostile lines (long runs, nested separators, ReDoS-style input)', () => {
  const hostile = ['a'.repeat(100000), '0x' + 'f'.repeat(100000), '1'.repeat(100000), '-'.repeat(100000), '[' + '='.repeat(100000), '(' .repeat(50000) + ')'.repeat(50000), '1.'.repeat(50000), ('a1 ').repeat(40000), '/home/runner/work/x/x/'.repeat(5000)];
  const started = Date.now();
  for (const line of hostile) { normalizeKey(line.slice(0, 2000), 'loose'); normalizeKey(line, 'strict'); }
  assert(Date.now() - started < 8000, 'hostile input must not trigger super-linear regex behaviour');
});

test('cleanLine resolves ANSI, carriage-return redraws, BOM and control characters', () => {
  assert.deepEqual(cleanLine('\u001b[31mred\u001b[0m text\u001b[2K'), { text: 'red text', redraws: 0 });
  assert.deepEqual(cleanLine('Progress 10%\rProgress 55%\rProgress 100%'), { text: 'Progress 100%', redraws: 2 });
  assert.deepEqual(cleanLine('line with crlf\r'), { text: 'line with crlf', redraws: 0 });
  assert.deepEqual(cleanLine('\ufeffbom and \u0007bell\u0000 \u001b]8;;http://x\u0007link\u001b]8;;\u0007'), { text: 'bom and bell link', redraws: 0 });
  assert.equal(cleanLine('  indented stays   ').text, '  indented stays');
  assert.equal(squashRuns('x'.repeat(500)), 'x'.repeat(24) + '[x500]');
});

test('line prefixes: GitHub job/step/timestamp columns and plain timestamps are detected and stripped', () => {
  const gha = Array.from({ length: 20 }, (_, i) => `build (3.11)\tRun tests\t2025-03-01T10:00:${String(i).padStart(2, '0')}.1234567Z line ${i}`);
  const plan = detectPrefix(gha);
  assert(plan && plan.kind === 'gha');
  assert.deepEqual(plan.strip(gha[3]), { body: 'line 3', prefix: { job: 'build (3.11)', step: 'Run tests', stamp: '2025-03-01T10:00:03.1234567Z' } });
  const iso = Array.from({ length: 20 }, (_, i) => `2025-03-01 10:00:${String(i).padStart(2, '0')},120 INFO message ${i}`);
  assert.equal(detectPrefix(iso)?.strip(iso[5]).body, 'INFO message 5');
  // tab-separated data without timestamps must never be mistaken for a prefix
  assert.equal(detectPrefix(Array.from({ length: 20 }, (_, i) => `ok\tpkg${i}\t0.${i}s`)), null);
  assert.equal(detectPrefix(['plain', 'lines', 'only', 'here']), null);
  const root = '/home/runner/work/app/app/';
  assert.equal(detectWorkspacePrefix(Array.from({ length: 10 }, (_, i) => `  at ${root}src/f${i}.ts:1:1`)), root);
  assert.equal(shortenPrefix(`at ${root}src/a.ts:3`, root), 'at ./src/a.ts:3');
});

test('go test -json events become go test text', () => {
  assert.equal(goTestEventToText('{"Time":"t","Action":"output","Package":"p","Test":"TestX","Output":"    x_test.go:9: boom\\n"}'), '    x_test.go:9: boom');
  assert.equal(goTestEventToText('{"Action":"pass","Package":"p","Test":"TestX","Elapsed":0.5}'), '--- PASS: TestX (0.50s)');
  assert.equal(goTestEventToText('{"Action":"fail","Package":"example.com/p","Elapsed":1}'), 'FAIL\texample.com/p\t1.00s');
  assert.equal(goTestEventToText('{"unrelated":true}'), null);
  assert.equal(goTestEventToText('{"Action":"output"'), null);
  assert.equal(goTestEventToText('plain text'), null);
});

// --- template mining --------------------------------------------------------------------------------------------------

test('Drain miner groups similar lines into templates and keeps clusters bounded', () => {
  const miner = new DrainMiner();
  const a = miner.add('Downloading numpy 1.26 done'.split(' '));
  const b = miner.add('Downloading pandas 2.1 done'.split(' '));
  const c = miner.add('Connection refused to <IP>'.split(' '));
  assert(a && b && c);
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.deepEqual(a.template, ['Downloading', '<*>', '<*>', 'done']);
  assert.equal(a.size, 2);
  // deterministic: same input order, same ids
  const again = new DrainMiner();
  assert.equal(again.add('Downloading numpy 1.26 done'.split(' '))?.id, a.id);
  // caps: unique lines past maxClusters are not clustered (null) and never throw
  const capped = new DrainMiner({ maxClusters: 10, maxPerLeaf: 4 });
  let nulls = 0;
  for (let i = 0; i < 500; i++) if (capped.add([`u${i}`, `v${i}`, `w${i}`]) === null) nulls++;
  assert(capped.clusters.length <= 10);
  assert(nulls > 400);
  assert.equal(miner.add([]), null);
});

// --- classification ---------------------------------------------------------------------------------------------------

test('line classification table: failures are signals, passing tests and configuration echoes are not', () => {
  const table: [string, number, boolean, number?][] = [
    ['FAILED tests/test_auth.py::test_login - assert 500 == 401', Tier.FailingTest, true],
    ['E       assert 500 == 401', Tier.Assertion, true],
    ['tests/test_auth.py:42: AssertionError', Tier.AppFrame, false],
    ['--- FAIL: TestRouterRejectsBadHost (0.01s)', Tier.FailingTest, true],
    ['thread \'main\' panicked at src/main.rs:5:9:', Tier.FailingTest, true],
    ['error[E0308]: mismatched types', Tier.RootError, true],
    ["src/a.ts(4,2): error TS2322: Type 'string' is not assignable to type 'number'.", Tier.RootError, true],
    ['Traceback (most recent call last):', Tier.RootError, true],
    ['java.lang.IllegalStateException: boom', Tier.RootError, true],
    ['Caused by: java.io.IOException: closed', Tier.RootError, true],
    ['npm ERR! code ELIFECYCLE', Tier.RootError, true],
    ['##[error]Process completed with exit code 1.', Tier.Summary, true],
    ['=== 2 failed, 407 passed, 3 skipped in 12.34s ===', Tier.Summary, true],
    ['Tests:       1 failed, 112 passed, 113 total', Tier.Summary, true],
    ['[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0', Tier.Rest, false, Kind.PassNoise],
    ['Tests run: 5, Failures: 1, Errors: 0, Skipped: 0', Tier.Summary, true],
    ['test result: ok. 10 passed; 0 failed; 0 ignored', Tier.Summary, false],
    ['  ✓ handles errors gracefully (3 ms)', Tier.Dead, false, Kind.Pass],
    ['tests/test_errors.py::test_raises_error PASSED  [ 40%]', Tier.Dead, false, Kind.Pass],
    ['  [+] fails closed on malformed input 12ms', Tier.Dead, false, Kind.Pass],
    ['  fail-on-cache-miss: false', Tier.Rest, false],
    ['  dependency-graph-continue-on-failure: true', Tier.Rest, false],
    ['COMMON_MAVEN_ARGS: -e -B --fail-at-end', Tier.Rest, false],
    ['\t- "unicorn/prefer-abort-signal-timeout"', Tier.Rest, false],
    ['The last one failed', Tier.Rest, false],
    ['Failed to download package X', Tier.RootError, true],
    ['    at Object.<anonymous> (src/cart.test.ts:42:27)', Tier.AppFrame, false, Kind.FrameApp],
    ['    at node_modules/jest-circus/build/run.js:315:5', Tier.Dead, false, Kind.FrameLib],
    ['\tat java.base/java.lang.reflect.Method.invoke(Method.java:568)', Tier.Dead, false, Kind.FrameLib],
    ['\tat com.shop.web.CheckoutControllerTest.rejectsEmptyCart(CheckoutControllerTest.java:48)', Tier.AppFrame, false, Kind.FrameApp],
    ['Post job cleanup.', Tier.Dead, false, Kind.Noise],
    ['warning: unused variable `x`', Tier.Warning, false],
    ['', Tier.Dead, false, Kind.Blank]
  ];
  for (const [line, tier, signal, kind] of table) {
    const got = explainLine(line);
    assert.equal(got.tier, tier, `${line} -> tier ${got.tier} (${got.rule})`);
    assert.equal(got.signal, signal, `${line} -> signal ${got.signal} (${got.rule})`);
    if (kind !== undefined) assert.equal(got.kind, kind, `${line} -> kind ${got.kind} (${got.rule})`);
  }
});

// --- per-runner fixtures ----------------------------------------------------------------------------------------------

test('every runner fixture keeps its failures, diffs, frames and final counts at budget 1000', () => {
  for (const fixture of FIXTURES) {
    const out = compactLog(fixture.text, 1000);
    for (const needle of fixture.keep) assert(out.text.includes(needle), `${fixture.name}: lost "${needle}"`);
    assert(out.stats.failureSignalsTotal >= fixture.minSignals, `${fixture.name}: only ${out.stats.failureSignalsTotal} signals`);
    assert.equal(out.stats.failureSignalsKept, out.stats.failureSignalsTotal, `${fixture.name}: failure lines omitted`);
    assert(tokens(out.text) <= 1000, fixture.name);
    assert.equal(out.stats.outputTokens, tokens(out.text), `${fixture.name}: stats must match the real tokenizer`);
    assert.equal(out.stats.inputTokens, tokens(fixture.text), fixture.name);
    assert(out.stats.outputTokens <= out.stats.inputTokens, fixture.name);
    if (out.stats.lossy) assert.match(out.text.split('\n')[0], /LOSSY/); else assert.doesNotMatch(out.text, /LOSSY/);
  }
});

test('runner fixtures: line arithmetic is exact at every budget', () => {
  for (const fixture of FIXTURES) {
    const expected = inputLines(fixture.text);
    const checkContent = !fixture.name.startsWith('gha-') && fixture.name !== 'go-test-json' && fixture.name !== 'progress-redraw';
    for (const budget of [256, 500, 1000, 4000]) {
      const out = compactLog(fixture.text, budget);
      assert(tokens(out.text) <= budget, `${fixture.name}@${budget}: ${tokens(out.text)} tokens`);
      if (out.text === fixture.text) continue; // returned unchanged when nothing was gained
      account(out.text, expected, checkContent);
    }
  }
});

test('small budgets stay inside the budget and say when failure lines were omitted', () => {
  for (const fixture of FIXTURES) {
    const out = compactLog(fixture.text, 256);
    assert(tokens(out.text) <= 256, fixture.name);
    if (out.stats.failureSignalsKept < out.stats.failureSignalsTotal) {
      assert.match(out.text.split('\n')[0], /FAILURE-PATTERN LINES OMITTED/, fixture.name);
      assert.match(out.text, /FAILURE-PATTERN LINE/, fixture.name);
    }
  }
});

test('the header states lossy/lossless and the original size', () => {
  const small = compactLog('ok\n'.repeat(40) + 'FAILED x\n', 1000);
  assert.match(small.text.split('\n')[0], /^\[RepoSqueeze log: LOSSLESS \| 41 lines, \d+ B, \d+ tokens in/);
  const lossy = compactLog(FIXTURES[0].text, 500);
  assert.match(lossy.text.split('\n')[0], /^\[RepoSqueeze log: LOSSY \| \d+ lines, \d+ B, \d+ tokens in/);
  // nothing to fold and nothing lost: the text is returned as it is
  const tiny = 'one\ntwo\nthree\n';
  assert.equal(compactLog(tiny, 1000).text, tiny);
});

// --- folding behaviour ------------------------------------------------------------------------------------------------

test('exact duplicate runs are folded losslessly with exact counts', () => {
  const input = 'before\n' + 'heartbeat ok\n'.repeat(300) + 'after';
  const out = compactLog(input, 1000);
  assert.equal(out.stats.lossy, false);
  assert.match(out.text.split('\n')[0], /LOSSLESS/);
  assert.match(out.text, /\(299 lines\) identical to the line above, repeated 300 times total/);
  assert.equal(out.stats.foldedLines, 299);
  account(out.text, input.split('\n'));
});

test('lines that differ only in volatile fields fold into a template with exact first and last examples', () => {
  const lines = Array.from({ length: 183 }, (_, i) => `2025-03-01T10:00:${String(i % 60).padStart(2, '0')}.${String(100 + i)}Z INFO worker-${i % 4} handled request ${i * 7} in ${i % 90}ms`);
  const input = ['start', ...lines, 'ERROR final request failed: ECONNRESET'].join('\n');
  const out = compactLog(input, 1000);
  assert(out.stats.templates >= 1);
  assert(out.stats.foldedLines >= 170);
  assert.match(out.text, /similar lines folded; template: /);
  assert(out.text.includes('ERROR final request failed: ECONNRESET'));
  assert(out.text.includes(lines[0]) || out.text.includes(lines[0].replace(/^\S+ /, '')), 'first example is kept verbatim');
  assert(tokens(out.text) < tokens(input) / 4);
  account(out.text, input.split('\n'), false);
});

test('failing test names and their distinct messages are never templated away', () => {
  const failures = Array.from({ length: 25 }, (_, i) => `FAILED tests/test_pricing.py::test_case_${i} - AssertionError: expected ${i * 3} got ${i * 3 + 1}`);
  const input = [...Array.from({ length: 40 }, (_, i) => `tests/test_pricing.py::test_ok_${i} PASSED`), ...failures, '=== 25 failed, 40 passed in 1.2s ==='].join('\n');
  const out = compactLog(input, 2000);
  for (const line of failures) assert(out.text.includes(line), line);
  assert.equal(out.stats.failureSignalsKept, out.stats.failureSignalsTotal);
  assert.match(out.text, /40 tests passed/);
});

test('library frames collapse into counted markers while application frames, exception and root cause survive', () => {
  const fixture = FIXTURES.find(f => f.name === 'maven-surefire')!;
  const out = compactLog(fixture.text, 1000);
  assert.match(out.text, /library\/framework frames: [^\]]*java\.base|org\.junit/);
  assert(out.text.includes('CheckoutControllerTest.java:48'));
  assert(!out.text.includes('ReflectionUtils.invokeMethod'));
  const java = compactLog(FIXTURES.find(f => f.name === 'java-caused-by')!.text, 1000);
  for (const keep of ['java.lang.IllegalStateException', 'BeanCreationException', 'java.net.ConnectException', 'AppConfigTest.java:33', 'PoolFactory.java:71', '... 52 common frames omitted', '... 61 more']) assert(java.text.includes(keep), keep);
});

test('recursion and repeated frame cycles are counted, not repeated', () => {
  const recursion = FIXTURES.find(f => f.name === 'python-recursion')!;
  const out = compactLog(recursion.text, 1000);
  assert(out.stats.outputTokens < 400);
  assert(out.text.includes('RecursionError: maximum recursion depth exceeded'));
  assert.match(out.text, /\(\d+ lines?\) (?:identical|repeat|similar|repeats)/);
  assert.equal((out.text.match(/in walk/g) ?? []).length <= 4, true);
});

test('a stack trace repeated several times is folded after its first copy', () => {
  const trace = ['Error: payment declined', ...Array.from({ length: 12 }, (_, i) => `    at charge${i} (/srv/app/src/pay/step${i}.js:${10 + i}:5)`)];
  const lines: string[] = [];
  for (let i = 0; i < 5; i++) lines.push(`attempt ${i}: processing order ${900 + i}`, ...trace, `retrying in ${i + 1}s`);
  const out = compactLog(lines.join('\n'), 2000);
  assert.match(out.text, /\(\d+ lines\) repeat L\d+-L\d+/);
  assert(out.text.includes('Error: payment declined'));
  assert((out.text.match(/at charge3 /g) ?? []).length <= 2);
  account(out.text, lines, false);
});

test('repeated failure lines keep one copy with an exact repeat note and stay counted as covered', () => {
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) lines.push(`step ${i} running`, 'ERROR: connection to db refused', `step ${i} cleanup`);
  const out = compactLog([...lines, 'done'].join('\n'), 256);
  assert.equal(out.stats.failureSignalsTotal, 6);
  assert.equal(out.stats.failureSignalsKept, 6);
});

test('passing test lists fold into counted markers; warnings are deduplicated by template or kept on request', () => {
  const passes = Array.from({ length: 200 }, (_, i) => `tests/test_unit.py::test_case_${i} PASSED`);
  const warnings = Array.from({ length: 40 }, (_, i) => `DeprecationWarning: call ${i} is deprecated, use call_v2 (module m${i % 3})`);
  const input = [...passes.slice(0, 100), ...warnings, ...passes.slice(100), 'FAILED tests/test_unit.py::test_edge - ValueError', '=== 1 failed, 200 passed in 2s ==='].join('\n');
  const out = compactLog(input, 1000);
  assert.match(out.text, /\(\d+ lines\) 100 tests passed/);
  assert((out.text.match(/DeprecationWarning/g) ?? []).length <= 8, 'warnings are deduplicated');
  const kept = compactLog(input, 4000, { warnings: 'keep' });
  assert((kept.text.match(/DeprecationWarning/g) ?? []).length >= (out.text.match(/DeprecationWarning/g) ?? []).length);
});

test('GitHub Actions logs: prefixes, boilerplate and the post-job tail are folded; the failure is kept', () => {
  const fixture = FIXTURES.find(f => f.name === 'gha-prefixed-pytest')!;
  const out = compactLog(fixture.text, 1000);
  assert.match(out.text.split('\n')[0], /stripped: job\/step\/timestamp prefixes 2025-03-01T10:00:00\.\.10:01:\d\d/);
  assert(out.text.includes('[job: test (3.11) | step: Run pytest]'));
  assert(!out.text.includes('2025-03-01T10:'.concat('00:05')), 'timestamps must be stripped from the body');
  assert(out.stats.outputTokens < out.stats.inputTokens / 5);
  const boiler = ['##[group]Run npm test', 'npm test', 'FAIL src/a.test.ts', '##[error]Process completed with exit code 1.', 'Post job cleanup.', ...Array.from({ length: 20 }, (_, i) => `[command]/usr/bin/git config --local --get-all key${i}`)].join('\n');
  const tail = compactLog(boiler, 1000);
  assert.match(tail.text, /CI runner boilerplate/);
});

test('workspace paths are shortened and the header says so', () => {
  const root = '/home/runner/work/shop/shop/';
  const input = Array.from({ length: 30 }, (_, i) => `ERROR in ${root}src/mod${i}.ts: failed to compile unit ${i}`).join('\n');
  const out = compactLog(input, 2000);
  assert(out.text.includes('./src/mod3.ts'));
  assert(!out.text.includes(root + 'src/mod3.ts'));
  assert(out.text.split('\n')[0].includes(`${root} shown as ./`));
});

test('over-long lines are shortened with an explicit marker and counted as lossy', () => {
  const out = compactLog(['intro', 'x'.repeat(10) + ' ' + 'word '.repeat(2000), 'ERROR boom'].join('\n'), 1000);
  assert(out.stats.lossy);
  assert.match(out.text, /\[\.\.\.\d+ chars omitted\.\.\.\]/);
  assert.match(out.text.split('\n')[0], /over-long line/);
});

// --- budget, omission and honesty ------------------------------------------------------------------------------------

test('omitted failure lines are reported in the markers and the header, never silently dropped', () => {
  const failures = Array.from({ length: 150 }, (_, i) => `FAILED tests/test_bulk_${i}.py::test_x - AssertionError: value ${i * 13} is wrong`);
  const input = [...Array.from({ length: 300 }, (_, i) => `noise line ${i} with some words`), ...failures, '=== 150 failed in 9s ==='].join('\n');
  const out = compactLog(input, 256);
  assert(tokens(out.text) <= 256);
  assert(out.stats.failureSignalsKept < out.stats.failureSignalsTotal);
  assert.match(out.text.split('\n')[0], /FAILURE-PATTERN LINES OMITTED: kept \d+\/151/);
  assert.match(out.text, /omitted; \d+ FAILURE-PATTERN LINES/);
  // the arithmetic holds even when most of the log is omitted
  account(out.text, input.split('\n'), false);
  assert(out.text.includes('=== 150 failed in 9s ==='), 'the final summary is always kept');
});

test('a log without any failure pattern is not declared successful', () => {
  const out = compactLog(Array.from({ length: 400 }, (_, i) => `step ${i}: working on ${i % 11}`).join('\n'), 500);
  assert.match(out.text.split('\n')[0], /no failure-pattern lines found \(not proof of success\)/);
  assert.equal(out.stats.failureSignalsTotal, 0);
});

test('stats expose folding, omission and failure-signal accounting', () => {
  const out = compactLog(FIXTURES[0].text, 500);
  const s = out.stats;
  for (const key of ['inputTokens', 'outputTokens', 'inputLines', 'inputBytes', 'foldedLines', 'templates', 'omittedLines', 'failureSignalsKept', 'failureSignalsTotal', 'failureSignalsVerbatim']) assert.equal(typeof (s as unknown as Record<string, unknown>)[key], 'number', key);
  assert.equal(s.tokenizer, 'o200k_base');
  assert(Array.isArray(s.runners) && s.runners.includes('pytest'));
  assert.equal(s.inputLines, FIXTURES[0].text.split('\n').length - 1);
  assert(s.failureSignalsVerbatim <= s.failureSignalsKept && s.failureSignalsKept <= s.failureSignalsTotal);
  assert(s.foldedLines + s.omittedLines <= s.inputLines);
});

test('CRLF, ANSI colour, BOM and Unicode input compact like plain text', () => {
  const plain = ['\u2713 handles caf\u00e9 \u6d4b\u8bd5', ...FIXTURES[0].text.split('\n')].join('\n');
  const crlf = plain.replace(/\n/g, '\r\n');
  const colored = plain.split('\n').map(l => (l === '' ? l : `\u001b[32m${l}\u001b[0m`)).join('\n');
  const bom = '\ufeff' + plain;
  const reference = compactLog(plain, 1000);
  const body = (text: string) => text.split('\n').slice(1).join('\n'); // the header states the original size, which differs by design
  for (const variant of [crlf, colored, bom]) {
    const out = compactLog(variant, 1000);
    assert.equal(body(out.text), body(reference.text));
    assert.equal(out.stats.failureSignalsTotal, reference.stats.failureSignalsTotal);
  }
  const unicode = compactLog('\u9519\u8bef: \u6587\u4ef6\u4e0d\u5b58\u5728 \ud83e\uddea\nERROR \u00e9\u00e8 failed to open \u0444\u0430\u0439\u043b', 256);
  assert(unicode.text.includes('\ud83e\uddea'));
});

test('carriage-return progress redraws collapse to their final state and are reported', () => {
  const bar = Array.from({ length: 100 }, (_, i) => `Fetching ${i}%`).join('\r');
  const out = compactLog(['start', bar, 'ERROR: fetch failed'].join('\n'), 1000);
  assert(out.text.includes('Fetching 99%'));
  assert(!out.text.includes('Fetching 50%'));
  assert.match(out.text, /99 progress redraws/);
  assert(out.stats.lossy);
});

// --- property tests ---------------------------------------------------------------------------------------------------

interface RandomLog { text: string; lines: string[]; sentinels: string[] }

function randomLog(seed: number): RandomLog {
  const rand = rng(seed);
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)];
  const n = 80 + Math.floor(rand() * 900);
  const lines: string[] = [];
  const sentinels: string[] = [];
  const failureSlots = new Set<number>();
  const failures = Math.floor(rand() * 9);
  while (failureSlots.size < failures) failureSlots.add(Math.floor(rand() * n));
  for (let i = 0; i < n; i++) {
    if (failureSlots.has(i)) {
      const line = `FAILED tests/test_sentinel_${seed}_${i}.py::test_case - AssertionError: sentinel-${seed}-${i} mismatch`;
      sentinels.push(line);
      lines.push(line);
      continue;
    }
    switch (Math.floor(rand() * 8)) {
      case 0: lines.push(`2025-03-01T10:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00Z INFO worker-${Math.floor(rand() * 4)} processed item ${Math.floor(rand() * 1e6)} in ${Math.floor(rand() * 90)}ms`); break;
      case 1: lines.push(`Downloading package-${Math.floor(rand() * 500)} (${Math.floor(rand() * 900)} kB)`); break;
      case 2: lines.push(`tests/test_${Math.floor(rand() * 30)}.py::test_${Math.floor(rand() * 90)} PASSED`); break;
      case 3: lines.push(`DeprecationWarning: ${pick(['alpha', 'beta', 'gamma'])} is deprecated (${Math.floor(rand() * 9)})`); break;
      case 4: lines.push(...Array.from({ length: 3 + Math.floor(rand() * 5) }, (_, k) => `    at frame${k} (/srv/app/src/mod${k}.js:${10 + k}:3)`)); break;
      case 5: lines.push(''); break;
      case 6: lines.push(pick(['heartbeat ok', 'cache warm', 'connection pool idle'])); break;
      default: lines.push(`step ${Math.floor(rand() * 1e5)}: ${pick(['compile', 'link', 'package', 'upload'])} ${'x'.repeat(Math.floor(rand() * 60))}`);
    }
  }
  return { text: lines.join('\n'), lines, sentinels };
}

test('property: output never exceeds the budget and the line arithmetic always holds', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const log = randomLog(seed);
    const expected = inputLines(log.text);
    for (const budget of [256, 500, 1000, 2000, 4000]) {
      const out = compactLog(log.text, budget);
      assert(tokens(out.text) <= budget, `seed ${seed} budget ${budget}: ${tokens(out.text)}`);
      assert.equal(out.stats.outputTokens, tokens(out.text));
      if (out.text !== log.text) account(out.text, expected, false);
    }
  }
});

test('property: failure signals are retained unless the markers say otherwise', () => {
  for (let seed = 100; seed < 160; seed++) {
    const log = randomLog(seed);
    for (const budget of [256, 500, 1000, 2000]) {
      const out = compactLog(log.text, budget);
      const header = out.text.split('\n')[0];
      assert(out.stats.failureSignalsKept <= out.stats.failureSignalsTotal);
      assert(out.stats.failureSignalsTotal >= log.sentinels.length, `seed ${seed}`);
      if (out.stats.failureSignalsKept < out.stats.failureSignalsTotal) {
        assert.match(header, /FAILURE-PATTERN LINES OMITTED/, `seed ${seed} budget ${budget}`);
        assert.match(out.text, /FAILURE-PATTERN LINE/, `seed ${seed} budget ${budget}`);
      }
      if (budget >= 1000) {
        assert.equal(out.stats.failureSignalsKept, out.stats.failureSignalsTotal, `seed ${seed} budget ${budget}: ${header}`);
        for (const sentinel of log.sentinels) assert(out.text.includes(sentinel.slice(0, 60)), `seed ${seed} budget ${budget}: lost ${sentinel}`);
      }
    }
  }
});

test('property: compacting twice never grows beyond the first output, and results are deterministic', () => {
  for (let seed = 200; seed < 230; seed++) {
    const log = randomLog(seed);
    for (const budget of [500, 2000]) {
      const first = compactLog(log.text, budget);
      assert.equal(compactLog(log.text, budget).text, first.text, 'deterministic');
      const second = compactLog(first.text, budget);
      assert(second.stats.outputTokens <= first.stats.outputTokens, `seed ${seed} budget ${budget}: ${second.stats.outputTokens} > ${first.stats.outputTokens}`);
    }
  }
  for (const fixture of FIXTURES) {
    const first = compactLog(fixture.text, 1000), second = compactLog(first.text, 1000);
    assert(second.stats.outputTokens <= first.stats.outputTokens, fixture.name);
  }
});

// --- hostile input ----------------------------------------------------------------------------------------------------

test('adversarial 2 MiB inputs complete in linear time and respect the budget', () => {
  const rand = rng(7);
  const MiB2 = 2 * 1024 * 1024;
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  const cases: [string, () => string][] = [
    ['all unique lines', () => { const out: string[] = []; let size = 0; while (size < MiB2 - 120) { const l = `${pickWord()}-${Math.floor(rand() * 1e9)} ${pickWord()} ${Math.floor(rand() * 1e6).toString(16)} item ${out.length}`; out.push(l); size += l.length + 1; } return out.join('\n'); }],
    ['all identical lines', () => 'PASS ok\n'.repeat(Math.floor(MiB2 / 8))],
    ['100k very short lines', () => Array.from({ length: 100000 }, (_, i) => String(i % 977)).join('\n')],
    ['one 2 MiB line', () => 'x'.repeat(MiB2 - 10)],
    ['one 2 MiB line of words', () => Array.from({ length: 300000 }, () => pickWord()).join(' ').slice(0, MiB2 - 10)],
    ['long separators', () => ('='.repeat(3000) + '\n' + ' '.repeat(3000) + 'x\n').repeat(300).slice(0, MiB2 - 10)],
    ['regex-hostile', () => (('a'.repeat(5000) + '!').repeat(40) + '\n' + '('.repeat(3000) + '\n0x' + 'f'.repeat(4000) + '\n').repeat(10).slice(0, MiB2 - 10)]
  ];
  function pickWord() { return words[Math.floor(rand() * words.length)]; }
  for (const [name, make] of cases) {
    const input = make();
    const started = Date.now();
    const out = compactLog(input, 2000);
    const elapsed = Date.now() - started;
    assert(elapsed < 30000, `${name}: ${elapsed} ms (the 1.5 s target is measured by scripts/logs-eval.ts on an idle machine)`);
    assert(countTokens(out.text).tokens <= 2000, name);
    assert(out.stats.outputTokens <= 2000, name);
  }
  assert.throws(() => compactLog('x'.repeat(MiB2 + 1)), /2 MiB/);
});

test('binary noise and control characters never break compaction', () => {
  const rand = rng(11);
  let noise = '';
  for (let i = 0; i < 60000; i++) noise += String.fromCharCode(Math.floor(rand() * 256));
  const out = compactLog(noise + '\nERROR final failure\n', 500);
  assert(tokens(out.text) <= 500);
  assert(out.text.includes('ERROR final failure'));
});

test('empty and degenerate inputs', () => {
  assert.equal(compactLog('', 256).text, '');
  assert.equal(compactLog('\n', 256).text, '\n');
  assert.equal(compactLog('single line without newline', 256).text, 'single line without newline');
  assert.throws(() => compactLog('x', 100), /budget/);
  assert.throws(() => compactLog('x', 40000), /budget/);
});
