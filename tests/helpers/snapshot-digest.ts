// Child process for the persistence tests: indexes one repository and prints a digest of everything that is observable.
// Usage: node --import tsx tests/helpers/snapshot-digest.ts <repo root> <query>
import { createHash } from 'node:crypto';
import { Repository } from '../../src/repository.js';
import { contextPackV2 } from '../../src/v2.js';

export async function digest(root: string, query: string) {
  const snapshot = await new Repository(root).snapshot(query);
  const hash = createHash('sha256');
  for (const chunk of snapshot.chunks) hash.update(`${chunk.id}|${chunk.start}|${chunk.end}|${chunk.name}|${chunk.terms.join(',')}|${chunk.text}\n`);
  const pack = contextPackV2(snapshot, query, 2000);
  return {
    revision: snapshot.revision,
    files: snapshot.files.length,
    chunks: snapshot.chunks.length,
    chunkDigest: hash.digest('hex'),
    packDigest: createHash('sha256').update(pack.text).digest('hex'),
    inputTokens: pack.stats.inputTokens,
    diagnostics: snapshot.diagnostics ?? [],
  };
}

if (process.argv[1]?.endsWith('snapshot-digest.ts')) {
  const [root, query] = process.argv.slice(2);
  console.log(JSON.stringify(await digest(root, query)));
}
