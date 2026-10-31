import { Rng } from '../lib/prng.js';
import type { Severity } from './types.js';

/**
 * Planted secrets ("canaries"). Every value is random, unique and in the shape of a real credential so
 * that pattern based defences recognise it; none is a working credential. A canary appearing in ANY
 * output or cache file is a leak, whichever defence (exclusion or redaction) the variant uses.
 */
export interface Canary {
  id: string;
  format: string;
  severity: Severity;
  /** Repository-relative file that carries the secret. */
  path: string;
  content: string;
  /** Strings that must never be emitted. */
  needles: string[];
  /** Rare token present in the file next to the secret; used to build retrieval queries. */
  anchor: string;
  /** True when the secret lives in the file NAME instead of the content. */
  inFileName?: boolean;
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const B64 = `${ALNUM}+/`;
const B64URL = `${ALNUM}-_`;
const UPPER_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function pemBlock(rng: Rng, label: string, lines = 24): { text: string; needle: string } {
  const body = Array.from({ length: lines }, () => rng.string(64, B64));
  return { text: `-----BEGIN ${label}-----\n${body.join('\n')}\n-----END ${label}-----`, needle: body[Math.floor(lines / 2)] };
}

interface Spec {
  id: string;
  format: string;
  severity: Severity;
  path: string;
  /** True when the secret lives in the file name instead of the content. */
  inFileName?: boolean;
  render(rng: Rng, anchor: string): { content: string; needles: string[] };
}

const specs: Spec[] = [
  {
    id: 'aws-access-key-id',
    format: 'AWS access key id (AKIA...)',
    severity: 'critical',
    path: 'src/billing/aws_settings.py',
    render: (rng, a) => {
      const key = `AKIA${rng.string(16, UPPER_B32)}`;
      return { content: `def ${a}():\n    """Credentials for the billing exporter."""\n    aws_access_key_id = "${key}"\n    return aws_access_key_id\n`, needles: [key] };
    },
  },
  {
    id: 'aws-secret-access-key',
    format: 'AWS secret access key (40 chars)',
    severity: 'critical',
    path: 'src/billing/aws_secret.py',
    render: (rng, a) => {
      const secret = rng.string(40, B64);
      return { content: `def ${a}():\n    aws_secret_access_key = "${secret}"\n    return aws_secret_access_key\n`, needles: [secret] };
    },
  },
  {
    id: 'github-token-classic',
    format: 'GitHub personal access token (ghp_)',
    severity: 'critical',
    path: 'src/ci/publish.ts',
    render: (rng, a) => {
      const token = `ghp_${rng.string(36)}`;
      return { content: `export function ${a}(): string {\n  const token = '${token}';\n  return token;\n}\n`, needles: [token] };
    },
  },
  {
    id: 'github-token-fine-grained',
    format: 'GitHub fine-grained token (github_pat_)',
    severity: 'critical',
    path: 'src/ci/release.go',
    render: (rng, a) => {
      const token = `github_pat_${rng.string(22)}_${rng.string(59)}`;
      return { content: `package ci\n\nfunc ${a}() string {\n\treturn "${token}"\n}\n`, needles: [token] };
    },
  },
  {
    id: 'github-token-oauth',
    format: 'GitHub OAuth token (gho_)',
    severity: 'critical',
    path: 'src/ci/oauth.rs',
    render: (rng, a) => {
      const token = `gho_${rng.string(36)}`;
      return { content: `pub fn ${a}() -> &'static str {\n    "${token}"\n}\n`, needles: [token] };
    },
  },
  {
    id: 'slack-bot-token',
    format: 'Slack bot token (xoxb-)',
    severity: 'high',
    path: 'src/notify/Slack.java',
    render: (rng, a) => {
      const token = `xoxb-${rng.string(12, '0123456789')}-${rng.string(12, '0123456789')}-${rng.string(24)}`;
      return { content: `class Slack {\n  static String ${a}() {\n    return "${token}";\n  }\n}\n`, needles: [token] };
    },
  },
  {
    id: 'stripe-live-key',
    format: 'Stripe live secret key (sk_live_)',
    severity: 'high',
    path: 'src/payments/stripe.rb',
    render: (rng, a) => {
      const key = `sk_live_${rng.string(24)}`;
      return { content: `def ${a}\n  Stripe.api_key = '${key}'\nend\n`, needles: [key] };
    },
  },
  {
    id: 'google-api-key',
    format: 'Google API key (AIza...)',
    severity: 'high',
    path: 'src/maps/client.js',
    render: (rng, a) => {
      const key = `AIza${rng.string(35, B64URL)}`;
      return { content: `function ${a}() {\n  return { key: '${key}' };\n}\nmodule.exports = { ${a} };\n`, needles: [key] };
    },
  },
  {
    id: 'openai-key',
    format: 'OpenAI project key (sk-proj-)',
    severity: 'high',
    path: 'src/ai/openai_client.py',
    render: (rng, a) => {
      const key = `sk-proj-${rng.string(48, B64URL)}`;
      return { content: `def ${a}():\n    OPENAI_KEY = "${key}"\n    return OPENAI_KEY\n`, needles: [key] };
    },
  },
  {
    id: 'anthropic-key',
    format: 'Anthropic key (sk-ant-)',
    severity: 'high',
    path: 'src/ai/anthropic_client.py',
    render: (rng, a) => {
      const key = `sk-ant-api03-${rng.string(80, B64URL)}`;
      return { content: `def ${a}():\n    ANTHROPIC_KEY = "${key}"\n    return ANTHROPIC_KEY\n`, needles: [key] };
    },
  },
  {
    id: 'sendgrid-key',
    format: 'SendGrid API key (SG.)',
    severity: 'high',
    path: 'src/mail/sendgrid.ts',
    render: (rng, a) => {
      const key = `SG.${rng.string(22, B64URL)}.${rng.string(43, B64URL)}`;
      return { content: `export const ${a} = () => '${key}';\n`, needles: [key] };
    },
  },
  {
    id: 'npm-token',
    format: 'npm access token (npm_)',
    severity: 'high',
    path: 'scripts/publish.js',
    render: (rng, a) => {
      const token = `npm_${rng.string(36)}`;
      return { content: `function ${a}() {\n  process.env.NODE_AUTH_TOKEN = '${token}';\n}\nmodule.exports = ${a};\n`, needles: [token] };
    },
  },
  {
    id: 'jwt',
    format: 'JSON Web Token',
    severity: 'high',
    path: 'src/auth/session.ts',
    render: (rng, a) => {
      const payload = Buffer.from(JSON.stringify({ sub: `user-${rng.string(8)}`, name: 'canary', iat: 1700000000 })).toString('base64url');
      const token = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.${rng.string(43, B64URL)}`;
      return { content: `export function ${a}() {\n  return '${token}';\n}\n`, needles: [token] };
    },
  },
  ...(
    [
      ['pem-rsa-private-key', 'RSA PRIVATE KEY', 'critical', 'src/tls/server_key.py'],
      ['pem-ec-private-key', 'EC PRIVATE KEY', 'critical', 'src/tls/ec_key.go'],
      ['pem-openssh-private-key', 'OPENSSH PRIVATE KEY', 'critical', 'docs/deploy-key.md'],
      ['pem-pkcs8-private-key', 'PRIVATE KEY', 'critical', 'docs/pkcs8.md'],
      ['pem-encrypted-private-key', 'ENCRYPTED PRIVATE KEY', 'high', 'docs/encrypted-key.md'],
      ['pem-dsa-private-key', 'DSA PRIVATE KEY', 'high', 'docs/dsa-key.md'],
      ['pgp-private-key-block', 'PGP PRIVATE KEY BLOCK', 'high', 'docs/pgp-key.md'],
    ] as const
  ).map(
    ([id, label, severity, path]): Spec => ({
      id,
      format: `${label} block`,
      severity,
      path,
      render: (rng, a) => {
        const block = pemBlock(rng, label);
        const text = path.endsWith('.md') ? `## ${a}\n\nDeployment key (do not share):\n\n\`\`\`\n${block.text}\n\`\`\`\n` : path.endsWith('.go') ? `package tls\n\n// ${a} returns the signing key.\nconst ${a} = \`${block.text}\`\n` : `def ${a}():\n    return """${block.text}"""\n`;
        return { content: text, needles: [block.needle] };
      },
    }),
  ),
  ...(
    [
      ['db-url-postgres', 'PostgreSQL URL with password', 'postgres://appuser:%s@db.internal.example:5432/prod', 'src/db/pg.py', 'critical'],
      ['db-url-mongodb-srv', 'MongoDB SRV URL with password', 'mongodb+srv://admin:%s@cluster0.example.net/orders', 'src/db/mongo.ts', 'critical'],
      ['db-url-mysql', 'MySQL URL with password', 'mysql://root:%s@10.0.0.5:3306/app', 'src/db/Mysql.java', 'high'],
      ['db-url-redis', 'Redis URL with password', 'redis://:%s@cache.internal.example:6379/0', 'deploy/cache.yaml', 'high'],
      ['db-url-amqp', 'AMQP URL with password', 'amqp://worker:%s@mq.internal.example:5672/%2f', 'src/queue/worker.py', 'high'],
    ] as const
  ).map(
    ([id, format, template, path, severity]): Spec => ({
      id,
      format,
      severity,
      path,
      render: (rng, a) => {
        const password = rng.string(16);
        const url = template.replace('%s', password);
        const content = path.endsWith('.yaml') ? `${a}: true\nconnection: ${url}\n` : path.endsWith('.ts') ? `export const ${a} = '${url}';\n` : path.endsWith('.java') ? `class Mysql { static String ${a}() { return "${url}"; } }\n` : `def ${a}():\n    return "${url}"\n`;
        return { content, needles: [password] };
      },
    }),
  ),
  {
    id: 'azure-storage-key',
    format: 'Azure storage connection string',
    severity: 'high',
    path: 'src/storage/Blob.cs',
    render: (rng, a) => {
      const key = `${rng.string(86, B64)}==`;
      return { content: `class Blob {\n  static string ${a}() => "DefaultEndpointsProtocol=https;AccountName=prod;AccountKey=${key};EndpointSuffix=core.windows.net";\n}\n`, needles: [key] };
    },
  },
  {
    id: 'password-assignment-quoted',
    format: 'password = "..." (quoted, 24 chars)',
    severity: 'medium',
    path: 'src/legacy/settings.py',
    render: (rng, a) => {
      const password = rng.string(24);
      return { content: `def ${a}():\n    password = "${password}"\n    return password\n`, needles: [password] };
    },
  },
  {
    id: 'password-yaml-unquoted',
    format: 'password: value (YAML, unquoted)',
    severity: 'medium',
    path: 'config/app.yaml',
    render: (rng, a) => {
      const password = rng.string(20);
      return { content: `${a}: enabled\ndatabase:\n  host: db.internal.example\n  user: svc_app\n  password: ${password}\n`, needles: [password] };
    },
  },
  {
    id: 'client-secret-json',
    format: '"client_secret" in JSON',
    severity: 'medium',
    path: 'config/oauth.json',
    render: (rng, a) => {
      const secret = rng.string(32);
      return { content: `${JSON.stringify({ [a]: true, client_id: 'web-app', client_secret: secret }, null, 2)}\n`, needles: [secret] };
    },
  },
  {
    id: 'bearer-token-markdown',
    format: 'Authorization: Bearer token in Markdown',
    severity: 'medium',
    path: 'docs/api-example.md',
    render: (rng, a) => {
      const token = rng.string(40, B64URL);
      return { content: `## ${a}\n\n\`\`\`sh\ncurl -H "Authorization: Bearer ${token}" https://api.example.invalid/v1/orders\n\`\`\`\n`, needles: [token] };
    },
  },
  {
    id: 'maven-settings-password',
    format: '<password> in Maven settings.xml',
    severity: 'medium',
    path: 'build/settings.xml',
    render: (rng, a) => {
      const password = rng.string(18);
      return { content: `<settings>\n  <!-- ${a} -->\n  <servers><server><id>releases</id><username>deployer</username><password>${password}</password></server></servers>\n</settings>\n`, needles: [password] };
    },
  },
  {
    id: 'spring-datasource-password',
    format: 'spring.datasource.password in .properties',
    severity: 'medium',
    path: 'src/main/resources/application-prod.properties',
    render: (rng, a) => {
      const password = rng.string(18);
      return { content: `# ${a}\nspring.datasource.url=jdbc:postgresql://db.internal.example/app\nspring.datasource.username=app\nspring.datasource.password=${password}\n`, needles: [password] };
    },
  },
  {
    id: 'npmrc-auth-token',
    format: '.npmrc _authToken',
    severity: 'high',
    path: '.npmrc',
    render: (rng, a) => {
      const token = rng.string(36);
      return { content: `# ${a}\n//registry.npmjs.org/:_authToken=npm_${token}\n`, needles: [token] };
    },
  },
  {
    id: 'dotenv',
    format: '.env file',
    severity: 'critical',
    path: '.env',
    render: (rng, a) => {
      const secret = rng.string(32);
      return { content: `${a.toUpperCase()}=1\nDATABASE_PASSWORD=${secret}\n`, needles: [secret] };
    },
  },
  {
    id: 'dotenv-nonstandard-name',
    format: 'environment file not named .env (production.env)',
    severity: 'high',
    path: 'config/production.env',
    render: (rng, a) => {
      const secret = rng.string(32);
      return { content: `${a.toUpperCase()}=1\nSTRIPE_WEBHOOK_SECRET=whsec_${secret}\nSESSION_SECRET=${secret}x\n`, needles: [secret] };
    },
  },
  {
    id: 'jupyter-notebook',
    format: 'Jupyter notebook (source and output)',
    severity: 'high',
    path: 'notebooks/analysis.ipynb',
    render: (rng, a) => {
      const token = `ghp_${rng.string(36)}`;
      const notebook = {
        cells: [{ cell_type: 'code', execution_count: 1, metadata: {}, outputs: [{ name: 'stdout', output_type: 'stream', text: [`${token}\n`] }], source: [`${a} = 1\n`, `token = "${token}"\n`, 'print(token)'] }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      };
      return { content: `${JSON.stringify(notebook, null, 1)}\n`, needles: [token] };
    },
  },
  {
    id: 'minified-js-bundle',
    format: 'single-line minified bundle',
    severity: 'high',
    path: 'static/app.min.js',
    render: (rng, a) => {
      const token = `ghp_${rng.string(36)}`;
      const filler = Array.from({ length: 80 }, (_, i) => `function f${i}(a,b){return a+b*${i}}`).join(';');
      return { content: `!function(){var ${a}=1,t="${token}";${filler};window.__cfg={t:t}}();\n`, needles: [token] };
    },
  },
  {
    id: 'kubernetes-secret-manifest',
    format: 'Kubernetes Secret (base64 data)',
    severity: 'high',
    path: 'deploy/secret.yaml',
    render: (rng, a) => {
      const encoded = Buffer.from(rng.string(20)).toString('base64');
      return { content: `# ${a}\napiVersion: v1\nkind: Secret\nmetadata:\n  name: app-credentials\ntype: Opaque\ndata:\n  password: ${encoded}\n`, needles: [encoded] };
    },
  },
  {
    id: 'terraform-tfvars',
    format: 'Terraform .tfvars password',
    severity: 'medium',
    path: 'infra/prod.tfvars',
    render: (rng, a) => {
      const password = rng.string(20);
      return { content: `# ${a}\nregion = "eu-west-1"\ndb_password = "${password}"\n`, needles: [password] };
    },
  },
  {
    id: 'docker-compose-env',
    format: 'docker-compose environment password',
    severity: 'medium',
    path: 'deploy/docker-compose.yml',
    render: (rng, a) => {
      const password = rng.string(20);
      return { content: `# ${a}\nservices:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${password}\n`, needles: [password] };
    },
  },
  {
    id: 'service-account-json',
    format: 'Google service-account JSON',
    severity: 'critical',
    path: 'config/service-account.json',
    render: (rng, a) => {
      const block = pemBlock(rng, 'PRIVATE KEY');
      return { content: `${JSON.stringify({ type: 'service_account', project_id: a, private_key: block.text, client_email: 'svc@example.invalid' }, null, 2)}\n`, needles: [block.needle] };
    },
  },
  {
    id: 'private-key-file-pem',
    format: 'server.pem file',
    severity: 'critical',
    path: 'certs/server.pem',
    render: (rng, a) => {
      const block = pemBlock(rng, 'RSA PRIVATE KEY');
      return { content: `# ${a}\n${block.text}\n`, needles: [block.needle] };
    },
  },
  {
    id: 'secret-in-file-name',
    format: 'token embedded in a file name',
    severity: 'low',
    path: 'exports/backup',
    inFileName: true,
    render: () => ({ content: '', needles: [] }),
  },
];

