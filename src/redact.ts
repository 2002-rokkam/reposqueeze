/**
 * Secret redaction for text that is about to be shown to a model.
 *
 * Design constraints:
 *  - Only the secret *value* is replaced, by `[REDACTED:<rule>]`, on the same line. The number of
 *    lines never changes (a multi-line PEM body becomes one placeholder line per original line),
 *    and line terminators (LF / CRLF) are preserved byte for byte.
 *  - Linear time: every pattern uses bounded quantifiers on character classes and no nested
 *    quantifiers, so adversarial input cannot trigger catastrophic backtracking.
 *  - Deterministic and offline. Heuristic (generic keyword) matches are gated by entropy,
 *    character-class diversity and a placeholder allow-list to keep false positives low.
 */

export interface RedactFinding {
  rule: string;
  /** One-based line of the first redacted character. */
  line: number;
  /** Offsets (UTF-16 code units) into the ORIGINAL text; `end` is exclusive. */
  start: number;
  end: number;
}

export interface RedactOptions {
  /** Repository-relative path; tunes heuristics (strict inside secret files, lenient in lockfiles). */
  path?: string;
  /** Caps the number of reported findings. Redaction itself is always complete. */
  maxFindings?: number;
}

export interface RedactResult {
  text: string;
  findings: RedactFinding[];
}

type Profile = 'normal' | 'strict' | 'lockfile';

interface Edit {
  rule: string;
  start: number;
  end: number;
  replacement: string;
  multiline?: boolean;
}

interface Rule {
  name: string;
  /** Must carry the `g` and `d` flags. */
  pattern: RegExp;
  /** Capture groups holding the secret value; the first one that participated is used. */
  groups?: number[];
  accept?: (value: string, profile: Profile, following: string) => boolean;
  /** Cheap superset of `pattern` used by mayContainSecrets(). */
  anchor: string;
  ignoreCase?: boolean;
  skipInLockfiles?: boolean;
}

export const placeholder = (rule: string): string => `[REDACTED:${rule}]`;

/* ---------------------------------------------------------------- value heuristics */

