/**
 * Structure-aware chunk boundaries for files tree-sitter does not parse: documentation, configuration,
 * manifests, markup, templates, stylesheets, SQL, build scripts and schema languages.
 *
 * `chunkStructured` is pure, deterministic and dependency-free. It never throws, runs in linear time
 * (explicit stacks and depth caps instead of recursion over input) and only returns line ranges:
 * the caller is expected to add its usual line windows for full coverage.
 *
 * Limits are measured in UTF-16 code units of the decoded text (the indexer caps files at 2 MiB).
 */
import { type Scan, type StructuredSpan, Source } from './chunkers/common.js';
import { planTree } from './chunkers/plan.js';
import { scanMarkdown } from './chunkers/markdown.js';
import { scanJson } from './chunkers/json.js';
import { scanYaml } from './chunkers/yaml.js';
import { scanIni, scanProperties, scanToml } from './chunkers/ini.js';
import { scanMarkup } from './chunkers/xml.js';
import { scanConf, scanCss, scanGradle, scanGraphql, scanHcl, scanProto, scanThrift } from './chunkers/block-langs.js';
import { scanSql } from './chunkers/sql.js';
import { scanCmake, scanDockerfile, scanMakefile, scanShell } from './chunkers/buildfiles.js';

export type { StructuredSpan } from './chunkers/common.js';

export type StructuredFormat =
  | 'markdown' | 'rst' | 'adoc'
  | 'json' | 'yaml' | 'toml' | 'ini' | 'properties'
  | 'xml' | 'html' | 'vue' | 'svelte'
  | 'css' | 'scss' | 'less'
  | 'sql'
  | 'dockerfile' | 'makefile' | 'cmake' | 'gradle' | 'shell'
  | 'proto' | 'graphql' | 'thrift' | 'hcl' | 'conf';

/** Largest text any scanner accepts (the indexer itself skips files above 2 MiB). */
export const MAX_TEXT_CHARS = 4 * 1024 * 1024;
/** JSON is streamed but data dumps are rarely worth chunking; larger documents are left to line windows. */
export const MAX_JSON_CHARS = 1_572_864;

const LOCK_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'cargo.lock',
  'gemfile.lock', 'poetry.lock', 'pipfile.lock', 'go.sum', 'flake.lock', 'bun.lock', 'deno.lock',
  'packages.lock.json', 'pubspec.lock', 'mix.lock', 'podfile.lock', 'gradle.lockfile', '.terraform.lock.hcl',
  'uv.lock', 'pdm.lock', 'shrinkwrap.yaml', 'paket.lock', 'conan.lock', 'renv.lock', 'cabal.project.freeze',
]);

const BY_NAME: Record<string, StructuredFormat> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'makefile', gnumakefile: 'makefile', 'makefile.am': 'makefile',
  'cmakelists.txt': 'cmake',
  jenkinsfile: 'gradle',
  '.editorconfig': 'ini', '.gitconfig': 'ini', '.gitmodules': 'ini', '.pylintrc': 'ini', pylintrc: 'ini',
  '.flake8': 'ini', '.coveragerc': 'ini',
  pipfile: 'toml',
  '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell', '.bash_aliases': 'shell', '.zprofile': 'shell',
};

/** Extension-less tool configs that are either JSON or YAML. */
const JSON_OR_YAML = new Set(['.babelrc', '.eslintrc', '.prettierrc', '.stylelintrc', '.swcrc', '.jshintrc', '.mocharc', '.lintstagedrc', '.nycrc', '.htmlhintrc']);

const BY_EXT: Record<string, StructuredFormat> = {
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown', '.mdown': 'markdown', '.mkd': 'markdown',
  '.rst': 'rst',
  '.adoc': 'adoc', '.asciidoc': 'adoc', '.asc': 'adoc',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json', '.webmanifest': 'json', '.avsc': 'json', '.arb': 'json', '.code-workspace': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini', '.cfg': 'ini', '.service': 'ini', '.desktop': 'ini', '.repo': 'ini',
  '.properties': 'properties',
  '.xml': 'xml', '.xsd': 'xml', '.xsl': 'xml', '.xslt': 'xml', '.wsdl': 'xml', '.plist': 'xml', '.csproj': 'xml',
  '.vbproj': 'xml', '.fsproj': 'xml', '.props': 'xml', '.targets': 'xml', '.nuspec': 'xml', '.resx': 'xml',
  '.xaml': 'xml', '.axml': 'xml', '.fxml': 'xml', '.iml': 'xml', '.xib': 'xml', '.storyboard': 'xml',
  '.jrxml': 'xml', '.tld': 'xml', '.jspx': 'xml', '.dita': 'xml', '.ditamap': 'xml', '.rss': 'xml', '.atom': 'xml',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html', '.shtml': 'html', '.jsp': 'html', '.jspf': 'html',
  '.asp': 'html', '.aspx': 'html', '.cshtml': 'html', '.razor': 'html', '.erb': 'html', '.ejs': 'html',
  '.hbs': 'html', '.handlebars': 'html', '.mustache': 'html', '.njk': 'html', '.nunjucks': 'html',
  '.jinja': 'html', '.jinja2': 'html', '.j2': 'html', '.twig': 'html', '.liquid': 'html', '.tpl': 'html',
  '.tmpl': 'html', '.gotmpl': 'html', '.gohtml': 'html', '.astro': 'html',
  '.vue': 'vue', '.svelte': 'svelte',
  '.css': 'css', '.pcss': 'css', '.postcss': 'css', '.scss': 'scss', '.less': 'less',
  '.sql': 'sql', '.ddl': 'sql', '.dml': 'sql', '.psql': 'sql', '.pgsql': 'sql', '.mysql': 'sql', '.hql': 'sql',
  '.cql': 'sql', '.tsql': 'sql', '.plsql': 'sql', '.pks': 'sql', '.pkb': 'sql',
  '.mk': 'makefile', '.mak': 'makefile', '.cmake': 'cmake', '.gradle': 'gradle',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ksh': 'shell', '.bats': 'shell', '.command': 'shell', '.zsh-theme': 'shell',
  '.proto': 'proto', '.graphql': 'graphql', '.gql': 'graphql', '.graphqls': 'graphql', '.thrift': 'thrift',
  '.tf': 'hcl', '.tfvars': 'hcl', '.hcl': 'hcl', '.nomad': 'hcl',
};