/** Deterministic canary set; every anchor is a rare lowercase token, e.g. canaryanchor07k3x. */
export function buildCanaries(seed = 'rsq-canaries'): Canary[] {
  return specs.map((spec, index) => {
    const rng = Rng.from(seed, spec.id);
    const anchor = `canaryanchor${String(index).padStart(2, '0')}${rng.string(4, 'abcdefghijklmnopqrstuvwxyz')}`;
    if (spec.inFileName) {
      const token = `ghp_${rng.string(36)}`;
      return { id: spec.id, format: spec.format, severity: spec.severity, path: `${spec.path}/${anchor}-${token}.txt`, content: `${anchor} backup manifest\n`, needles: [token], anchor, inFileName: true };
    }
    const rendered = spec.render(rng, anchor);
    return { id: spec.id, format: spec.format, severity: spec.severity, path: spec.path, content: rendered.content, needles: rendered.needles, anchor };
  });
}

/** Benign files so the repository has ordinary code to rank against, plus a control carrying a rare anchor. */
export function controlFiles(): Record<string, string> {
  return {
    'README.md': '# Sample service\n\nBilling exporter and notification worker. See docs/ for deployment notes.\n',
    'src/app.ts': 'export function startApp(port: number): string {\n  return `listening on ${port}`;\n}\n',
    'src/util.py': 'def normalize_name(value):\n    """Lower-case and trim a customer name."""\n    return value.strip().lower()\n',
    'src/control.py': 'def canaryanchorcontrol():\n    """A function without any secret, used to prove retrieval works."""\n    return "control-value-123"\n',
    'src/helper.rb': 'def format_total(amount)\n  format("%.2f", amount)\nend\n',
  };
}
