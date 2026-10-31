import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT } from './paths.js';

/**
 * Courtesy throttle for the shared lab machine: a cross-process cap on concurrently running heavy
 * processes plus a back-off while the 1-minute load average is high. It is off until a CLI calls
 * configureThrottle(), so unit tests never wait on it.
 */
export interface ThrottleConfig {
  /** Maximum heavy child processes across all harness processes (slot directories on disk). */
  maxProcs: number;
  /** Sleep while the 1-minute load average is above this. */
  maxLoad: number;
  /** Stop waiting for the load to fall after this long and continue (single slot only). */
  maxWaitMs: number;
  slotDir: string;
  log?: (line: string) => void;
}

let config: ThrottleConfig | undefined;
let degraded = false;

export function configureThrottle(partial: Partial<ThrottleConfig> = {}): ThrottleConfig {
  config = { maxProcs: 2, maxLoad: 40, maxWaitMs: 10 * 60_000, slotDir: join(SCRATCH_ROOT, 'slots'), ...partial };
  degraded = false;
  return config;
}

export function throttleConfig(): ThrottleConfig | undefined {
  return config;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface LoadWait {
  waitedMs: number;
  load1: number;
  gaveUp: boolean;
}

/** Sleeps in 15 s steps until the 1-minute load average is at most maxLoad, or maxWaitMs has passed. */
export async function waitForLoad(maxLoad: number, maxWaitMs: number, log?: (line: string) => void, read: () => number = () => loadavg()[0]): Promise<LoadWait> {
  const started = Date.now();
  let load1 = read();
  let announced = false;
  while (load1 > maxLoad) {
    if (Date.now() - started >= maxWaitMs) return { waitedMs: Date.now() - started, load1, gaveUp: true };
    if (!announced) {
      log?.(`load ${load1.toFixed(0)} > ${maxLoad}: backing off`);
      announced = true;
    }
    await sleep(Math.min(15_000, Math.max(10, maxWaitMs - (Date.now() - started))));
    load1 = read();
  }
  return { waitedMs: Date.now() - started, load1, gaveUp: false };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function tryTake(dir: string): Promise<boolean> {
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = Number(await readFile(join(dir, 'pid'), 'utf8').catch(() => ''));
    // A slot whose owner died (kill -9, crash) is reclaimed.
    if (owner && alive(owner)) return false;
    await rm(dir, { recursive: true, force: true });
    try {
      await mkdir(dir);
    } catch {
      return false;
    }
  }
  await writeFile(join(dir, 'pid'), String(process.pid));
  return true;
}

/** Blocks until a slot is free; returns the release function. */
export async function acquireSlot(slotDir: string, maxProcs: number): Promise<() => Promise<void>> {
  await mkdir(slotDir, { recursive: true });
  for (;;) {
    for (let i = 0; i < maxProcs; i++) {
      const dir = join(slotDir, `slot${i}`);
      if (await tryTake(dir)) return () => rm(dir, { recursive: true, force: true });
    }
    await sleep(250);
  }
}

/**
 * Gate for one heavy child process. Returns a release function (a no-op while the throttle is not
 * configured). When the load never falls, the suite degrades to a single slot instead of stalling forever.
 */
export async function enterHeavy(options: { slot?: boolean } = {}): Promise<() => Promise<void>> {
  if (!config) return async () => undefined;
  if (loadavg()[0] <= config.maxLoad) degraded = false;
  const wait = await waitForLoad(config.maxLoad, degraded ? 0 : config.maxWaitMs, config.log);
  if (wait.gaveUp && !degraded) {
    degraded = true;
    config.log?.(`load still ${wait.load1.toFixed(0)} after ${(wait.waitedMs / 60000).toFixed(0)} min: continuing with one process at a time`);
  }
  if (options.slot === false) return async () => undefined;
  return acquireSlot(config.slotDir, degraded ? 1 : config.maxProcs);
}

/** Runs `fn` while holding a heavy slot (used for clones and large fixture builds). */
export async function withHeavy<T>(fn: () => Promise<T>): Promise<T> {
  const release = await enterHeavy();
  try {
    return await fn();
  } finally {
    await release();
  }
}
