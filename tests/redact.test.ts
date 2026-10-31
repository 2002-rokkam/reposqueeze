import assert from 'node:assert/strict';
import test from 'node:test';
import { isSecretPath, mayContainSecrets, redactSecrets, shannonEntropy } from '../src/redact.js';

// All secrets below are synthetic: random strings built from public format descriptions, never real credentials.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20240607);
const make = (alphabet: string) => (n: number): string => {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
};
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const alnum = make(ALNUM);
const b64 = make(ALNUM + '+/');
const b64url = make(ALNUM + '-_');
const hex = make('0123456789abcdef');
const base32 = make('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
const mixed = make(ALNUM + '!@#%^&*');
// Guarantees the classes the heuristics look for so the synthetic value is not accidentally "identifier-like".
const strongAlnum = (n: number): string => `A1${alnum(n - 4)}z9`;

interface Positive {
  name: string;
  text: string;
  secret: string;
  rules: string[];
}
interface Negative {
  name: string;
  text: string;
  path?: string;
}

/* ------------------------------------------------------------ positives */

const CARRIERS: Array<[string, string]> = [
  ['js', `const client = new Client({ auth: '{S}' });`],
  ['python', `requests.get(url, headers={"X-Key": "{S}"})`],
  ['go', `req.Header.Set("X-Api", "{S}")`],
  ['java', `String key = "{S}";`],
  ['yaml', `  key: {S}`],
  ['json', `{"credentials": "{S}"}`],
  ['toml', `value = "{S}"`],
  ['xml', `<property name="x" value="{S}"/>`],
  ['shell', `export SERVICE_CRED={S}`],
  ['env', `SERVICE_CRED={S}`],
  ['dockerfile', `ENV SERVICE_CRED {S}`],
  ['markdown', 'Use this value: `{S}` in the settings page.'],
  ['minified', `!function(){var a="x",b="{S}";fetch(a,{h:b})}();`],
];

const TOKEN_GENERATORS: Array<[string, () => string]> = [
  ['github-token', () => `ghp_${alnum(36)}`],
  ['github-token', () => `gho_${alnum(36)}`],
  ['github-token', () => `ghu_${alnum(36)}`],
  ['github-token', () => `ghs_${alnum(36)}`],
  ['github-token', () => `ghr_${alnum(36)}`],
  ['github-token', () => `github_pat_${alnum(22)}_${alnum(59)}`],
  ['gitlab-token', () => `glpat-${b64url(20)}`],
  ['slack-token', () => `xoxb-${make('0123456789')(11)}-${make('0123456789')(12)}-${alnum(24)}`],
  ['slack-token', () => `xoxp-${make('0123456789')(11)}-${make('0123456789')(11)}-${alnum(24)}`],
  ['stripe-key', () => `sk_live_${alnum(24)}`],
  ['stripe-key', () => `rk_live_${alnum(24)}`],
  ['google-api-key', () => `AIza${b64url(35)}`],
  ['anthropic-key', () => `sk-ant-api03-${b64url(90)}`],
  ['openai-key', () => `sk-proj-${strongAlnum(60)}`],
  ['openai-key', () => `sk-${strongAlnum(48)}`],
  ['huggingface-token', () => `hf_${alnum(37)}`],
  ['npm-token', () => `npm_${alnum(36)}`],
  ['pypi-token', () => `pypi-AgEIcHlwaS5vcmc${b64url(60)}`],
  ['sendgrid-key', () => `SG.${b64url(22)}.${b64url(43)}`],
  ['twilio-key', () => `SK${hex(32)}`],
  ['aws-access-key', () => `AKIA${base32(16)}`],
  ['aws-access-key', () => `ASIA${base32(16)}`],
  ['jwt', () => `eyJ${b64url(20)}.eyJ${b64url(40)}.${b64url(43)}`],
  ['slack-webhook', () => `https://hooks.slack.com/services/T${base32(8)}/B${base32(10)}/${alnum(24)}`],
];

function buildPositives(): Positive[] {
  const out: Positive[] = [];
  TOKEN_GENERATORS.forEach(([rule, gen], index) => {
    for (let k = 0; k < 4; k++) {
      const [lang, template] = CARRIERS[(index * 4 + k) % CARRIERS.length];
      let secret = gen();
      // The slack webhook rule redacts only the trailing token segment.
      const text = template.replace('{S}', secret);
      if (rule === 'slack-webhook') secret = secret.split('/').pop()!;
      out.push({ name: `${rule}/${lang}`, text, secret, rules: [rule] });
    }
  });

  const add = (name: string, template: string, secret: string, ...rules: string[]) =>
    out.push({ name, text: template.replace('{S}', secret), secret, rules });

  // AWS secret access keys (40 base64 chars) only count next to an aws-flavoured name.
  add('aws-secret/ini', `[default]\naws_secret_access_key = {S}`, b64(40), 'aws-secret-key');
  add('aws-secret/env', `export AWS_SECRET_ACCESS_KEY={S}`, b64(40), 'aws-secret-key');
  add('aws-secret/js', `const cfg = { awsSecretKey: "{S}" };`, b64(40), 'aws-secret-key');
  add('aws-secret/python', `aws_secret = '{S}'`, b64(40), 'aws-secret-key');

  // URL credentials and connection strings.
  const pw = () => `${alnum(6)}${make('0123456789')(3)}${alnum(5)}`;
  add('url/postgres', `DATABASE_URL=postgres://app:{S}@db.internal:5432/app`, pw(), 'url-credentials');
  add('url/mongodb', `uri = "mongodb+srv://admin:{S}@cluster0.example.net/test"`, pw(), 'url-credentials');
  add('url/https', `git clone https://deploy:{S}@git.example.org/team/repo.git`, pw(), 'url-credentials');
  add('url/redis', `REDIS_URL: redis://default:{S}@cache.internal:6379/0`, pw(), 'url-credentials');
  add('url/amqp', `broker = amqp://svc:{S}@mq.internal:5672//`, pw(), 'url-credentials');
  add('url/mysql-java', `jdbc:mysql://db.internal:3306/app?user=app&password={S}&useSSL=true`, pw(), 'connection-password');
  add('conn/sqlserver', `Server=tcp:db.internal,1433;Database=app;User Id=sa;Password={S};Encrypt=true`, pw(), 'connection-password');
  add('conn/ado-xml', `<add name="Db" connectionString="Data Source=db;Initial Catalog=app;Password={S};" />`, pw(), 'connection-password');

  // Authorization headers.
  const bearer = alnum(8) + make('0123456789')(4) + alnum(20);
  add('auth/curl', `curl -H "Authorization: Bearer {S}" https://api.example.org/v1/me`, bearer, 'auth-header');
  add('auth/js', `headers: { Authorization: 'Bearer {S}' }`, bearer, 'auth-header');
  add('auth/http', `Authorization: Bearer {S}`, bearer, 'auth-header');
  add('auth/basic', `Authorization: Basic {S}`, `${b64(20)}9${b64(8)}`.replace(/[+/]/g, 'a') + '==', 'auth-header');

  add('azure/conn', `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey={S};EndpointSuffix=core.windows.net`, `${b64(70)}==`, 'azure-key');
  add('azure/json', `{"SharedAccessKey": "{S}"}`.replace('"SharedAccessKey": "', 'SharedAccessKey=').replace('"}', ''), `${b64(40)}=`, 'azure-key');
  add('twilio/auth-token', `twilio_auth_token = "{S}"`, hex(32), 'twilio-token');
  add('twilio/env', `TWILIO_AUTH_TOKEN={S}`, hex(32), 'twilio-token');

  // Generic keyword assignments across languages and config formats.
  const generic: Array<[string, string]> = [
    ['js', `const password = "{S}";`],
    ['python', `API_KEY = '{S}'`],
    ['go', `clientSecret := "{S}"`],
    ['java', `private static final String PASSWORD = "{S}";`],
    ['yaml-quoted', `password: "{S}"`],
    ['yaml-bare', `api_key: {S}`],
    ['json', `{"client_secret": "{S}"}`],
    ['toml', `token = "{S}"`],
    ['xml', `<password>{S}</password>`],
    ['shell', `export API_KEY={S}`],
    ['env', `SECRET_KEY={S}`],
    ['dockerfile', `ENV DB_PASSWORD={S}`],
    ['markdown', 'Set `token="{S}"` before running.'],
    ['minified', `var a={apiKey:"{S}",b:1};`],
    ['properties', `db.password={S}`],
    ['ruby', `config.secret_token = '{S}'`],
    ['php', `$password = '{S}';`],
    ['csharp', `string apiKey = "{S}";`],
    ['rust', `let token = "{S}";`],
    ['js-object', `module.exports = { privateKey: '{S}' };`],
    ['escaped-json', `"{\\"password\\": \\"{S}\\"}"`],
    ['ini', `[auth]\nclient_secret = {S}`],
  ];
  for (const [lang, template] of generic) {
    // Bare (unquoted) values must stay free of characters that end them early.
    const secret = lang === 'yaml-bare' || lang === 'shell' || lang === 'env' || lang === 'dockerfile' || lang === 'properties' || lang === 'ini'
      ? `Q7${alnum(20)}9x`
      : `Q7${mixed(20)}9x`;
    add(`generic/${lang}`, template, secret, 'generic-secret', 'xml-secret');
  }

  // Private keys: multi-line (LF and CRLF), escaped, OpenSSH, PGP.
  const body = (lines: number) => Array.from({ length: lines }, () => b64(64));
  for (const [kind, eol] of [['RSA PRIVATE KEY', '\n'], ['PRIVATE KEY', '\r\n'], ['EC PRIVATE KEY', '\n'], ['OPENSSH PRIVATE KEY', '\n'], ['ENCRYPTED PRIVATE KEY', '\r\n']] as const) {
    const lines = body(8);
    out.push({
      name: `pem/${kind}`,
      text: [`-----BEGIN ${kind}-----`, ...lines, `-----END ${kind}-----`].join(eol) + eol,
      secret: lines[3],
      rules: ['pem-private-key'],
    });
  }
  const escapedKey = body(6).join('\\n');
  out.push({
    name: 'pem/json-escaped',
    text: `{"private_key": "-----BEGIN PRIVATE KEY-----\\n${escapedKey}\\n-----END PRIVATE KEY-----\\n", "client_email": "svc@proj.iam.example.com"}`,
    secret: escapedKey.slice(0, 64),
    rules: ['pem-private-key'],
  });
  const pgp = body(5);
  out.push({
    name: 'pem/pgp',
    text: ['-----BEGIN PGP PRIVATE KEY BLOCK-----', '', ...pgp, '-----END PGP PRIVATE KEY BLOCK-----'].join('\n'),
    secret: pgp[2],
    rules: ['pem-private-key'],
  });
  const truncated = body(5);
  out.push({
    name: 'pem/truncated',
    text: ['-----BEGIN RSA PRIVATE KEY-----', ...truncated].join('\n'),
    secret: truncated[4],
    rules: ['pem-private-key'],
  });
  return out;
}

/* ------------------------------------------------------------ negatives */

const PLACEHOLDER_VALUES = [
  'your-api-key-goes-here',
  '<token>',
  '${API_TOKEN}',
  '{{ secrets.NPM_TOKEN }}',
  'YOUR_SECRET_KEY_HERE',
  'changeme',
  'example-token-1234567890',
  'xxxxxxxxxxxxxxxxxxxxxxxx',
  '${{ secrets.GITHUB_TOKEN }}',
  'REPLACE_ME_WITH_REAL_PASSWORD',
];
const NEGATIVE_CARRIERS: Array<[string, string]> = [
  ['js', `const password = "{V}";`],
  ['python', `API_KEY = '{V}'`],
  ['java', `private String secret = "{V}";`],
  ['yaml', `token: "{V}"`],
  ['json', `{"client_secret": "{V}"}`],
  ['toml', `api_key = "{V}"`],
  ['xml', `<password>{V}</password>`],
  ['shell', `export API_TOKEN="{V}"`],
  ['env', `SECRET_KEY={V}`],
  ['dockerfile', `ENV DB_PASSWORD={V}`],
];

function buildNegatives(): Negative[] {
  const out: Negative[] = [];
  for (const value of PLACEHOLDER_VALUES) {
    for (const [lang, template] of NEGATIVE_CARRIERS) {
      out.push({ name: `placeholder/${lang}/${value}`, text: template.replace('{V}', value) });
    }
  }
  const sha = hex(40);
  const uuid = `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
  const integrity = `sha512-${b64(86)}==`;
  const dataUri = `data:image/png;base64,${b64(400)}`;
  const raw: Array<[string, string, string?]> = [
    ['git-sha/js', `const COMMIT = "${sha}";`],
    ['git-sha/log', `commit ${sha}\nAuthor: Dev <dev@example.org>`],
    ['git-sha/go', `var buildCommit = "${sha}"`],
    ['uuid/python', `request_id = "${uuid}"`],
    ['uuid/json', `{"id": "${uuid}", "name": "widget"}`],
    ['uuid/yaml', `trace_id: ${uuid}`],
    ['integrity/lock', `      "integrity": "${integrity}",`, 'package-lock.json'],
    ['integrity/yarn', `  integrity ${integrity}`, 'yarn.lock'],
    ['integrity/js', `const integrity = "${integrity}";`],
    ['lock/token-field', `token = "${b64(40)}"`, 'Cargo.lock'],
    ['data-uri/css', `.logo { background: url(${dataUri}); }`],
    ['data-uri/html', `<img src="${dataUri}" alt="logo">`],
    ['minified/js', `!function(e,t){for(var n=0,r=[],o=e.length;n<o;n++)r.push(t(e[n],n));return r}([1,2,3],function(a){return a*2});`],
    ['minified/long', `var a=[${Array.from({ length: 200 }, () => hex(6)).map((h) => `"${h}"`).join(',')}];`],
    ['identifier/camel', `const getUserAuthenticationTokenFromCache = createSelectorFactory();`],
    ['identifier/token-fn', `const token = getUserAuthenticationTokenFromCacheStore();`],
    ['identifier/snake', `secret = some_long_configuration_key_name`],
    ['identifier/const', `api_key = DEFAULT_API_KEY_ENVIRONMENT_NAME_V2`],
    ['identifier/dotted', `password_key = "spring.datasource.password"`],
    ['identifier/java-const', `public static final String TOKEN_HEADER = "X-Auth-Token";`],
    ['identifier/kebab', `token = "my-secret-token-name-v2"`],
    ['identifier/pascal', `secret = "ClientSecretProviderFactoryImpl"`],
    ['url/plain', `fetch("https://api.example.org/v1/users?page=2&limit=50")`],
    ['url/default-creds', `DATABASE_URL=postgres://postgres:postgres@localhost:5432/dev`],
    ['url/placeholder-creds', `git clone https://user:${'${GIT_PASSWORD}'}@git.example.org/repo.git`],
    ['url/ssh', `git remote add origin ssh://git@github.com/org/repo.git`],
    ['url/port', `server = "http://localhost:8080/health"`],
    ['url/userinfo-user-pass', `curl https://user:pass@example.org/`],
    ['url/token-url', `TOKEN_URL = "https://auth.example.org/oauth/token"`],
    ['env/os-environ', `SECRET_KEY = os.environ["SECRET_KEY"]`],
    ['env/getenv', `password = os.getenv("DB_PASSWORD_VALUE_FROM_VAULT")`],
    ['env/process', `const apiKey = process.env.OPENAI_API_KEY;`],
    ['env/go', `token := os.Getenv("GITHUB_TOKEN_FOR_CI_RUN")`],
    ['env/java', `String password = System.getenv("DB_PASSWORD");`],
    ['env/rails', `secret_key_base: <%= ENV["SECRET_KEY_BASE"] %>`],
    ['env/compose', `      - API_KEY=\${API_KEY}`],
    ['auth/bearer-var', `headers = {"Authorization": f"Bearer {token}"}`],
    ['auth/bearer-js', 'headers: { Authorization: `Bearer ${token}` }'],
    ['auth/bearer-doc', `Authorization: Bearer <your-access-token>`],
    ['auth/bearer-env', `curl -H "Authorization: Bearer $TOKEN" https://api.example.org`],
    ['auth/header-concat', `req.setHeader("Authorization", "Bearer " + token);`],
    ['aws/example', `aws_access_key_id = AKIAIOSFODNN7EXAMPLE`],
    ['aws/secret-example', `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`],
    ['aws/no-keyword', `const blob = "${b64(40)}";`],
    ['prefix/sk-learn', `pip install sk-learn-extra-utilities-package`],
    ['prefix/sk-slug', `.sk-container-fluid-wrapper-main-content-area { margin: 0 }`],
    ['prefix/ghp-doc', `Tokens start with ghp_ and are 40 characters long.`],
    ['prefix/hf-short', `def hf_load(path): return hf_dataset_loader(path)`],
    ['prefix/npm-name', `import { npm_run_all } from "./npm_scripts_helper_module";`],
    ['prefix/xox-doc', `Bot tokens begin with xoxb- followed by digits.`],
    ['jwt/malformed', `const x = "eyJhbGciOi.notajwt";`],
    ['pem/header-only', `const HEADER = "-----BEGIN PRIVATE KEY-----";`],
    ['pem/header-footer', `assert.ok(key.startsWith("-----BEGIN RSA PRIVATE KEY-----"));`],
    ['pem/certificate', `-----BEGIN CERTIFICATE-----\n${b64(64)}\n${b64(64)}\n-----END CERTIFICATE-----`],
    ['pem/public-key', `-----BEGIN PUBLIC KEY-----\n${b64(64)}\n${b64(40)}\n-----END PUBLIC KEY-----`],
    ['ssh/public', `ssh-rsa AAAAB3NzaC1yc2E${b64(120)} user@host`],
    ['prose/password-doc', `To reset your password, open Settings and choose "Forgot password".`],
    ['prose/i18n', `"password_reset_token_expired": "The password reset link has expired, request a new one."`],
    ['prose/markdown', `## Tokens\n\nThe token must be kept secret. Never commit your password to git.`],
    ['prose/sentence', `secret = "this is a long sentence that is not a secret at all"`],
    ['sql/column', `SELECT id, password_hash, api_token_id FROM users WHERE token_expired = 1;`],
    ['python/annotation', `password: str = ""`],
    ['python/getpass', `password = getpass.getpass("Enter password: ")`],
    ['python/headers-get', `token = request.headers.get("X-Forwarded-Authorization-Value")`],
    ['go/struct-tag', 'Password string `json:"password" yaml:"password"`'],
    ['go/const', `const tokenTypeBearer = "bearer"`],
    ['java/field', `private final PasswordEncoder passwordEncoder = new BCryptPasswordEncoder();`],
    ['java/interface', `String resolveToken(HttpServletRequest request, TokenExtractorStrategy strategy);`],
    ['ts/type', `type ApiKey = { secret: string; token?: string };`],
    ['ts/function', `export function parseToken(input: string, options: ParseOptions): ParsedToken {`],
    ['js/tokenizer', `const tokenizer = new Tokenizer({ lowercase: true, maxTokens: 1024 });`],
    ['js/crypto', `const digest = crypto.createHash("sha256").update(secret).digest("hex");`],
    ['css/token', `:root { --color-token-primary: #3366ff; --token-spacing-large: 24px; }`],
    ['yaml/k8s-ref', `        secretKeyRef:\n          name: db-credentials\n          key: password`],
    ['yaml/gha', `        env:\n          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}`],
    ['yaml/helm', `password: {{ .Values.postgresql.auth.password | quote }}`],
    ['toml/pyproject', `[tool.poetry]\nname = "demo"\nversion = "1.2.3"\ndescription = "Token bucket rate limiter"`],
    ['xml/maven', `<dependency><groupId>org.example</groupId><artifactId>token-utils</artifactId><version>2.4.1</version></dependency>`],
    ['xml/spring', `<property name="password" value="\${db.password}"/>`],
    ['shell/read', `read -s -p "Password: " PASSWORD`],
    ['shell/prompt', `echo "Set API_TOKEN in your shell profile first"`],
    ['docker/arg', `ARG GITHUB_TOKEN\nRUN --mount=type=secret,id=npmrc cp /run/secrets/npmrc ~/.npmrc`],
    ['docker/from', `FROM node:20-alpine@sha256:${hex(64)}`],
    ['md/table', `| token | string | The pagination token returned by the previous call |`],
    ['md/code', 'Run `export API_KEY=<your-key>` then start the server.'],
    ['hash/sha256', `sha256: ${hex(64)}`],
    ['hash/checksum', `checksum = "${hex(64)}"`],
    ['hash/md5', `etag: "${hex(32)}"`],
    ['css/base64-font', `src: url(data:font/woff2;base64,${b64(300)}) format("woff2");`],
    ['version/semver', `token_version = "1.12.3-beta.4+build.20240101"`],
    ['path/token', `token_path = "/var/run/secrets/kubernetes.io/serviceaccount/token"`],
    ['path/secret-dir', `secret_dir = "./config/secrets/production-env"`],
    ['num/long', `const SECRET_SEED = 12345678901234567890;`],
    ['regex/token', `const TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;`],
    ['test/short-pw', `password: "short"`],
    ['test/empty', `token = ""`],
    ['test/null', `secret: null`],
    ['unicode', `const mensaje = "contraseña: ción ñandú 日本語のパスワード説明";`],
    ['binary-ish', `\u0000\u0001\u0002 token \u0003`],
    ['blank', ''],
    ['whitespace', '   \n\t\n'],
    ['plain-code', `function add(a, b) {\n  return a + b;\n}\n`],
    ['license', `Permission is hereby granted, free of charge, to any person obtaining a copy of this software`],
  ];
  for (const [name, text, path] of raw) out.push({ name, text, path });
  return out;
}

