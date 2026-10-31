// Child process for the concurrency tests: hammers one cache directory with atomic writes and validating reads.
// Usage: node --import tsx tests/helpers/hammer-store.ts <repo root> <writer id> <iterations>
import { CacheStore, decodeContainer, encodeContainer } from '../../src/store.js';

const [root, id, iterationsArgument] = process.argv.slice(2);
const iterations = Number(iterationsArgument);
const store = new CacheStore(root);
let writes = 0, reads = 0;

for (let i = 0; i < iterations; i++) {
  const payload = Uint32Array.from({ length: 20000 }, (_, k) => (Math.imul(k, 2654435761) + Number(id) * 97 + i) >>> 0);
  const sum = payload.reduce((a, b) => (a + b) >>> 0, 0);
  if (await store.write('hammer.bin', encodeContainer('HAMMERTS', { id, i, sum }, [{ name: 'p', data: payload }]))) writes++;
  const file = await store.read('hammer.bin');
  if (!file) continue;
  // A reader must see a complete file written by exactly one writer, never a mixture.
  const container = decodeContainer(file, 'HAMMERTS');
  const header = container.header as { sum: number };
  const check = container.array('p', Uint32Array).reduce((a, b) => (a + b) >>> 0, 0);
  if (check !== header.sum) throw new Error(`torn read in writer ${id} iteration ${i}`);
  reads++;
}
console.log(JSON.stringify({ id, writes, reads }));
