import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { crc32, gzipSync } from 'node:zlib';
import { TOKENIZER_VERSION } from '../src/tokenize.js';
import {
  CACHE_FORMAT_VERSION, CacheCorruptError, CacheStore, cacheLocation, cacheVersions, clearCache, decodeContainer, encodeContainer, parserFingerprint, summarizeCache
} from '../src/store.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const posix = process.platform !== 'win32';

/** Sets environment variables for one test and restores them afterwards (tests in a file run sequentially). */
function useEnv(t: TestContext, vars: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
  apply(vars);
  t.after(() => apply(saved));
}

async function scratch(t: TestContext, prefix = 'reposqueeze-store-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await chmod(dir, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

const keyOf = (root: string) => createHash('sha256').update(root).digest('hex').slice(0, 16);

test('cache location honours REPOSQUEEZE_CACHE_DIR, the platform default, the legacy repo mode and off', t => {
  useEnv(t, { REPOSQUEEZE_CACHE_DIR: '/custom/cache' });
  assert.deepEqual(cacheLocation('/work/repo'), { mode: 'custom', dir: join('/custom/cache', keyOf('/work/repo')) });
  assert.notEqual(cacheLocation('/work/a').dir, cacheLocation('/work/b').dir);
  assert.equal(cacheLocation('/work/a').dir, cacheLocation('/work/a').dir);
  assert.match(cacheLocation('/work/a').dir!, /[0-9a-f]{16}$/);
  process.env.REPOSQUEEZE_CACHE_DIR = 'repo';
  assert.deepEqual(cacheLocation('/work/repo'), { mode: 'repo', dir: join('/work/repo', '.reposqueeze-v2') });
  for (const off of ['off', 'none', 'memory']) { process.env.REPOSQUEEZE_CACHE_DIR = off; assert.deepEqual(cacheLocation('/work/repo'), { mode: 'off' }); }
  delete process.env.REPOSQUEEZE_CACHE_DIR;
  const platform = cacheLocation('/work/repo');
  assert.equal(platform.mode, 'platform');
  assert.match(platform.dir!, /reposqueeze/);
  if (process.platform === 'darwin') assert.equal(platform.dir, join(homedir(), 'Library', 'Caches', 'reposqueeze', keyOf('/work/repo')));
  if (process.platform === 'linux') {
    process.env.XDG_CACHE_HOME = '/xdg/cache';
    assert.equal(cacheLocation('/work/repo').dir, join('/xdg/cache', 'reposqueeze', keyOf('/work/repo')));
    process.env.XDG_CACHE_HOME = 'relative/path';
    assert.equal(cacheLocation('/work/repo').dir, join(homedir(), '.cache', 'reposqueeze', keyOf('/work/repo')));
  }
});

test('container round trip keeps typed sections, JSON header, alignment and empty sections, with and without gzip', () => {
  for (const compress of [false, true]) {
    const header = { a: 1, nested: { b: [1, 2, 3] }, text: 'héllo 🧪' };
    const file = Buffer.concat(encodeContainer('TESTCONT', header, [
      { name: 'u32', data: Uint32Array.from([1, 2, 3, 4, 5]) }, { name: 'f64', data: Float64Array.from([1.5, -2]) },
      { name: 'bytes', data: Buffer.from('hello') }, { name: 'empty', data: new Uint16Array(0) }
    ], { compress }));
    // Also decode from a buffer whose memory is not 8-byte aligned.
    for (const source of [file, Buffer.concat([Buffer.alloc(3), file]).subarray(3)]) {
      const container = decodeContainer(source, 'TESTCONT');
      assert.deepEqual(container.header, header);
      assert.deepEqual(Array.from(container.array('u32', Uint32Array)), [1, 2, 3, 4, 5]);
      assert.deepEqual(Array.from(container.array('f64', Float64Array)), [1.5, -2]);
      assert.equal(Buffer.from(container.bytes('bytes')).toString(), 'hello');
      assert.equal(container.array('empty', Uint16Array).length, 0);
      assert.equal(container.has('missing'), false);
      assert.throws(() => container.bytes('missing'), CacheCorruptError);
      assert.throws(() => container.array('bytes', Uint32Array), CacheCorruptError, 'five bytes are not a whole number of 32-bit words');
    }
    assert.throws(() => decodeContainer(file, 'OTHERMAG'), CacheCorruptError);
  }
});

test('every truncated, bit-flipped or extended container is rejected with CacheCorruptError', () => {
  const sections = [{ name: 'a', data: Uint32Array.from({ length: 64 }, (_, i) => i * 7) }, { name: 'b', data: Buffer.from('payload'.repeat(20)) }];
  for (const compress of [false, true]) {
    const file = Buffer.concat(encodeContainer('TESTCONT', { x: 1 }, sections, { compress }));
    assert.doesNotThrow(() => decodeContainer(file, 'TESTCONT'));
    for (let length = 0; length < file.length; length += 3) assert.throws(() => decodeContainer(file.subarray(0, length), 'TESTCONT'), CacheCorruptError, `truncated to ${length}`);
    for (let at = 0; at < file.length; at += 5) {
      if (at >= 24 && at < 32) continue; // reserved preamble bytes carry no information
      const bad = Buffer.from(file);
      bad[at] ^= 0x41;
      assert.throws(() => decodeContainer(bad, 'TESTCONT'), CacheCorruptError, `bit flip at ${at}`);
    }
    assert.throws(() => decodeContainer(Buffer.concat([file, Buffer.from('x')]), 'TESTCONT'), CacheCorruptError);
  }
});

/** Wraps an arbitrary body in a preamble with a valid checksum, as an attacker who knows the format would. */
function forge(body: Buffer, flags = 0): Buffer {
  const preamble = Buffer.alloc(32);
  preamble.write('TESTCONT', 0, 8, 'latin1');
  preamble.writeUInt32LE(CACHE_FORMAT_VERSION, 8);
  preamble.writeUInt32LE(flags, 12);
  preamble.writeUInt32LE(body.length, 16);
  preamble.writeUInt32LE(crc32(body) >>> 0, 20);
  return Buffer.concat([preamble, body]);
}

test('containers with valid checksums but hostile structure are rejected', () => {
  const directory = (entries: [string, number, number][], json = '{}', counts?: [number, number]) => {
    const head = Buffer.alloc(8 + entries.length * 24);
    head.writeUInt32LE(counts?.[0] ?? Buffer.byteLength(json), 0);
    head.writeUInt32LE(counts?.[1] ?? entries.length, 4);
    entries.forEach(([name, offset, bytes], i) => { head.write(name, 8 + i * 24, 16, 'latin1'); head.writeUInt32LE(offset, 8 + i * 24 + 16); head.writeUInt32LE(bytes, 8 + i * 24 + 20); });
    return Buffer.concat([head, Buffer.from(json), Buffer.alloc(64)]);
  };
  const hostile: [string, Buffer][] = [
    ['empty body', Buffer.alloc(0)],
    ['huge section count', directory([], '{}', [2, 1_000_000])],
    ['header longer than body', directory([], '{}', [1_000_000, 0])],
    ['offset beyond body', directory([['a', 1 << 20, 8]])],
    ['unaligned offset', directory([['a', 4 + 8 + 24 + 2 + 3, 4]])],
    ['length beyond body', directory([['a', 8 + 24 + 8, 1 << 30]])],
    ['duplicate names', directory([['a', 8 + 48 + 8, 0], ['a', 8 + 48 + 8, 0]])],
    ['section overlapping the directory', directory([['a', 0, 8]])],
    ['invalid JSON header', directory([], '{nope')]
  ];
  for (const [name, body] of hostile) assert.throws(() => decodeContainer(forge(body), 'TESTCONT'), CacheCorruptError, name);
  const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024), { level: 1 });
  assert.throws(() => decodeContainer(forge(bomb, 1), 'TESTCONT', 1024 * 1024), CacheCorruptError, 'decompression bomb');
  assert.throws(() => decodeContainer(forge(Buffer.from('not gzip'), 1), 'TESTCONT'), CacheCorruptError);
  assert.throws(() => decodeContainer(forge(Buffer.alloc(16), 2), 'TESTCONT'), CacheCorruptError, 'unknown flags');
});