/* ------------------------------------------------------------ tests */

const POSITIVES = buildPositives();
const NEGATIVES = buildNegatives();

test('corpus sizes meet the minimum', () => {
  assert.ok(POSITIVES.length >= 120, `positives: ${POSITIVES.length}`);
  assert.ok(NEGATIVES.length >= 120, `negatives: ${NEGATIVES.length}`);
});

test('precision and recall over the labelled corpus', () => {
  let tp = 0;
  let fn = 0;
  const missed: string[] = [];
  for (const sample of POSITIVES) {
    const { text, findings } = redactSecrets(sample.text);
    const redacted = findings.length > 0 && !text.includes(sample.secret);
    if (redacted) tp++;
    else {
      fn++;
      missed.push(sample.name);
    }
    if (redacted) {
      assert.ok(
        findings.some((f) => sample.rules.includes(f.rule)),
        `${sample.name}: rules ${findings.map((f) => f.rule)} not in ${sample.rules}`,
      );
    }
  }
  let fp = 0;
  const flagged: string[] = [];
  for (const sample of NEGATIVES) {
    const { findings } = redactSecrets(sample.text, { path: sample.path });
    if (findings.length) {
      fp++;
      flagged.push(`${sample.name} -> ${findings.map((f) => f.rule)}`);
    }
  }
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  console.log(
    `redact corpus: ${POSITIVES.length} positives, ${NEGATIVES.length} negatives | TP=${tp} FN=${fn} FP=${fp} | ` +
      `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`,
  );
  if (missed.length) console.log(`  missed: ${missed.join(', ')}`);
  if (flagged.length) console.log(`  false positives: ${flagged.join(', ')}`);
  assert.ok(precision >= 0.95, `precision ${precision}`);
  assert.ok(recall >= 0.95, `recall ${recall}`);
});

