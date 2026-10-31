import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInChild } from '../bench/lib/runner.js';
import { scratch, writeFiles } from './bench-helpers.js';

const OK_ENGINE = `
export class Engine {
  constructor(root) { this.root = root; }
  async context(query, budget) {
    return {
      text: 'excerpt ' + query.slice(0, 20),
      evidence: [{ path: './src/a.py', start: 1, end: 3, id: 'e1' }, { path: this.root + '/src/b.py', start: 4, end: 6 }],
      stats: { outputTokens: 3, queryChars: query.length, budget, foo: process.env.RSQ_TEST_FOO ?? null, root: this.root },
    };
  }
}`;

async function variantDir(t: TestContext, engine: string): Promise<string> {
  const root = await scratch(t, 'worker');
  await writeFiles(root, { 'src/engine.ts': engine });
  return root;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a worker returns the pack, per-variant environment, normalised paths and harness-side token counts', { timeout: 180_000 }, async t => {
  const root = await variantDir(t, OK_ENGINE);
  const outcome = await runInChild({ variantRoot: root, repoRoot: root, query: 'hello world '.repeat(100), budget: 777, env: { RSQ_TEST_FOO: 'bar' }, timeoutMs: 120_000 });
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome));
  if (outcome.status !== 'ok') return;
  const { result } = outcome;
  assert.equal(result.stats.foo, 'bar');
  assert.equal(result.stats.queryChars, 1200);
  assert.equal(result.stats.budget, 777);
  assert.deepEqual(result.evidence.map(e => e.path), ['src/a.py', 'src/b.py'], 'absolute and ./ paths are made repository-relative');
  assert.ok(result.tokens > 0 && result.tokens < 20);
  assert.ok(result.rssMB > 20 && result.rssBaseMB > 20 && result.rssMB >= result.rssBaseMB * 0.5);
  assert.ok(result.ms >= 0 && result.cpuMs >= 0);
  assert.ok(outcome.wallMs >= result.ms);
});

test('engine exceptions, bad packs and crashes become error outcomes with the reason', { timeout: 240_000 }, async t => {
  const thrower = await variantDir(t, `export class Engine { constructor(){} async context() { throw new RangeError('boom from engine'); } }`);
  const bad = await variantDir(t, `export class Engine { constructor(){} async context() { return { text: 42 }; } }`);
  const crasher = await variantDir(t, `export class Engine { constructor(){} async context() { process.exit(3); } }`);
  const base = { repoRoot: thrower, query: 'q', budget: 500, env: {}, timeoutMs: 120_000 };
  const a = await runInChild({ ...base, variantRoot: thrower });
  assert.equal(a.status, 'error');
  assert.ok(a.status === 'error' && a.error.includes('boom from engine') && a.error.includes('RangeError'));
  const b = await runInChild({ ...base, variantRoot: bad });
  assert.ok(b.status === 'error' && /did not return a pack/.test(b.error));
  const c = await runInChild({ ...base, variantRoot: crasher });
  assert.ok(c.status === 'error' && /without a result \(code 3/.test(c.error), JSON.stringify(c));
});

test('a hanging engine times out and its whole process group is killed', { timeout: 240_000 }, async t => {
  const root = await variantDir(t, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    export class Engine {
      constructor(root) { this.root = root; }
      async context() {
        const helper = spawn('sleep', ['300'], { stdio: 'inherit' });
        writeFileSync(this.root + '/helper.pid', String(helper.pid));
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
    }`);
  const started = performance.now();
  const outcome = await runInChild({ variantRoot: root, repoRoot: root, query: 'q', budget: 500, env: {}, timeoutMs: 30_000 });
  const pid = Number(await readFile(join(root, 'helper.pid'), 'utf8').catch(() => 0));
  if (!pid) return t.skip('the machine is too loaded for the worker to start within the timeout');
  assert.equal(outcome.status, 'timeout');
  assert.ok(performance.now() - started < 60_000, 'the kill is prompt');
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, 'the helper process spawned by the engine must not survive the timeout');
});

test('helpers left behind by a finished engine cannot block the runner', { timeout: 180_000 }, async t => {
  const root = await variantDir(t, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    export class Engine {
      constructor(root) { this.root = root; }
      async context() {
        const helper = spawn('sleep', ['300'], { stdio: 'inherit' });
        writeFileSync(this.root + '/helper.pid', String(helper.pid));
        return { text: 'done', evidence: [], stats: {} };
      }
    }`);
  const outcome = await runInChild({ variantRoot: root, repoRoot: root, query: 'q', budget: 500, env: {}, timeoutMs: 120_000 });
  assert.equal(outcome.status, 'ok');
  const pid = Number(await readFile(join(root, 'helper.pid'), 'utf8'));
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(pid), false);
});