test('store writes atomically with private permissions, reads back, and leaves no temporary files', async t => {
  const base = await scratch(t);
  useEnv(t, { REPOSQUEEZE_CACHE_DIR: base });
  const store = new CacheStore('/some/root');
  assert.equal(await store.read('a.bin'), undefined);
  assert.equal(await store.write('a.bin', [Buffer.from('hello '), Buffer.from('world')]), true);
  assert.equal((await store.read('a.bin'))?.toString(), 'hello world');
  assert.equal(await store.write('a.bin', [Buffer.from('second')]), true);
  assert.equal((await store.read('a.bin'))?.toString(), 'second');
  assert.deepEqual(await readdir(store.dir!), ['a.bin']);
  if (posix) {
    assert.equal((await stat(join(store.dir!, 'a.bin'))).mode & 0o777, 0o600);
    assert.equal((await stat(store.dir!)).mode & 0o777, 0o700);
  }
  await store.remove('a.bin');
  assert.equal(await store.read('a.bin'), undefined);
});

test('store refuses symlinked cache directories and never follows planted symlinks', { skip: !posix }, async t => {
  const base = await scratch(t), victim = await scratch(t, 'reposqueeze-victim-');
  useEnv(t, { REPOSQUEEZE_CACHE_DIR: base });
  await writeFile(join(victim, 'secret.txt'), 'top secret');
  const hijacked = new CacheStore('/hijacked/root');
  await symlink(victim, hijacked.dir!);
  assert.equal(await hijacked.write('a.bin', [Buffer.from('payload')]), false);
  assert.match(hijacked.lastError ?? '', /symlink/);
  assert.equal(await hijacked.read('secret.txt'), undefined);
  assert.deepEqual(await readdir(victim), ['secret.txt'], 'nothing was written through the symlink');

  const store = new CacheStore('/honest/root');
  assert.equal(await store.write('index.bin', [Buffer.from('v1')]), true);
  await rm(join(store.dir!, 'index.bin'));
  await symlink(join(victim, 'secret.txt'), join(store.dir!, 'index.bin'));
  assert.equal(await store.read('index.bin'), undefined, 'a symlinked cache file is not read');
  assert.equal(await store.write('index.bin', [Buffer.from('v2')]), true, 'rename replaces the link itself');
  assert.equal((await lstat(join(store.dir!, 'index.bin'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(victim, 'secret.txt'), 'utf8'), 'top secret', 'the link target is untouched');
});

test('store refuses cache directories that others could write', { skip: !posix || isRoot }, async t => {
  const base = await scratch(t);
  useEnv(t, { REPOSQUEEZE_CACHE_DIR: base });
  const store = new CacheStore('/shared/root');
  await mkdir(store.dir!, { recursive: true });
  await chmod(store.dir!, 0o777);
  assert.equal(await store.write('a.bin', [Buffer.from('x')]), false);
  assert.match(store.lastError ?? '', /writable/);
  await chmod(store.dir!, 0o700);
  assert.equal(await store.write('a.bin', [Buffer.from('x')]), true);
});

test('store degrades to false/undefined on read-only directories, oversized files and absurd writes', { skip: !posix || isRoot }, async t => {
  const base = await scratch(t);
  useEnv(t, { REPOSQUEEZE_CACHE_DIR: base });
  const store = new CacheStore('/limits/root');
  assert.equal(await store.write('a.bin', [Buffer.alloc(100, 1)]), true);
  assert.equal(await store.read('a.bin', 10), undefined);
  assert.match(store.lastError ?? '', /exceeds/);
  assert.equal(await store.write('huge.bin', [{ length: 2 ** 31 } as unknown as Uint8Array]), false);
  assert.match(store.lastError ?? '', /would exceed/);
  await chmod(store.dir!, 0o500);
  assert.equal(await store.write('b.bin', [Buffer.from('x')]), false);
  await chmod(store.dir!, 0o700);
  assert.deepEqual(await readdir(store.dir!), ['a.bin'], 'a failed write leaves no partial or temporary file');
});

test('store with persistence off or an unusable base directory reports false without throwing', async t => {
  useEnv(t, { REPOSQUEEZE_CACHE_DIR: 'off' });
  const off = new CacheStore('/x');
  assert.equal(off.enabled, false);
  assert.equal(await off.write('a', [Buffer.from('x')]), false);
  assert.equal(await off.read('a'), undefined);
  const base = await scratch(t);
  await writeFile(join(base, 'blocker'), 'a file where a directory is needed');
  process.env.REPOSQUEEZE_CACHE_DIR = join(base, 'blocker', 'inner');
  const blocked = new CacheStore('/y');
  assert.equal(await blocked.write('a', [Buffer.from('x')]), false);
  assert.ok(blocked.lastError);
});

test('summary and clearCache report and remove exactly the repository cache directory', { skip: !posix }, async t => {
  const base = await scratch(t), repo = await scratch(t, 'reposqueeze-repo-');
  useEnv(t, { REPOSQUEEZE_CACHE_DIR: base });
  const before = await summarizeCache(repo);
  assert.equal(before.exists, false);
  assert.equal(before.mode, 'custom');
  const real = new CacheStore(await realpath(repo));
  await real.write('index-v1.bin', [Buffer.alloc(1000)]);
  await real.write('stats-v1.json', [Buffer.alloc(24)]);
  await writeFile(join(base, 'unrelated.txt'), 'keep me');
  const summary = await summarizeCache(repo);
  assert.equal(summary.exists, true);
  assert.equal(summary.totalBytes, 1024);
  assert.deepEqual(summary.entries.map(entry => entry.name), ['index-v1.bin', 'stats-v1.json']);
  const cleared = await clearCache(repo);
  assert.equal(cleared.removed, true);
  assert.equal(cleared.bytes, 1024);
  assert.equal((await summarizeCache(repo)).exists, false);
  assert.equal(await readFile(join(base, 'unrelated.txt'), 'utf8'), 'keep me');
  assert.equal((await clearCache(repo)).removed, false, 'clearing an absent cache is a no-op');
  // A symlinked cache directory is not followed or deleted.
  const victim = await scratch(t, 'reposqueeze-victim-');
  await writeFile(join(victim, 'precious.txt'), 'x');
  await symlink(victim, real.dir!);
  const refused = await clearCache(repo);
  assert.equal(refused.removed, false);
  assert.equal(await readFile(join(victim, 'precious.txt'), 'utf8'), 'x');
});

test('parser fingerprint is stable and the version triple carries format, parser and tokenizer versions', async () => {
  const first = await parserFingerprint();
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(await parserFingerprint(), first);
  assert.deepEqual(await cacheVersions(), { format: CACHE_FORMAT_VERSION, parser: first, tokenizer: TOKENIZER_VERSION, text: 1 });
});

test('eight processes hammering one cache directory never see torn or corrupt files', { timeout: 240_000 }, async t => {
  const base = await scratch(t);
  const processes = Number(process.env.RSQ_TEST_PROCESSES ?? 8), iterations = 25;
  const runs = Array.from({ length: processes }, (_, id) => new Promise<{ code: number | null; out: string; err: string }>(resolveRun => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/hammer-store.ts', '/hammered/root', String(id), String(iterations)], {
      cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, REPOSQUEEZE_CACHE_DIR: base }
    });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => resolveRun({ code, out, err }));
  }));
  for (const run of await Promise.all(runs)) {
    assert.equal(run.code, 0, run.err);
    const result = JSON.parse(run.out.trim().split('\n').pop()!) as { writes: number; reads: number };
    assert.ok(result.writes > 0 && result.reads > 0);
  }
  useEnv(t, { REPOSQUEEZE_CACHE_DIR: base });
  const store = new CacheStore('/hammered/root');
  const final = await store.read('hammer.bin');
  assert.ok(final, 'a complete final file exists');
  assert.doesNotThrow(() => decodeContainer(final!, 'HAMMERTS'));
  assert.deepEqual((await readdir(store.dir!)).filter(name => name.endsWith('.tmp')), [], 'no temporary files remain');
});
