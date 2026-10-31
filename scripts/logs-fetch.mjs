#!/usr/bin/env node
// Read-only corpus fetcher for the logs lane: downloads failed public CI job logs with the gh CLI.
// Only `gh run list` and `gh run view` are used (GET requests). Logs go to the lab corpus, never into git.
//   node scripts/logs-fetch.mjs [--out DIR] [--per-ecosystem 18] [--per-repo 5]
// The dev/test split follows the program rule: first byte of SHA-256("rsq-v3:" + instance_id) even => dev.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const run = promisify(execFile);
const { values: args } = parseArgs({ options: {
  out: { type: 'string', default: join(homedir(), 'reposqueeze-lab/corpus/logs') },
  'per-ecosystem': { type: 'string', default: '18' },
  'per-repo': { type: 'string', default: '5' },
  concurrency: { type: 'string', default: '3' }
} });
const perEcosystem = Number(args['per-ecosystem']), perRepo = Number(args['per-repo']), concurrency = Number(args.concurrency);

// Hand-labelled candidate repositories (popular, public, GitHub Actions CI), best candidates first.
const CANDIDATES = {
  pytest: ['pytest-dev/pytest', 'pandas-dev/pandas', 'django/django', 'pallets/flask', 'psf/requests', 'pydantic/pydantic', 'home-assistant/core', 'scikit-learn/scikit-learn', 'numpy/numpy', 'python/mypy', 'pypa/pip', 'encode/httpx', 'tiangolo/fastapi', 'huggingface/transformers'],
  js: ['vitest-dev/vitest', 'jestjs/jest', 'vuejs/core', 'sveltejs/svelte', 'babel/babel', 'eslint/eslint', 'prettier/prettier', 'microsoft/TypeScript', 'vitejs/vite', 'webpack/webpack', 'mochajs/mocha', 'nodejs/node', 'withastro/astro', 'TanStack/query', 'facebook/docusaurus', 'storybookjs/storybook'],
  go: ['hashicorp/terraform', 'prometheus/prometheus', 'grafana/grafana', 'etcd-io/etcd', 'cli/cli', 'gohugoio/hugo', 'traefik/traefik', 'caddyserver/caddy', 'gin-gonic/gin', 'containerd/containerd', 'helm/helm', 'argoproj/argo-cd', 'cilium/cilium', 'minio/minio'],
  rust: ['tokio-rs/tokio', 'rust-lang/cargo', 'astral-sh/ruff', 'astral-sh/uv', 'denoland/deno', 'tauri-apps/tauri', 'bevyengine/bevy', 'clap-rs/clap', 'nushell/nushell', 'zed-industries/zed', 'helix-editor/helix', 'rust-lang/rust-analyzer', 'rust-lang/rust-clippy'],
  java: ['spring-projects/spring-boot', 'spring-projects/spring-framework', 'apache/kafka', 'quarkusio/quarkus', 'square/okhttp', 'junit-team/junit5', 'google/guava', 'mockito/mockito', 'apache/dubbo', 'hibernate/hibernate-orm', 'keycloak/keycloak', 'apache/pulsar', 'apache/camel', 'gradle/gradle', 'apache/flink', 'alibaba/nacos'],
  dotnet: ['dotnet/runtime', 'dotnet/efcore', 'dotnet/aspire', 'dotnet/maui', 'dotnet/sdk', 'microsoft/PowerToys', 'App-vNext/Polly', 'serilog/serilog', 'AvaloniaUI/Avalonia', 'ppy/osu', 'jellyfin/jellyfin', 'bitwarden/server', 'abpframework/abp', 'microsoft/semantic-kernel', 'MassTransit/MassTransit'],
  ruby: ['rails/rails', 'rubocop/rubocop', 'mastodon/mastodon', 'discourse/discourse', 'jekyll/jekyll', 'fastlane/fastlane', 'Homebrew/brew', 'heartcombo/devise', 'puma/puma', 'rspec/rspec', 'chatwoot/chatwoot', 'sidekiq/sidekiq', 'forem/forem'],
  php: ['laravel/framework', 'symfony/symfony', 'composer/composer', 'doctrine/orm', 'WordPress/gutenberg', 'PHP-CS-Fixer/PHP-CS-Fixer', 'phpstan/phpstan-src', 'pestphp/pest', 'livewire/livewire', 'filamentphp/filament', 'Sylius/Sylius', 'nextcloud/server', 'matomo-org/matomo', 'craftcms/cms'],
  cpp: ['llvm/llvm-project', 'opencv/opencv', 'nlohmann/json', 'catchorg/Catch2', 'google/googletest', 'protocolbuffers/protobuf', 'bitcoin/bitcoin', 'ggml-org/llama.cpp', 'godotengine/godot', 'ClickHouse/ClickHouse', 'curl/curl', 'openssl/openssl', 'fmtlib/fmt', 'duckdb/duckdb', 'apache/arrow', 'facebook/rocksdb']
};

