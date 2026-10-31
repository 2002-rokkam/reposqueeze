import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/engine.js';
import { resolveFeatures } from '../src/features.js';
import { tokens } from '../src/tokens.js';

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'reposqueeze-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test('frames and git signals are opt-in; everything else is on by default', () => {
  const defaults = resolveFeatures(undefined);
  assert.ok(!defaults.has('frames') && !defaults.has('git'));
  for (const name of ['compactfmt', 'windows', 'pointers', 'priors', 'prf', 'phrase', 'redact', 'condense'] as const) assert.ok(defaults.has(name), name);
  assert.ok(resolveFeatures('+frames,+git').has('git'));
  assert.equal(resolveFeatures('none').size, 0);
  assert.throws(() => resolveFeatures('bogus'));
});

test('a query longer than 8000 characters is condensed instead of rejected, and still finds the code', async t => {
  const root = await fixture(t, { 'src/zebra.ts': 'export function computeZebraQuota(items: number[]) {\n  return items.length;\n}\n', 'src/other.ts': 'export const unrelated = 1;\n' });
  const noise = Array.from({ length: 900 }, (_, i) => `INFO 2026-01-01T00:00:${String(i % 60).padStart(2, '0')} worker-${i} heartbeat ok`).join('\n');
  const query = `computeZebraQuota returns the wrong value\n${noise}`;
  assert.ok(query.length > 8000);
  const pack = await new Engine(root).context(query, 1000);
  assert.match(pack.text, /computeZebraQuota/);
  assert.ok(tokens(pack.text) <= 1000);
  await assert.rejects(() => new Engine(root, { features: 'none' }).context(query, 1000), /8000/);
});

test('secret values in returned excerpts are redacted on their line while the surrounding code stays', async t => {
  const key = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
  const root = await fixture(t, { 'src/billing.ts': `import Stripe from 'stripe';\nexport function chargeCustomer(amount: number) {\n  const stripe = new Stripe("${key}");\n  return stripe.charges.create({ amount });\n}\n` });
  const withRedaction = await new Engine(root).context('chargeCustomer stripe charges create', 1000);
  assert.ok(!withRedaction.text.includes(key));
  assert.match(withRedaction.text, /\[REDACTED:[a-z0-9-]+\]/);
  assert.match(withRedaction.text, /stripe\.charges\.create/);
});

test('with +frames the file named by an application frame of the trace is ranked first', async t => {
  const body = (name: string) => `def process(value):\n    if value is None:\n        raise ValueError("bad ${name} value")\n    return value\n`;
  const root = await fixture(t, { 'pkg/a.py': body('alpha'), 'pkg/b.py': body('beta'), 'pkg/c.py': body('gamma') });
  const trace = 'Traceback (most recent call last):\n  File "/srv/app/pkg/b.py", line 3, in process\n    raise ValueError("bad value")\nValueError: bad value';
  const pack = await new Engine(root, { features: '+frames' }).context(trace, 800);
  const firstExcerpt = pack.evidence.find(e => e.kind !== 'pointer')!;
  assert.equal(firstExcerpt.path, 'pkg/b.py');
});

test('with +git, files with uncommitted work are preferred among otherwise identical candidates', async t => {
  const body = 'export function syncAccount(id: string) {\n  return fetchAccount(id);\n}\n';
  const root = await fixture(t, { 'src/one.ts': body, 'src/two.ts': body });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  await writeFile(join(root, 'src/two.ts'), `${body}// touched\n`);
  const pack = await new Engine(root, { features: '+git' }).context('syncAccount fetchAccount', 800);
  assert.equal(pack.evidence.find(e => e.kind !== 'pointer')!.path, 'src/two.ts');
});
