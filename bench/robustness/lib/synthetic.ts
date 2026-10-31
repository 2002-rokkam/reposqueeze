import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitInit, makeWritable } from './fixtures.js';
import { Rng } from './prng.js';
import { SCRATCH_ROOT } from './paths.js';
import { withHeavy } from './throttle.js';

/**
 * Deterministic synthetic repositories for scale and safety-limit checks. They replace cloning the
 * very largest open-source trees (kernel, LLVM, ...) on a shared machine: same inputs, same bytes.
 */
export type SyntheticKind = 'code' | 'tiny';

export interface SyntheticSpec {
  kind: SyntheticKind;
  files: number;
  seed?: string;
}

const WORDS = 'account alpha batch buffer cache channel client cluster config context cursor dispatch driver engine event filter gateway handle index job kernel ledger lock mapper merge metric module node parser planner policy queue reader record region render router schema scheduler session shard signal socket stream table token trace tree update vector worker writer'.split(' ');
const EXTENSIONS = ['ts', 'py', 'go', 'rs', 'java', 'c', 'rb'] as const;

const cap = (word: string) => word[0].toUpperCase() + word.slice(1);

/** One realistic-looking source file: a few functions with identifiers drawn from a shared vocabulary. */
export function sourceFile(rng: Rng, ext: (typeof EXTENSIONS)[number], index: number): string {
  const names = Array.from({ length: rng.between(3, 6) }, () => `${rng.pick(WORDS)}${cap(rng.pick(WORDS))}${index % 1000}`);
  const comment = (text: string) => (ext === 'py' || ext === 'rb' ? `# ${text}` : `// ${text}`);
  const lines: string[] = [comment(`Module ${index}: ${rng.pick(WORDS)} ${rng.pick(WORDS)} handling for the ${rng.pick(WORDS)} subsystem.`)];
  for (const name of names) {
    const note = comment(`${cap(rng.pick(WORDS))} the ${rng.pick(WORDS)} before ${rng.pick(WORDS)} is updated; callers must hold the ${rng.pick(WORDS)} lock.`);
    switch (ext) {
      case 'ts':
        lines.push('', note, `export function ${name}(input: string, limit = ${rng.between(1, 99)}): number {`, `  const parts = input.split(':').slice(0, limit);`, `  return parts.length * ${rng.between(2, 9)};`, '}');
        break;
      case 'py':
        lines.push('', '', `def ${name}(value, limit=${rng.between(1, 99)}):`, `    ${note}`, `    return [part for part in str(value).split(":")][:limit]`);
        break;
      case 'go':
        lines.push('', note, `func ${cap(name)}(input string, limit int) int {`, `\treturn len(input) % ${rng.between(2, 9)}`, '}');
        break;
      case 'rs':
        lines.push('', note, `pub fn ${name}(input: &str, limit: usize) -> usize {`, `    input.len().min(limit) * ${rng.between(2, 9)}`, '}');
        break;
      case 'java':
        lines.push('', note, `  static int ${name}(String input, int limit) {`, `    return Math.min(input.length(), limit) * ${rng.between(2, 9)};`, '  }');
        break;
      case 'c':
        lines.push('', note, `static int ${name}(const char *input, int limit)`, '{', `\treturn (int)strlen(input) % ${rng.between(2, 9)} + limit;`, '}');
        break;
      case 'rb':
        lines.push('', note, `def ${name}(input, limit = ${rng.between(1, 99)})`, `  input.to_s.split(':').first(limit).size * ${rng.between(2, 9)}`, 'end');
        break;
    }
  }
  return `${lines.join('\n')}\n`;
}

const directory = (spec: SyntheticSpec) => join(SCRATCH_ROOT, 'fixtures', `synthetic-${spec.kind}-${spec.files}`);
const markerFile = (spec: SyntheticSpec) => `${directory(spec)}.ok`;
const fingerprint = (spec: SyntheticSpec) => createHash('sha256').update(`v1:${spec.kind}:${spec.files}:${spec.seed ?? 'rsq'}`).digest('hex').slice(0, 16);

/** Builds (or reuses) the synthetic repository and returns its directory. Git-initialised and committed. */
export async function ensureSynthetic(spec: SyntheticSpec, log: (line: string) => void = () => undefined): Promise<string> {
  const dir = directory(spec);
  const marker = markerFile(spec);
  const expected = fingerprint(spec);
  if (existsSync(marker) && (await readFile(marker, 'utf8')).trim() === expected) return dir;
  await makeWritable(dir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await withHeavy(async () => {
    const perDir = spec.kind === 'tiny' ? 500 : 40;
    const concurrency = 32;
    for (let start = 0; start < spec.files; start += concurrency) {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, spec.files - start) }, async (_, offset) => {
          const index = start + offset;
          const shard = Math.floor(index / perDir);
          const folder = join(dir, spec.kind === 'tiny' ? `m${String(shard).padStart(4, '0')}` : `pkg${String(Math.floor(shard / 50)).padStart(3, '0')}/mod${String(shard % 50).padStart(2, '0')}`);
          if (index % perDir === 0) await mkdir(folder, { recursive: true });
          if (spec.kind === 'tiny') await writeFile(join(folder, `f${index}.txt`), `value ${index} token${index % 997}\n`);
          else {
            const ext = EXTENSIONS[index % EXTENSIONS.length];
            // One independent stream per file: content never depends on write order.
            await writeFile(join(folder, `f${index}.${ext}`), sourceFile(Rng.from('synthetic', spec.seed ?? 'rsq', index), ext, index));
          }
        }),
      );
      if ((start / concurrency) % 500 === 0) log(`synthetic ${spec.kind}: ${start}/${spec.files} files`);
    }
    await gitInit(dir);
  });
  await writeFile(marker, `${expected}\n`);
  return dir;
}

export async function removeSynthetic(spec: SyntheticSpec): Promise<void> {
  const dir = directory(spec);
  await makeWritable(dir);
  await rm(dir, { recursive: true, force: true });
  await rm(markerFile(spec), { force: true });
}