test('only the secret value is replaced; surrounding text is untouched', () => {
  const secret = `ghp_${alnum(36)}`;
  const result = redactSecrets(`before ${secret} after`);
  assert.equal(result.text, 'before [REDACTED:github-token] after');
  assert.deepEqual(result.findings, [{ rule: 'github-token', line: 1, start: 7, end: 7 + secret.length }]);
  const generic = redactSecrets(`password = "Q7${mixed(20)}9x" # keep this`);
  assert.match(generic.text, /^password = "\[REDACTED:generic-secret\]" # keep this$/);
});

test('findings report one-based lines and original offsets', () => {
  const secret = `AKIA${base32(16)}`;
  const text = `line one\r\nline two\nkey = ${secret}\nlast`;
  const [finding] = redactSecrets(text).findings;
  assert.equal(finding.line, 3);
  assert.equal(text.slice(finding.start, finding.end), secret);
});

test('line count and line terminators are preserved (property test)', () => {
  const rng = mulberry32(7);
  const pieces = POSITIVES.map((p) => p.text).concat(NEGATIVES.map((n) => n.text), ['', 'plain text', '\r', 'x\ry']);
  const eols = ['\n', '\r\n', '\n', '\r\n', '\r'];
  for (let round = 0; round < 300; round++) {
    let text = '';
    const parts = 1 + Math.floor(rng() * 8);
    for (let i = 0; i < parts; i++) {
      const piece = pieces[Math.floor(rng() * pieces.length)];
      text += piece + eols[Math.floor(rng() * eols.length)];
    }
    const result = redactSecrets(text);
    const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
    assert.equal(count(result.text, /\n/g), count(text, /\n/g), `LF count changed in round ${round}`);
    assert.equal(count(result.text, /\r/g), count(text, /\r/g), `CR count changed in round ${round}`);
    for (const finding of result.findings) {
      assert.equal(finding.line, count(text.slice(0, finding.start), /\n/g) + 1);
    }
  }
});

test('multi-line PEM keeps one placeholder line per original line, CRLF safe', () => {
  const lines = Array.from({ length: 12 }, () => b64(64));
  for (const eol of ['\n', '\r\n']) {
    const text = ['-----BEGIN RSA PRIVATE KEY-----', ...lines, '-----END RSA PRIVATE KEY-----', 'tail'].join(eol);
    const result = redactSecrets(text);
    const out = result.text.split(eol);
    assert.equal(out.length, lines.length + 3);
    assert.equal(out[0], '-----BEGIN RSA PRIVATE KEY-----');
    assert.ok(out.slice(1, 13).every((l) => l === '[REDACTED:pem-private-key]'));
    assert.equal(out[13], '-----END RSA PRIVATE KEY-----');
    assert.equal(out[14], 'tail');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].line, 2);
  }
});