export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const total = [...value].length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PLACEHOLDER_WORDS =
  /your[-_ ]?|<|>|\$\{|\$\(|\{\{|\}\}|%\(|%s|%\{|process\.env|os\.environ|getenv|changeme|change[-_]me|example|sample|dummy|placeholder|x{6,}|\*{4,}|\.{4,}|redacted|todo|fixme|replace[-_ ]?me|insert[-_ ]|my[-_]?(?:secret|token|pass(?:word)?|key)|fake|not[-_ ]?a[-_ ]?real/i;
const DEFAULT_PASSWORDS = new Set([
  'password', 'pass', 'passwd', 'pwd', 'secret', 'postgres', 'root', 'admin', 'test', 'guest', 'user',
  'username', 'mysql', 'redis', 'changeme', 'example', 'default', 'null', 'none', 'true', 'false',
  'undefined', 'string', 'token', 'secretkey', 'letmein', 'hunter2', '123456', '1234', '12345678',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER_WORDS.test(value)) return true;
  if (DEFAULT_PASSWORDS.has(value.toLowerCase())) return true;
  return new Set(value).size <= 3;
}

/** Random-looking: mixes digits with letters, or symbols with both letter cases. */
function looksRandom(value: string): boolean {
  const hasDigit = /\d/.test(value);
  const hasAlpha = /[A-Za-z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasSymbol = /[!@#$%^&*()+=~|?[\]{}]/.test(value);
  return (hasDigit && hasAlpha) || (hasSymbol && hasLower && hasUpper);
}

function looksLikeIdentifierOrPath(value: string): boolean {
  return (
    value.includes('://') ||
    /^(?:\.{0,2}\/|~\/)/.test(value) ||
    /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)+$/.test(value) ||
    /^v?\d+(?:\.\d+)+/.test(value) ||
    /^sha\d+-/.test(value) ||
    UUID.test(value) ||
    /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value) ||
    /^[a-z]{2,}\d{0,2}(?:[A-Z][a-z]{2,}\d{0,2})+$/.test(value) ||
    /^(?:[A-Z][a-z]{2,}\d{0,2}){3,}$/.test(value) ||
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value) ||
    /^[a-z]+(?:_[a-z0-9]+)+$/.test(value) ||
    /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(value)
  );
}

const PASSWORD_HASH = /^(?:\{[a-z0-9]+\})?\$(?:2[abxy]|argon2\w*|pbkdf2\w*|[156])\$/i;

function acceptGeneric(value: string, profile: Profile, following = ''): boolean {
  if (profile === 'lockfile') return false;
  // An unquoted value that continues as an expression (`token = client.getToken()`) is code, not a literal.
  if (/[.([:]/.test(following) || PASSWORD_HASH.test(value) || /^\{.*\}$/.test(value)) return false;
  const strict = profile === 'strict';
  if (value.length < (strict ? 8 : 16) || /\s/.test(value)) return false;
  if (isPlaceholder(value) || shannonEntropy(value) < (strict ? 2.5 : 3.0)) return false;
  if (looksLikeIdentifierOrPath(value)) return false;
  return strict || looksRandom(value);
}

const acceptToken = (min = 0) => (value: string): boolean =>
  value.length >= min && new Set(value).size > 6 && !/EXAMPLE$/.test(value);

function acceptHeaderCredential(value: string): boolean {
  return (
    value.length >= 12 &&
    shannonEntropy(value) >= 3.0 &&
    !isPlaceholder(value) &&
    (/\d/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)))
  );
}

function acceptPassword(value: string): boolean {
  return value.length >= 4 && !/^\d+$/.test(value) && !/^[$%{]/.test(value) && !isPlaceholder(value);
}

function acceptEntropy(min: number, length = 0) {
  return (value: string): boolean =>
    value.length >= length && shannonEntropy(value) >= min && !isPlaceholder(value);
}

/* ---------------------------------------------------------------- rule table */

const KEYWORDS =
  '(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|access[_-]?key|auth[_-]?key|signing[_-]?key|encryption[_-]?key|credential)';

// Order matters: earlier rules win when matches overlap.
const RULES: Rule[] = [
  {
    name: 'github-token',
    pattern: /(?<![A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/dg,
    groups: [1],
    accept: acceptToken(),
    anchor: 'gh[pousr]_|github_pat_',
  },
  {
    name: 'gitlab-token',
    pattern: /(?<![A-Za-z0-9_-])(glpat-[A-Za-z0-9_-]{20,100})/dg,
    groups: [1],
    accept: acceptToken(),
    anchor: 'glpat-',
  },
  {
    name: 'slack-token',
    pattern: /(?<![A-Za-z0-9])(xox[abposre]-[A-Za-z0-9-]{10,200}|xapp-\d-[A-Za-z0-9]{6,}-\d{6,}-[a-f0-9]{20,})/dg,
    groups: [1],
    accept: acceptToken(),
    anchor: 'xox[abposre]-|xapp-',
  },
  {
    name: 'slack-webhook',
    pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/([A-Za-z0-9]{20,})/dg,
    groups: [1],
    anchor: 'hooks\\.slack\\.com',
  },
  {
    name: 'stripe-key',
    pattern: /(?<![A-Za-z0-9_])((?:sk|rk)_live_[A-Za-z0-9]{16,200})/dg,
    groups: [1],
    accept: acceptToken(),
    anchor: '(?:sk|rk)_live_',
  },
  {
    name: 'google-api-key',
    pattern: /(?<![A-Za-z0-9_-])(AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/dg,
    groups: [1],
    accept: acceptToken(),
    anchor: 'AIza',
  },
  {
    name: 'anthropic-key',
    pattern: /(?<![A-Za-z0-9_-])(sk-ant-[A-Za-z0-9_-]{20,300})/dg,
    groups: [1],
    accept: acceptToken(),
    anchor: 'sk-',
  },
  {
    name: 'openai-key',
    pattern: /(?<![A-Za-z0-9_-])(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,300})/dg,
    groups: [1],
    // Real keys mix digits and both letter cases; this rejects slugs such as "sk-learn-style-names".
    accept: (v) => /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v) && shannonEntropy(v) >= 3.2,
    anchor: 'sk-',
  },
  {
    name: 'huggingface-token',
    pattern: /(?<![A-Za-z0-9_])(hf_[A-Za-z0-9]{34,100})/dg,
    groups: [1],
    accept: acceptEntropy(3.0),
    anchor: 'hf_',
  },
  {
    name: 'npm-token',
    pattern: /(?<![A-Za-z0-9_])(npm_[A-Za-z0-9]{36})(?![A-Za-z0-9])/dg,
    groups: [1],
    accept: acceptEntropy(3.0),
    anchor: 'npm_',
  },
  {
    name: 'pypi-token',
    pattern: /(?<![A-Za-z0-9_-])(pypi-[A-Za-z0-9_-]{50,300})/dg,
    groups: [1],
    accept: acceptEntropy(3.0),
    anchor: 'pypi-',
  },
  {
    name: 'sendgrid-key',
    pattern: /(?<![A-Za-z0-9_.-])(SG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{30,50})/dg,
    groups: [1],
    accept: acceptEntropy(3.0),
    anchor: 'SG\\.',
  },
  {
    name: 'twilio-key',
    pattern: /(?<![A-Za-z0-9])(SK[0-9a-f]{32})(?![A-Za-z0-9])/dg,
    groups: [1],
    accept: acceptToken(),
    anchor: 'SK[0-9a-f]{32}',
  },
  {
    name: 'twilio-token',
    pattern: /twilio[\w.-]{0,30}(?:token|secret|auth)[\w.-]{0,20}["']?[ \t]*[:=][ \t]*["']?([0-9a-f]{32})(?![0-9a-f])/dgi,
    groups: [1],
    accept: acceptToken(),
    anchor: 'twilio',
    ignoreCase: true,
  },
  {
    name: 'aws-access-key',
    pattern: /(?<![A-Za-z0-9])((?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})(?![A-Za-z0-9])/dg,
    groups: [1],
    accept: acceptToken(),
    anchor: 'AKIA|ASIA|ABIA|ACCA',
  },
  {
    name: 'aws-secret-key',
    pattern: /aws[\w.-]{0,30}secret[\w.-]{0,30}["']?[ \t]*(?::=|=>|[:=])[ \t]*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/dgi,
    groups: [1],
    accept: acceptEntropy(3.3),
    anchor: 'aws',
    ignoreCase: true,
  },
  {
    name: 'jwt',
    pattern: /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/dg,
    groups: [1],
    anchor: 'eyJ',
  },
  {
    name: 'url-credentials',
    pattern: /:\/\/([^\s:/@"'<>]{1,64}):([^\s@/"'<>]{3,128})@/dg,
    groups: [2],
    accept: acceptPassword,
    anchor: ':\\/\\/[^\\s:/@"\'<>]{1,64}:[^\\s@/"\'<>]{3,128}@',
  },
  {
    name: 'connection-password',
    pattern: /(?:Server|Data Source|Host|User ?Id|Uid|Database)=[^\r\n]{0,200}?;[ \t]*(?:Password|Pwd)=([^;"'\r\n]{3,128})/dgi,
    groups: [1],
    accept: acceptPassword,
    anchor: '(?:password|pwd)',
    ignoreCase: true,
  },
  {
    name: 'connection-password',
    pattern: /jdbc:[a-z0-9:]{1,30}\/\/[^\s"']{0,200}?[?&;](?:password|pwd)=([^&;\s"']{3,128})/dgi,
    groups: [1],
    accept: acceptPassword,
    anchor: '(?:password|pwd)',
    ignoreCase: true,
  },
  {
    name: 'auth-header',
    pattern: /authorization["']?[ \t]*[:=][ \t]*["'`]?(?:bearer|basic|token)[ \t]+([A-Za-z0-9._~+/=-]{12,2048})/dgi,
    groups: [1],
    accept: acceptHeaderCredential,
    anchor: 'authorization',
    ignoreCase: true,
  },
  {
    name: 'azure-key',
    pattern: /(?:AccountKey|SharedAccessKey|PrimaryKey|SecondaryKey)[ \t]*=[ \t]*([A-Za-z0-9+/]{20,200}={0,2})/dg,
    groups: [1],
    accept: acceptEntropy(3.0),
    anchor: 'AccountKey|SharedAccessKey|PrimaryKey|SecondaryKey',
  },
  {
    name: 'xml-secret',
    pattern: new RegExp(`<[A-Za-z0-9_.-]{0,30}${KEYWORDS}[A-Za-z0-9_.-]{0,20}>([^<\\s]{8,256})</`, 'dgi'),
    groups: [1],
    accept: acceptGeneric,
    anchor: KEYWORDS,
    ignoreCase: true,
    skipInLockfiles: true,
  },
  {
    name: 'generic-secret',
    pattern: new RegExp(
      `${KEYWORDS}[A-Za-z0-9_-]{0,20}(?:\\\\?["'])?[ \\t]*(?::=|=>|==?|:)[ \\t]*` +
        `(?:\\\\?(["'\`])([^"'\`\\\\\\r\\n]{8,256})\\\\?\\1|([A-Za-z0-9_+/=~!@#$%^*-]{8,4096}))`,
      'dgi',
    ),
    groups: [2, 3],
    accept: acceptGeneric,
    anchor: KEYWORDS,
    ignoreCase: true,
    skipInLockfiles: true,
  },
];

const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|gradle\.lockfile)$|\.lock$/;

const HINT_SENSITIVE = new RegExp(
  ['-----BEGIN', ...RULES.filter((r) => !r.ignoreCase).map((r) => r.anchor)].join('|'),
);
const HINT_INSENSITIVE = new RegExp(
  [...RULES.filter((r) => r.ignoreCase).map((r) => r.anchor)].join('|'),
  'i',
);

/** Cheap pre-filter: false guarantees redactSecrets() would find nothing. */
export function mayContainSecrets(text: string): boolean {
  return HINT_SENSITIVE.test(text) || HINT_INSENSITIVE.test(text);
}

/* ---------------------------------------------------------------- PEM blocks */

const PEM_HEADER = /-----BEGIN [A-Z0-9 ]{0,30}?PRIVATE KEY(?: BLOCK)?-----/y;
const PEM_INLINE_BODY = /(?:\\[nr]|[ \t])*((?:[A-Za-z0-9+/=]|\\[nr]){40,})/y;
const PEM_BODY_LINE = /^(?:[A-Za-z0-9+/=]*|[A-Za-z0-9-]{1,40}:[^\r\n]{0,200})$/;
const PEM_MAX_BODY_LINES = 200;
const PEM_MAX_LINE = 2000;

function pemEdits(text: string): Edit[] {
  const edits: Edit[] = [];
  const mark = placeholder('pem-private-key');
  let from = 0;
  let newlineCache = -2;
  // Reusing the last result keeps this linear when headers repeat on a single long line.
  const nextNewline = (position: number): number => {
    if (newlineCache === -1 || newlineCache >= position) return newlineCache;
    newlineCache = text.indexOf('\n', position);
    return newlineCache;
  };
  for (;;) {
    const at = text.indexOf('-----BEGIN ', from);
    if (at < 0) break;
    from = at + 11;
    PEM_HEADER.lastIndex = at;
    const header = PEM_HEADER.exec(text);
    if (!header) continue;
    const headerEnd = at + header[0].length;
    from = headerEnd;

    const nl = nextNewline(headerEnd);
    const lineEnd = nl < 0 ? text.length : nl;
    const restOfLine = text.slice(headerEnd, Math.min(lineEnd, headerEnd + 4));
    if (restOfLine !== '' && restOfLine !== '\r') {
      // Key flattened onto one line (JSON string with escaped newlines, inline literal).
      PEM_INLINE_BODY.lastIndex = headerEnd;
      const inline = PEM_INLINE_BODY.exec(text);
      if (inline) {
        const start = headerEnd + inline[0].length - inline[1].length;
        edits.push({ rule: 'pem-private-key', start, end: start + inline[1].length, replacement: mark });
        from = start + inline[1].length;
      }
      continue;
    }

    // Multi-line block: redact each body line independently so the line count is preserved.
    const lines: Array<{ start: number; end: number; eol: string }> = [];
    let pos = nl < 0 ? text.length : nl + 1;
    let sawKeyMaterial = false;
    while (pos < text.length && lines.length < PEM_MAX_BODY_LINES) {
      const next = text.indexOf('\n', pos);
      const rawEnd = next < 0 ? text.length : next;
      const end = rawEnd > pos && text.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
      if (end - pos > PEM_MAX_LINE || !PEM_BODY_LINE.test(text.slice(pos, end))) break;
      if (end - pos >= 16 && !text.slice(pos, end).includes(':')) sawKeyMaterial = true;
      lines.push({ start: pos, end, eol: text.slice(end, next < 0 ? text.length : next + 1) });
      pos = next < 0 ? text.length : next + 1;
    }
    if (!sawKeyMaterial) continue;

    let replacement = '';
    for (const line of lines) replacement += mark + line.eol;
    const last = lines[lines.length - 1];
    const start = lines[0].start;
    const end = last.end + last.eol.length;
    // The edit covers the final EOL too so the replacement can restore each line's own terminator.
    edits.push({ rule: 'pem-private-key', start, end, replacement, multiline: true });
    from = end;
  }
  return edits;
}

/* ---------------------------------------------------------------- main entry point */

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  let i = text.indexOf('\n');
  while (i >= 0) {
    starts.push(i + 1);
    i = text.indexOf('\n', i + 1);
  }
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

function collectEdits(text: string, profile: Profile): Edit[] {
  const edits = pemEdits(text);
  for (const rule of RULES) {
    if (profile === 'lockfile' && rule.skipInLockfiles) continue;
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text))) {
      if (match[0].length === 0) rule.pattern.lastIndex++;
      const indices = (match as RegExpExecArray & { indices: Array<[number, number] | undefined> }).indices;
      const group = (rule.groups ?? [0]).find((g) => indices[g] !== undefined);
      if (group === undefined) continue;
      const [start, end] = indices[group]!;
      const value = match[group];
      if (/[\r\n]/.test(value) || (rule.accept && !rule.accept(value, profile, text.charAt(end)))) continue;
      edits.push({ rule: rule.name, start, end, replacement: placeholder(rule.name) });
    }
  }
  return edits;
}

/** Sorts edits and merges overlaps (the earliest, highest-priority edit keeps its rule name). */
function mergeEdits(edits: Edit[]): Edit[] {
  const order = new Map(edits.map((edit, index) => [edit, index]));
  edits.sort((a, b) => a.start - b.start || order.get(a)! - order.get(b)!);
  const merged: Edit[] = [];
  for (const edit of edits) {
    const last = merged[merged.length - 1];
    if (!last || edit.start >= last.end) merged.push({ ...edit });
    else if (edit.end > last.end && !last.multiline && !edit.multiline) last.end = edit.end;
  }
  return merged;
}

export function redactSecrets(text: string, options: RedactOptions = {}): RedactResult {
  if (!text || !mayContainSecrets(text)) return { text, findings: [] };
  const path = options.path?.replace(/\\/g, '/');
  const profile: Profile = path && LOCKFILE.test(path) ? 'lockfile' : path && isSecretPath(path) ? 'strict' : 'normal';
  const edits = mergeEdits(collectEdits(text, profile));
  if (!edits.length) return { text, findings: [] };

  const starts = lineStartOffsets(text);
  const findings: RedactFinding[] = [];
  const limit = options.maxFindings ?? Infinity;
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(text.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
    if (findings.length < limit) {
      findings.push({ rule: edit.rule, line: lineOf(starts, edit.start), start: edit.start, end: edit.end });
    }
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), findings };
}

/* ---------------------------------------------------------------- secret-bearing paths */

const TEMPLATE_SUFFIX = /\.(?:example|sample|template|tpl|dist)$/i;
const SECRET_BASENAMES = new Set([
  '.npmrc', '.pypirc', '.netrc', '_netrc', '.htpasswd', '.pgpass', '.git-credentials', '.dockercfg',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'terraform.tfstate', 'terraform.tfstate.backup',
  'kubeconfig', '.kube/config', '.vault_pass', '.vault-password', 'master.key', 'wp-config.php',
]);
const SECRET_EXTENSIONS = /\.(?:pem|key|p12|pfx|keystore|jks|ppk|kdbx|tfvars|pkcs12)$/i;
const DATA_EXTENSION = /\.(?:json|ya?ml|toml|ini|txt|env|cfg|conf|properties|xml)$/i;
// "credentials" / "secrets" only count as data files, not source code such as credentials.ts.
const CREDENTIAL_STEM = /^(?:credentials?|secrets?)(?:[._-][a-z0-9._-]+)?$/;
const CREDENTIAL_BARE = /^(?:credentials?|secrets?)(?:[_-][a-z0-9_-]+)?$/;

/** True for files that normally hold credentials; templates such as `.env.example` are excluded. */
export function isSecretPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  if (!lower || TEMPLATE_SUFFIX.test(lower)) return false;
  if (SECRET_BASENAMES.has(lower) || /(?:^|\/)\.docker\/config\.json$/i.test(normalized)) return true;
  if (/(?:^|\/)\.kube\/config$/i.test(normalized) || /(?:^|\/)\.aws\/credentials$/i.test(normalized)) return true;
  if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) return true;
  if (lower.endsWith('.tfstate') || lower.startsWith('kubeconfig')) return true;
  if (/^service[-_]?account.*\.json$/.test(lower)) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?!.*\.pub$)/.test(lower)) return true;
  if (SECRET_EXTENSIONS.test(lower)) return true;
  return DATA_EXTENSION.test(lower)
    ? CREDENTIAL_STEM.test(lower.replace(DATA_EXTENSION, ''))
    : CREDENTIAL_BARE.test(lower);
}
