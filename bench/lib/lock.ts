import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockOptions {
  /** A lock older than this is considered abandoned even if its pid is alive. */
  staleMs?: number;
  waitMs?: number;
  pollMs?: number;
}

/**
 * Cross-process mutex on a directory (mkdir is atomic). The owner pid is stored so crashed
 * runners never leave a permanent lock behind.
 */
export async function withLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? 6 * 3600_000;
  const deadline = Date.now() + (options.waitMs ?? 3 * 3600_000);
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      await mkdir(path);
      await writeFile(`${path}/owner`, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let abandoned = false;
      try {
        const pid = Number((await readFile(`${path}/owner`, 'utf8')).trim());
        const age = Date.now() - (await stat(path)).mtimeMs;
        abandoned = !pidAlive(pid) || age > staleMs;
      } catch {
        abandoned = Date.now() - (await stat(path).then(s => s.mtimeMs, () => 0)) > 30_000;
      }
      if (abandoned) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${path}`);
      await sleep(options.pollMs ?? 500);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
