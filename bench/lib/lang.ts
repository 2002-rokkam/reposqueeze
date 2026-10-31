/** Language and file-kind classification used for per-language breakdowns. */
import { cmp } from './util.js';

const EXTENSION_LANGUAGE: Record<string, string> = {
  py: 'Python', pyi: 'Python', pyx: 'Python', pxd: 'Python', pxi: 'Python',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', groovy: 'Groovy',
  go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP', cs: 'C#', swift: 'Swift',
  c: 'C',
  cc: 'C++', cpp: 'C++', cxx: 'C++', 'c++': 'C++', hpp: 'C++', hh: 'C++', hxx: 'C++', ipp: 'C++', tpp: 'C++',
  vue: 'Vue', svelte: 'Svelte', sh: 'Shell', bash: 'Shell',
};

const DOC_EXTENSIONS = new Set(['md', 'markdown', 'rst', 'txt', 'adoc', 'html', 'htm', 'css', 'scss', 'less', 'svg']);
const CONFIG_EXTENSIONS = new Set([
  'json', 'yml', 'yaml', 'toml', 'cfg', 'ini', 'xml', 'gradle', 'properties', 'conf', 'lock', 'neon', 'mod', 'sum',
  'feature', 'prebuilt', 'in', 'tmpl',
]);

/** Primary language of the repositories in the supported datasets (lower-cased `owner/name`). */
export const REPO_LANGUAGE: Record<string, string> = {
  'apache/druid': 'Java', 'apache/lucene': 'Java', 'astral-sh/ruff': 'Rust', 'axios/axios': 'JavaScript',
  'babel/babel': 'JavaScript', 'briannesbitt/carbon': 'PHP', 'burntsushi/ripgrep': 'Rust', 'caddyserver/caddy': 'Go',
  'facebook/docusaurus': 'TypeScript', 'faker-ruby/faker': 'Ruby', 'fastlane/fastlane': 'Ruby', 'fluent/fluentd': 'Ruby',
  'fmtlib/fmt': 'C++', 'gin-gonic/gin': 'Go', 'gohugoio/hugo': 'Go', 'google/gson': 'Java',
  'hashicorp/terraform': 'Go', 'immutable-js/immutable-js': 'TypeScript', 'javaparser/javaparser': 'Java', 'jekyll/jekyll': 'Ruby',
  'jordansissel/fpm': 'Ruby', 'jqlang/jq': 'C', 'laravel/framework': 'PHP', 'micropython/micropython': 'C',
  'mrdoob/three.js': 'JavaScript', 'nlohmann/json': 'C++', 'nushell/nushell': 'Rust', 'php-cs-fixer/php-cs-fixer': 'PHP',
  'phpoffice/phpspreadsheet': 'PHP', 'preactjs/preact': 'JavaScript', 'projectlombok/lombok': 'Java', 'prometheus/prometheus': 'Go',
  'reactivex/rxjava': 'Java', 'redis/redis': 'C', 'rubocop/rubocop': 'Ruby', 'sharkdp/bat': 'Rust',
  'tokio-rs/axum': 'Rust', 'tokio-rs/tokio': 'Rust', 'uutils/coreutils': 'Rust', 'valkey-io/valkey': 'C',
  'vuejs/core': 'TypeScript',
  'django/django': 'Python', 'sympy/sympy': 'Python', 'matplotlib/matplotlib': 'Python', 'scikit-learn/scikit-learn': 'Python',
  'pytest-dev/pytest': 'Python', 'sphinx-doc/sphinx': 'Python', 'astropy/astropy': 'Python', 'psf/requests': 'Python',
  'pylint-dev/pylint': 'Python', 'pylint-dev/astroid': 'Python', 'pydata/xarray': 'Python', 'mwaskom/seaborn': 'Python',
  'pallets/flask': 'Python', 'pvlib/pvlib-python': 'Python', 'pydicom/pydicom': 'Python', 'sqlfluff/sqlfluff': 'Python',
  'marshmallow-code/marshmallow': 'Python', 'pyvista/pyvista': 'Python',
};

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Language implied by the extension; null for unknown or ambiguous (.h) extensions. */
export function languageOfPath(path: string): string | null {
  return EXTENSION_LANGUAGE[extensionOf(path)] ?? null;
}

export type FileKind = 'code' | 'doc' | 'config' | 'other';

export function kindOfPath(path: string): FileKind {
  const extension = extensionOf(path);
  if (extension in EXTENSION_LANGUAGE || extension === 'h') return 'code';
  if (DOC_EXTENSIONS.has(extension)) return 'doc';
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';
  return 'other';
}

export function repoLanguage(repo: string): string | null {
  return REPO_LANGUAGE[repo.toLowerCase()] ?? null;
}

/**
 * Language of an instance: the majority language of its gold code files; ties and
 * ambiguous headers fall back to the repository's primary language, then 'Other'.
 */
export function instanceLanguage(goldPaths: string[], repo: string): string {
  const fallback = repoLanguage(repo);
  const votes = new Map<string, number>();
  for (const path of goldPaths) {
    const language = languageOfPath(path) ?? (extensionOf(path) === 'h' ? fallback : null);
    if (language) votes.set(language, (votes.get(language) ?? 0) + 1);
  }
  if (!votes.size) return fallback ?? 'Other';
  const ranked = [...votes].sort((a, b) => b[1] - a[1] || (a[0] === fallback ? -1 : b[0] === fallback ? 1 : cmp(a[0], b[0])));
  return ranked[0][0];
}
