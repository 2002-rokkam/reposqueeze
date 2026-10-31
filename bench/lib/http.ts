import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isTlsError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return !!cause?.code && TLS_ERROR_CODES.has(cause.code);
}

async function viaCurl(url: string, timeoutMs: number): Promise<string> {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const { stdout } = await execFileAsync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', String(seconds), url], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

/**
 * GET a URL as text. Uses fetch first; when the machine sits behind a TLS-intercepting
 * proxy whose root CA only lives in the system keychain (Node does not trust it by
 * default) it transparently falls back to curl. `RSQ_BENCH_HTTP=curl|fetch` forces a mode.
 */
export async function httpGetText(url: string, options: HttpOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const retries = options.retries ?? 4;
  const forced = process.env.RSQ_BENCH_HTTP;
  let useCurl = forced === 'curl';
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (useCurl) return await viaCurl(url, timeoutMs);
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status} for ${url}`);
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} for ${url}`), { fatal: true });
      return await response.text();
    } catch (error) {
      lastError = error;
      if ((error as { fatal?: boolean }).fatal) break;
      if (!useCurl && forced !== 'fetch' && isTlsError(error)) {
        useCurl = true;
        attempt--; // switching transport does not consume a retry
        continue;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`GET ${url} failed: ${(lastError as Error)?.message ?? lastError}`);
}

export async function httpGetJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
  return JSON.parse(await httpGetText(url, options)) as T;
}
