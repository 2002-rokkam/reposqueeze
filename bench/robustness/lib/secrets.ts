/**
 * Secret detection helpers for the robustness suite.
 *
 * The rules are intentionally independent of RepoSqueeze's own filters (they are broader, in the
 * style of gitleaks) so that gaps in the variant under test show up as findings. Every pattern uses
 * bounded quantifiers only; the unit tests feed megabyte-sized near-miss strings to prove linear time.
 */

export interface SecretRule {
  id: string;
  description: string;
  regex: RegExp;
}

const rule = (id: string, description: string, source: string, flags = 'g'): SecretRule => ({
  id,
  description,
  regex: new RegExp(source, flags),
});

export const SECRET_RULES: readonly SecretRule[] = [
  rule('aws-access-key-id', 'AWS access key id', '\\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b'),
  rule(
    'aws-secret-access-key',
    'AWS secret access key assignment',
    '\\baws[_\\-. ]?(?:secret[_\\-. ]?)?(?:access[_\\-. ]?)?(?:secret[_\\-. ]?)?key["\']?\\s{0,3}[:=]\\s{0,3}["\']?[A-Za-z0-9/+=]{40}\\b',
    'gi',
  ),
  rule('github-token', 'GitHub token', '\\bgh[pousr]_[A-Za-z0-9]{30,255}\\b'),
  rule('github-fine-grained-pat', 'GitHub fine-grained token', '\\bgithub_pat_[A-Za-z0-9_]{30,255}\\b'),
  rule('private-key-block', 'PEM/PGP private key block', '-----BEGIN (?:[A-Z0-9]{2,10} ){0,3}PRIVATE KEY(?: BLOCK)?-----'),
  rule('jwt', 'JSON Web Token', '\\bey[A-Za-z0-9_-]{10,500}\\.ey[A-Za-z0-9_-]{10,2000}\\.[A-Za-z0-9_-]{10,500}'),
  rule('slack-token', 'Slack token', '\\bxox[abposr]-[A-Za-z0-9-]{10,200}'),
  rule('stripe-key', 'Stripe secret/restricted key', '\\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,100}\\b'),
  rule('google-api-key', 'Google API key', '\\bAIza[0-9A-Za-z_-]{35}\\b'),
  rule('openai-key', 'OpenAI-style secret key', '\\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,200}\\b'),
  rule('anthropic-key', 'Anthropic API key', '\\bsk-ant-[A-Za-z0-9_-]{32,200}\\b'),
  rule('sendgrid-key', 'SendGrid API key', '\\bSG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}\\b'),
  rule('npm-token', 'npm access token', '\\bnpm_[A-Za-z0-9]{36}\\b'),
  rule('npmrc-auth-token', '.npmrc auth token', '_authToken\\s{0,3}=\\s{0,3}[^\\s]{8,200}', 'g'),
  rule(
    'db-url-password',
    'Connection URL with an embedded password',
    '\\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqps?|mssql|sqlserver)://[^\\s:@/]{0,100}:[^\\s@/]{3,200}@[^\\s/]{1,200}',
    'gi',
  ),
  rule('basic-auth-url', 'URL with basic-auth credentials', '\\bhttps?://[^\\s:@/]{1,100}:[^\\s@/]{3,200}@[^\\s/]{1,200}'),
  rule('azure-storage-key', 'Azure storage account key', 'AccountKey=[A-Za-z0-9+/=]{60,120}'),
  rule('bearer-header', 'Authorization bearer token', 'authorization["\']?\\s{0,3}[:=]\\s{0,3}["\']?bearer\\s{1,5}[A-Za-z0-9._~+/-]{20,500}', 'gi'),
  rule(
    'generic-secret-assignment',
    'Hard-coded password/secret/token assignment',
    '\\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\\b["\']?\\s{0,3}[:=]\\s{0,3}["\']([^"\'\\s]{8,200})["\']',
    'gi',
  ),
];

export interface SecretHit {
  rule: string;
  /** One-based line within the scanned text. */
  line: number;
  /** The matched text, truncated to 120 characters. */
  match: string;
  /** The enclosing line, truncated to 200 characters. */
  context: string;
}

