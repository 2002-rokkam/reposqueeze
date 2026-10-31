import { loadavg } from 'node:os';

export interface LoadGuardOptions {
  /** Block while the one-minute load average is above this value (0 disables the guard). */
  maxLoad: number;
  pollMs?: number;
  /** Log at most once per this many ms while waiting. */
  logEveryMs?: number;
  log?: (message: string) => void;
  /** Stop waiting early (for example after an interrupt). */
  shouldStop?: () => boolean;
  /** Injectable for tests. */
  readLoad?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The benchmark shares its machine with other agents. Before starting heavy work (a clone, a
 * checkout, a query in a worker) it backs off until the machine is calmer. Returns seconds waited.
 */
export async function waitForLoad(options: LoadGuardOptions): Promise<number> {
  if (!(options.maxLoad > 0)) return 0;
  const read = options.readLoad ?? (() => loadavg()[0]);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const poll = options.pollMs ?? 15_000;
  const logEvery = options.logEveryMs ?? 120_000;
  let waited = 0;
  let sinceLog = logEvery; // log on the first wait
  for (let load = read(); load > options.maxLoad; load = read()) {
    if (options.shouldStop?.()) break;
    if (sinceLog >= logEvery) {
      options.log?.(`machine load ${load.toFixed(0)} > ${options.maxLoad}: backing off (waited ${Math.round(waited / 1000)} s so far)`);
      sinceLog = 0;
    }
    await sleep(poll);
    waited += poll;
    sinceLog += poll;
  }
  return waited / 1000;
}