test('mayContainSecrets is never false when redactSecrets finds something', () => {
  for (const sample of POSITIVES) {
    assert.ok(mayContainSecrets(sample.text), sample.name);
  }
  const rng = mulberry32(11);
  const pieces = POSITIVES.map((p) => p.text).concat(NEGATIVES.map((n) => n.text));
  for (let i = 0; i < 400; i++) {
    const text = pieces[Math.floor(rng() * pieces.length)] + '\n' + pieces[Math.floor(rng() * pieces.length)];
    if (redactSecrets(text).findings.length) assert.ok(mayContainSecrets(text));
  }
  assert.equal(mayContainSecrets('function add(a, b) { return a + b; }'), false);
  assert.equal(mayContainSecrets(''), false);
});

test('maxFindings caps the reported list but redaction stays complete', () => {
  const text = Array.from({ length: 5 }, () => `k = ghp_${alnum(36)}`).join('\n');
  const result = redactSecrets(text, { maxFindings: 2 });
  assert.equal(result.findings.length, 2);
  assert.equal(result.text.match(/\[REDACTED:github-token\]/g)?.length, 5);
});

test('path-aware profiles: strict inside secret files, silent on lockfiles', () => {
  assert.equal(redactSecrets('PASSWORD=Tr0ub4dor9').findings.length, 0);
  assert.equal(redactSecrets('PASSWORD=Tr0ub4dor9', { path: 'deploy/.env.production' }).findings.length, 1);
  const lock = `"token": "${b64(40)}"`;
  assert.equal(redactSecrets(lock).findings.length, 1);
  assert.equal(redactSecrets(lock, { path: 'package-lock.json' }).findings.length, 0);
  // Prefix-anchored tokens are still caught inside lockfiles.
  assert.equal(redactSecrets(`ghp_${alnum(36)}`, { path: 'yarn.lock' }).findings.length, 1);
});