const MAX_BYTES = 2 * 1024 * 1024, MIN_BYTES = 1500;
const split = id => createHash('sha256').update('rsq-v3:' + id).digest()[0] % 2 === 0 ? 'dev' : 'test';
const gh = async (ghArgs, encoding = 'utf8') => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return (await run('gh', ghArgs, { encoding, maxBuffer: 512 * 1024 * 1024, timeout: 240000 })).stdout; }
    catch (error) { if (attempt === 2) throw error; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
  }
};
const safe = text => text.replace(/[^A-Za-z0-9._-]+/g, '_');

async function fetchRepo(ecosystem, repo, budgetLeft) {
  const found = [];
  let runs;
  try { runs = JSON.parse(await gh(['run', 'list', '-R', repo, '--status', 'failure', '--limit', '25', '--json', 'databaseId,workflowName,headBranch,event,createdAt'])); }
  catch (error) { console.error(`[skip] ${repo}: run list failed: ${String(error.message).split('\n')[0]}`); return found; }
  // Prefer distinct workflows first so one noisy workflow does not dominate the repository sample.
  const seen = new Set(), ordered = [];
  for (const r of runs) if (!seen.has(r.workflowName)) { seen.add(r.workflowName); ordered.push(r); }
  for (const r of runs) if (!ordered.includes(r)) ordered.push(r);
  for (const r of ordered.slice(0, 8)) {
    if (found.length >= Math.min(perRepo, budgetLeft)) break;
    let jobs;
    try { jobs = JSON.parse(await gh(['run', 'view', String(r.databaseId), '-R', repo, '--json', 'jobs'])).jobs; } catch { continue; }
    const failed = jobs.filter(j => j.conclusion === 'failure');
    const names = new Set();
    for (const job of failed) {
      if (found.length >= Math.min(perRepo, budgetLeft) || names.size >= 2) break;
      const family = job.name.replace(/[\d.]+/g, '#');
      if (names.has(family)) continue;
      // Every third log is the full job log (all steps) instead of only the failed steps.
      const mode = (found.length % 3 === 2) ? 'full' : 'failed';
      let buffer;
      try { buffer = Buffer.from(await gh(['run', 'view', String(r.databaseId), '-R', repo, '--job', String(job.databaseId), mode === 'full' ? '--log' : '--log-failed'], 'buffer')); } catch { continue; }
      if (buffer.length < MIN_BYTES || buffer.length > MAX_BYTES) { console.error(`[skip] ${repo} job ${job.databaseId}: ${buffer.length} bytes`); continue; }
      names.add(family);
      const instance = `${repo}#${r.databaseId}:${job.databaseId}:${mode}`;
      const file = `${safe(repo)}__${r.databaseId}__${job.databaseId}__${mode}.log`;
      const dir = split(instance);
      await mkdir(join(args.out, dir), { recursive: true });
      await writeFile(join(args.out, dir, file), buffer);
      found.push({ instance, ecosystem, repo, runId: r.databaseId, jobId: job.databaseId, workflow: r.workflowName, job: job.name, mode, event: r.event, createdAt: r.createdAt, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), split: dir, file: `${dir}/${file}` });
      console.error(`[ok] ${ecosystem} ${repo} job ${job.databaseId} ${mode} ${buffer.length}B -> ${dir}`);
    }
  }
  return found;
}

const manifest = [];
// Rewritten after every repository so an interrupted run still leaves a usable manifest.
const writeManifest = () => writeFile(join(args.out, 'manifest.json'), JSON.stringify({
  fetchedWith: 'gh run list / gh run view (read-only)', splitRule: 'sha256("rsq-v3:"+instance)[0] even => dev',
  entries: [...manifest].sort((a, b) => a.instance.localeCompare(b.instance))
}, null, 1) + '\n');
const counts = Object.fromEntries(Object.keys(CANDIDATES).map(k => [k, 0]));
// Round-robin over ecosystems so a slow ecosystem does not starve the others.
const byIndex = [];
for (let i = 0; i < 20; i++) for (const ecosystem of Object.keys(CANDIDATES)) if (CANDIDATES[ecosystem][i]) byIndex.push({ ecosystem, repo: CANDIDATES[ecosystem][i] });
let next = 0;
async function worker() {
  while (next < byIndex.length) {
    const { ecosystem, repo } = byIndex[next++];
    const left = perEcosystem - counts[ecosystem];
    if (left <= 0) continue;
    const found = await fetchRepo(ecosystem, repo, left);
    counts[ecosystem] += found.length;
    manifest.push(...found);
    await writeManifest();
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await writeManifest();
console.error('per ecosystem:', JSON.stringify(counts), 'total', manifest.length, 'dev', manifest.filter(m => m.split === 'dev').length);