function firstContentLine(text: string): string {
  const limit = Math.min(text.length, 4000);
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (pos < limit) {
    let eol = text.indexOf('\n', pos);
    if (eol < 0 || eol > limit) eol = limit;
    const line = text.slice(pos, eol).trim();
    if (line && !line.startsWith('#') && !line.startsWith(';') && !line.startsWith('//')) return line;
    pos = eol + 1;
  }
  return '';
}

/** Which structured format (if any) applies to `path`, using the content only for ambiguous names. */
export function structuredFormat(path: string, text = ''): StructuredFormat | undefined {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = path.slice(slash + 1).toLowerCase();
  if (!base || LOCK_FILES.has(base) || base.endsWith('.lock') || base.endsWith('-lock.json') || base.endsWith('-lock.yaml')) return undefined;
  if (/\.min\.[a-z]+$/.test(base) || base.endsWith('.d.ts')) return undefined;

  const named = Object.hasOwn(BY_NAME, base) ? BY_NAME[base] : undefined;
  if (named) return named;
  if (base.startsWith('dockerfile.') || base.endsWith('.dockerfile')) return 'dockerfile';
  if (base.startsWith('makefile.') && !base.endsWith('.in')) return 'makefile';
  if (base.endsWith('.gradle.kts') || base.endsWith('.jenkinsfile') || base.startsWith('jenkinsfile.')) return 'gradle';
  if (JSON_OR_YAML.has(base)) return firstContentLine(text).startsWith('{') ? 'json' : 'yaml';

  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.slice(dot);
    if (ext === '.config') return firstContentLine(text).startsWith('<') ? 'xml' : undefined;
    if (ext === '.conf') return firstContentLine(text).startsWith('[') ? 'ini' : 'conf';
    return Object.hasOwn(BY_EXT, ext) ? BY_EXT[ext] : undefined;
  }
  if (dot < 0 && /^#!\s*(?:\/usr\/bin\/env\s+)?\S*\b(?:ba|z|k|da|a)?sh\b/.test(text.replace(/^\uFEFF/, '').slice(0, 200))) return 'shell';
  return undefined;
}

type Scanner = (src: Source, path: string) => Scan | undefined;

const SCANNERS: Partial<Record<StructuredFormat, Scanner>> = {
  markdown: src => scanMarkdown(src, 'md'),
  rst: src => scanMarkdown(src, 'rst'),
  adoc: src => scanMarkdown(src, 'adoc'),
  json: (src, path) => scanJson(src, path),
  yaml: src => scanYaml(src),
  toml: src => scanToml(src),
  ini: src => scanIni(src),
  properties: src => scanProperties(src),
  xml: src => scanMarkup(src, 'xml'),
  html: src => scanMarkup(src, 'html'),
  vue: src => scanMarkup(src, 'vue'),
  svelte: src => scanMarkup(src, 'svelte'),
  css: src => scanCss(src, 'css'),
  scss: src => scanCss(src, 'scss'),
  less: src => scanCss(src, 'less'),
  hcl: src => scanHcl(src),
  proto: src => scanProto(src),
  thrift: src => scanThrift(src),
  graphql: src => scanGraphql(src),
  gradle: src => scanGradle(src),
  conf: src => scanConf(src),
  sql: src => scanSql(src),
  dockerfile: src => scanDockerfile(src),
  makefile: src => scanMakefile(src),
  cmake: src => scanCmake(src),
  shell: src => scanShell(src),
};

/**
 * Structural spans for `text`, or undefined when the path is not a supported structured format
 * (or the content is unsuitable: lockfiles, notebooks, oversized JSON). An empty array means the
 * format is supported but the file has nothing structural worth a span.
 */
export function chunkStructured(path: string, text: string): StructuredSpan[] | undefined {
  try {
    if (typeof path !== 'string' || typeof text !== 'string') return undefined;
    const format = structuredFormat(path, text);
    if (!format || text.length > (format === 'json' ? MAX_JSON_CHARS : MAX_TEXT_CHARS)) return undefined;
    const scanner = SCANNERS[format];
    if (!scanner) return undefined;
    const src = new Source(text);
    const scan = scanner(src, path);
    return scan ? planTree(src, scan.roots, scan.plan) : undefined;
  } catch {
    return undefined;
  }
}