/** Offsets of the start of every line, for O(log n) offset-to-line lookups. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function scanSecrets(text: string, rules: readonly SecretRule[] = SECRET_RULES): SecretHit[] {
  const starts = lineStarts(text);
  const hits: SecretHit[] = [];
  const seen = new Set<string>();
  for (const { id, regex } of rules) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const offset = match.index ?? 0;
      const line = lineOf(starts, offset);
      const key = `${id}:${offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lineStart = starts[line - 1];
      const lineEnd = starts[line] === undefined ? text.length : starts[line] - 1;
      hits.push({
        rule: id,
        line,
        match: match[0].slice(0, 120),
        context: text.slice(lineStart, Math.min(lineEnd, lineStart + 200)),
      });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const PLACEHOLDER =
  /example|sample|dummy|fake|placeholder|changeme|change[-_ ]me|your[-_ ]?(?:key|token|secret|password)|insert|redacted|xxxx|0000|1234|abcd|<[^>\s]{2,40}>|\$\{|\{\{|%\(|%s|\*{4,}|\.{4,}|todo/i;
const TEST_PATH = /(^|\/)(?:tests?|testdata|fixtures?|spec|specs|examples?|samples?|docs?|__tests__|mocks?|e2e)(\/|$)|\.(?:test|spec)\./i;

export interface HitClassification {
  kind: 'placeholder' | 'test-fixture' | 'needs-review';
  why: string;
}

/**
 * First-pass triage of a hit found in tool output. `needs-review` hits are reviewed by a human; the
 * report never presents the automatic label as ground truth.
 */
export function classifyHit(hit: SecretHit, sourcePath?: string): HitClassification {
  const body = hit.match.replace(/^[^=:]*[=:]\s*/, '');
  if (PLACEHOLDER.test(hit.match) || PLACEHOLDER.test(hit.context)) return { kind: 'placeholder', why: 'placeholder wording or template syntax' };
  if (hit.rule === 'private-key-block') {
    return sourcePath && TEST_PATH.test(sourcePath)
      ? { kind: 'test-fixture', why: 'key block inside a test/fixture/docs path' }
      : { kind: 'needs-review', why: 'private key header' };
  }
  if (hit.rule === 'jwt' && /eyJzdWIiOiIxMjM0NTY3ODkwIiwi/.test(hit.match)) return { kind: 'placeholder', why: 'jwt.io sample token' };
  if (shannonEntropy(body) < 2.6 && hit.rule !== 'db-url-password') return { kind: 'placeholder', why: 'low-entropy value' };
  if (sourcePath && TEST_PATH.test(sourcePath)) return { kind: 'test-fixture', why: 'inside a test/fixture/docs path' };
  return { kind: 'needs-review', why: 'high-entropy value outside test paths' };
}

/** Files whose *names* announce secrets. Broader than RepoSqueeze's own list on purpose. */
export const SECRET_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)[^/]*\.env$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc)$/i,
  /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pem)?$/i,
  /(^|\/)(?:credentials|secrets?)(?:\.[^/]*)?$/i,
  /(^|\/)\.(?:npmrc|pypirc|netrc|git-credentials|htpasswd|dockercfg)$/i,
  /(^|\/)(?:service[-_]?account)[^/]*\.json$/i,
  /\.tfstate(?:\.backup)?$/i,
];

export function isSecretPath(path: string): boolean {
  return SECRET_PATH_PATTERNS.some(pattern => pattern.test(path));
}

/**
 * Lines of a secret-named file that are distinctive enough to prove a leak when found verbatim
 * in tool output (short or purely structural lines such as "}" are ignored).
 */
export function distinctiveLines(content: string, limit = 2000): string[] {
  const out = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 16 || line.length > 400) continue;
    if (!/[A-Za-z0-9]{8,}/.test(line)) continue;
    if (/^(?:#|\/\/|\*|--)\s*[A-Za-z ,.'-]+$/.test(line)) continue;
    out.add(line);
    if (out.size >= limit) break;
  }
  return [...out];
}

/** Lines of `lines` that occur verbatim in `output` (one pass over the output's lines plus substring checks for long ones). */
export function findLeakedLines(output: string, lines: readonly string[]): string[] {
  if (!lines.length || !output) return [];
  const outputLines = new Set(output.split(/\r?\n/).map(line => line.trim()));
  return lines.filter(line => outputLines.has(line) || (line.length >= 40 && output.includes(line)));
}