test('isSecretPath', () => {
  const yes = [
    '.env', '.env.local', 'config/.env.production', 'prod.env', '.npmrc', 'home/.pypirc', '.netrc', 'id_rsa', 'ssh/id_ed25519',
    'certs/server.pem', 'tls/server.key', 'store.p12', 'store.pfx', 'app.keystore', 'release.jks', 'credentials.json',
    '.aws/credentials', 'secrets.yml', 'secrets.json', 'terraform.tfstate', 'terraform.tfstate.backup', 'prod.tfvars',
    'kubeconfig', '.kube/config', 'service-account.json', 'service-account-prod.json', '.htpasswd', 'a\\b\\.env',
  ];
  const no = [
    '.env.example', '.env.sample', '.env.template', 'src/credentials.ts', 'src/secrets.go', 'id_rsa.pub', 'README.md',
    'src/redact.ts', 'environment.ts', 'package.json', 'docs/secrets-management.md', 'keyboard.ts', 'monkey.png',
  ];
  for (const p of yes) assert.equal(isSecretPath(p), true, p);
  for (const p of no) assert.equal(isSecretPath(p), false, p);
});

test('entropy helper', () => {
  assert.equal(shannonEntropy(''), 0);
  assert.equal(shannonEntropy('aaaa'), 0);
  assert.ok(shannonEntropy('abcdefgh') > 2.9);
});

