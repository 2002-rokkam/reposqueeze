import type { CliRun } from '../lib/cli.js';
import { describeRun, fail, type Verdict } from './types.js';

/** Small benign repository content that carries one rare token ("limitsanchorcontrol"). */
export const CONTROL: Record<string, string> = {
  'README.md': '# Fixture\n',
  'src/control.py': 'def limitsanchorcontrol():\n    return "control"\n',
};
export const CONTROL_ANCHOR = 'limitsanchorcontrol';

export const rssGiB = (run: CliRun): number => (run.rssBytes ?? 0) / 1024 ** 3;

/** A hang, crash, memory blow-up or spawn failure is a failure whatever the scenario. */
export function processVerdict(runs: [string, CliRun][], maxRssGiB: number): Verdict | undefined {
  for (const [label, run] of runs) {
    if (run.outcome === 'timeout') return fail(`${label} hung: ${describeRun(run)}`);
    if (run.outcome === 'crash' || run.outcome === 'memory-limit' || run.outcome === 'overflow' || run.outcome === 'spawn-error') return fail(`${label} ${describeRun(run)}`);
    if (rssGiB(run) > maxRssGiB) return fail(`${label} used ${rssGiB(run).toFixed(1)} GiB resident`);
  }
  return undefined;
}

/** Wall/CPU/RSS/load summary for notes. */
export function runStats(run: CliRun): string {
  const cpu = (run.userSec ?? 0) + (run.sysSec ?? 0);
  return `${(run.wallMs / 1000).toFixed(1)}s wall, ${cpu.toFixed(1)}s cpu, ${rssGiB(run).toFixed(2)} GiB, load ${run.load1.toFixed(0)}`;
}
