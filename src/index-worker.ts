// Worker-thread entry: indexes one file per message. Bundled separately (dist/index-worker.cjs) by scripts/build.mjs.
import { parentPort } from 'node:worker_threads';
import { indexFile, type FileIndexResult } from './file-indexer.js';

export interface WorkerRequest { id: number; path: string; text: string }
export type WorkerResponse = { id: number; result: FileIndexResult } | { id: number; error: string };

/** Typed-array buffers of a result, handed to the main thread without copying. */
function transferList(result: FileIndexResult): ArrayBuffer[] {
  const arrays = [result.starts, result.ends, result.chunkLen, result.rowStart, result.rowTerm, result.rowTf, result.nameStart, result.nameTerm, result.pathTerm, result.refStart, result.refIds];
  return [...new Set(arrays.map(array => array.buffer as ArrayBuffer))];
}

if (parentPort) {
  const port = parentPort;
  port.on('message', async (request: WorkerRequest) => {
    try {
      const result = await indexFile(request.path, request.text);
      port.postMessage({ id: request.id, result } satisfies WorkerResponse, transferList(result));
    } catch (error) {
      port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
    }
  });
}