test('adversarial 2 MiB inputs finish quickly', () => {
  const size = 2 * 1024 * 1024;
  const rng = mulberry32(99);
  const noise = Array.from({ length: size }, () => String.fromCharCode(Math.floor(rng() * 256))).join('');
  const inputs: Record<string, string> = {
    'one long line of a': 'a'.repeat(size),
    'repeated password=': 'password='.repeat(size / 9),
    'repeated quoted keyword': 'token: "'.repeat(size / 8),
    'repeated keyword and long value': `secret = "${'a1'.repeat(300)}`.repeat(Math.floor(size / 610)),
    'repeated AKIA': 'AKIA'.repeat(size / 4),
    'repeated PEM header': '-----BEGIN PRIVATE KEY-----'.repeat(size / 27),
    'PEM header with huge body, no end': `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(size)}`,
    'inline PEM header with huge body': `-----BEGIN PRIVATE KEY----- ${'A'.repeat(size)}`,
    'repeated url userinfo': '://a:'.repeat(size / 5),
    'long userinfo': `://${'u'.repeat(size)}:pw@`,
    'repeated eyJ': 'eyJ'.repeat(size / 3),
    'repeated sk-': 'sk-'.repeat(size / 3),
    'repeated authorization': 'Authorization: Bearer '.repeat(size / 22),
    'repeated xml keyword tag': '<password>'.repeat(size / 10),
    'many short lines': 'x\n'.repeat(size / 2),
    'many CRLF lines with keywords': 'token=\r\n'.repeat(size / 8),
    'binary noise': noise,
    'unicode': '𝒫𝒶𝓈𝓈𝓌𝑜𝓇𝒹'.repeat(size / 16),
    'conn string repeats': 'Server=;'.repeat(size / 8),
  };
  const timings: string[] = [];
  for (const [name, text] of Object.entries(inputs)) {
    const started = process.hrtime.bigint();
    const result = redactSecrets(text.slice(0, size));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    timings.push(`${name}: ${ms.toFixed(0)}ms`);
    assert.ok(ms < 1000, `${name} took ${ms.toFixed(0)} ms`);
    assert.equal(result.text.split('\n').length, text.slice(0, size).split('\n').length, name);
  }
  console.log(`redact adversarial 2 MiB timings -> ${timings.join(' | ')}`);
});
