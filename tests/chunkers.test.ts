import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkStructured, structuredFormat, MAX_JSON_CHARS, MAX_TEXT_CHARS, type StructuredFormat, type StructuredSpan } from '../src/chunkers.js';
import { Source, type TreeNode } from '../src/chunkers/common.js';
import { planTree } from '../src/chunkers/plan.js';

/*
 * Golden fixtures live in tests/fixtures/chunkers/<format>/ next to a `<file>.expected` list with one line per
 * span: `start-end|kind|name|scope`. The expectations were reviewed by hand against each fixture before they were
 * frozen. Regenerate them (and review the diff!) with:  UPDATE_CHUNKER_FIXTURES=1 node --import tsx --test tests/chunkers.test.ts
 *
 * Time bounds for pathological inputs are deliberately generous (>= 20x the typical run time on an idle laptop):
 * they exist to catch super-linear behaviour, not to benchmark. Typical times are reported by scripts/chunkers-eval.ts.
 */
const BOUND_MS = { giantLine: 20_000, deepNesting: 20_000, siblings: 20_000, hostile: 15_000, garbage: 15_000 };

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/chunkers/', import.meta.url));

function listFixtures(dir = FIXTURE_ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFixtures(full));
    else if (!name.endsWith('.expected')) out.push(full);
  }
  return out;
}

const brief = (s: StructuredSpan): string => `${s.start}-${s.end}|${s.kind}|${s.name}|${s.scope ?? ''}`;

/** Invariants every result must satisfy, whatever the input. */
function assertValid(spans: StructuredSpan[] | undefined, text: string, label: string): void {
  if (spans === undefined) return;
  const lines = text.split('\n');
  let previousStart = 0;
  assert(spans.length <= Math.max(24, Math.ceil(lines.length / 3)), `${label}: too many spans (${spans.length} for ${lines.length} lines)`);
  for (const s of spans) {
    const where = `${label}: ${brief(s)}`;
    assert(Number.isInteger(s.start) && Number.isInteger(s.end), where);
    assert(s.start >= 1 && s.start <= s.end && s.end <= lines.length, `${where} outside 1..${lines.length}`);
    assert(s.start >= previousStart, `${where} not sorted by start`);
    previousStart = s.start;
    assert(typeof s.name === 'string' && s.name.length > 0 && s.name.length <= 120, `${where} bad name length ${s.name.length}`);
    assert(/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(s.kind) && !s.kind.includes('window'), `${where} bad kind`);
    if (s.scope !== undefined) assert(s.scope.length > 0 && s.scope.length <= 240, `${where} bad scope length`);
    if (s.signature !== undefined) assert(s.signature.length > 0 && s.signature.length <= 240, `${where} bad signature length`);
    if (s.refs !== undefined) {
      assert(s.refs.length > 0 && s.refs.length <= 200, `${where} bad refs count`);
      assert.equal(new Set(s.refs).size, s.refs.length, `${where} duplicate refs`);
      for (const ref of s.refs) assert(ref.length >= 2 && ref.length <= 120, `${where} bad ref ${ref.length}`);
    }
    const body = lines.slice(s.start - 1, s.end).join('\n');
    assert(body.trim().length > 0, `${where} blank chunk`);
    assert(s.end - s.start + 1 <= 80, `${where} longer than 80 lines`);
    assert(body.length <= (s.start === s.end ? 12_000 : 6000), `${where} chunk of ${body.length} characters`);
  }
}

function timed<T>(label: string, limitMs: number, run: () => T): T {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;
  assert(elapsed < limitMs, `${label} took ${elapsed.toFixed(0)} ms (bound ${limitMs} ms)`);
  return result;
}

/** Small deterministic PRNG (mulberry32): no Math.random so failures reproduce. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FORMAT_PATHS: Record<StructuredFormat, string> = {
  markdown: 'a.md', rst: 'a.rst', adoc: 'a.adoc', json: 'a.json', yaml: 'a.yaml', toml: 'a.toml', ini: 'a.ini', properties: 'a.properties',
  xml: 'a.xml', html: 'a.html', vue: 'a.vue', svelte: 'a.svelte', css: 'a.css', scss: 'a.scss', less: 'a.less', sql: 'a.sql',
  dockerfile: 'Dockerfile', makefile: 'Makefile', cmake: 'CMakeLists.txt', gradle: 'build.gradle', shell: 'a.sh', proto: 'a.proto',
  graphql: 'a.graphql', thrift: 'a.thrift', hcl: 'a.tf', conf: 'a.conf',
};
const FORMATS = Object.keys(FORMAT_PATHS) as StructuredFormat[];

// ---- golden fixtures ------------------------------------------------------------------------------

const fixtures = listFixtures();

test('there are at least four fixtures for every format', () => {
  const perFormat = new Map<string, number>();
  for (const file of fixtures) {
    const format = structuredFormat(file, readFileSync(file, 'utf8'));
    assert(format, `unsupported fixture ${file}`);
    // CSS, SCSS and Less share one scanner and are counted as one family.
    const family = format === 'scss' || format === 'less' ? 'css' : format;
    perFormat.set(family, (perFormat.get(family) ?? 0) + 1);
  }
  // rst, adoc and conf are extras beyond the required format list; they carry fewer fixtures.
  const extras = new Set(['rst', 'adoc', 'conf', 'vue', 'svelte', 'scss', 'less']);
  for (const format of FORMATS) {
    if (format === 'scss' || format === 'less') continue;
    if (extras.has(format)) assert((perFormat.get(format) ?? 0) >= 1, format);
    else assert((perFormat.get(format) ?? 0) >= (format === 'html' ? 3 : 4), `${format}: ${perFormat.get(format) ?? 0} fixtures`);
  }
});

for (const file of fixtures) {
  const rel = relative(FIXTURE_ROOT, file);
  test(`fixture ${rel}`, () => {
    const text = readFileSync(file, 'utf8');
    const spans = chunkStructured(file, text);
    assert(spans, 'format not recognised');
    assertValid(spans, text, rel);
    const actual = spans.map(brief).join('\n') + '\n';
    const expectedFile = `${file}.expected`;
    if (process.env.UPDATE_CHUNKER_FIXTURES) writeFileSync(expectedFile, actual);
    assert(existsSync(expectedFile), `missing ${expectedFile}`);
    assert.equal(actual, readFileSync(expectedFile, 'utf8'));
    // Identical input, identical output.
    assert.deepEqual(chunkStructured(file, text), spans);
  });
}

test('CRLF, BOM and trailing-newline variants of every fixture give the same spans', () => {
  for (const file of fixtures) {
    const text = readFileSync(file, 'utf8');
    const base = chunkStructured(file, text)!;
    const crlf = chunkStructured(file, text.replace(/\n/g, '\r\n'))!;
    assert.deepEqual(crlf, base, `CRLF ${relative(FIXTURE_ROOT, file)}`);
    const bom = chunkStructured(file, '\uFEFF' + text)!;
    assert.deepEqual(bom.map(brief), base.map(brief), `BOM ${relative(FIXTURE_ROOT, file)}`);
    const trailing = chunkStructured(file, text + '\n\n\n')!;
    assert.deepEqual(trailing.map(brief), base.map(brief), `trailing newlines ${relative(FIXTURE_ROOT, file)}`);
  }
});

test('mixed tabs and spaces never break the invariants', () => {
  for (const file of fixtures) {
    const text = readFileSync(file, 'utf8').replace(/^( {2})+/gm, m => '\t'.repeat(m.length / 2)).replace(/^ {4}/gm, '  \t');
    assertValid(chunkStructured(file, text), text, `tabs ${relative(FIXTURE_ROOT, file)}`);
  }
});

// ---- targeted expectations beyond names and ranges --------------------------------------------------

function fixture(name: string): { path: string; text: string; spans: StructuredSpan[] } {
  const path = join(FIXTURE_ROOT, name);
  const text = readFileSync(path, 'utf8');
  return { path, text, spans: chunkStructured(path, text)! };
}

const byName = (spans: StructuredSpan[], name: string): StructuredSpan => {
  const found = spans.find(s => s.name === name);
  assert(found, `no span named ${name}`);
  return found;
};

test('markdown: headings, fences and tables', () => {
  const { spans } = fixture('markdown/readme.md');
  assert(!spans.some(s => s.kind === 'md_section' && s.name.includes('comment, not a heading')));
  assert.equal(byName(spans, 'Docker').scope, 'Squeezer > Installation > Docker');
  assert.deepEqual(byName(spans, 'Usage').refs, ['--budget'.slice(2), 'json', 'root', 'map', 'Engine.context', 'docs/ARCHITECTURE.md', 'ARCHITECTURE'].filter(r => byName(spans, 'Usage').refs!.includes(r)));
  assert(byName(spans, 'Usage').refs!.includes('Engine.context'));
  assert(byName(spans, 'Usage').refs!.includes('docs/ARCHITECTURE.md'));
  const setext = fixture('markdown/frontmatter-setext.md').spans;
  assert.equal(setext[0].kind, 'md_frontmatter');
  assert.equal(setext[0].name, 'Getting started: the basics');
  assert.equal(byName(setext, 'Setup guide').scope, 'Setup guide');
  assert(!setext.some(s => s.name.includes('Commented out')));
  const fence = fixture('markdown/unterminated-fence.md').spans;
  assert.deepEqual(fence.map(s => s.name), ['Overview']);
});

test('json: package.json entries, JSON with comments and OpenAPI operations', () => {
  const pkg = fixture('json/package.json').spans;
  assert.equal(byName(pkg, 'scripts.build').start, 8);
  assert.equal(byName(pkg, 'scripts.build').end, 8);
  assert.equal(byName(pkg, 'scripts.build').scope, 'scripts > build');
  assert.deepEqual(byName(pkg, 'scripts.build').refs, ['build']);
  const jsonc = fixture('json/tsconfig.jsonc').spans;
  assert.deepEqual(jsonc.map(s => s.name), ['compilerOptions', 'references']);
  const api = fixture('json/openapi.json').spans;
  assert.equal(byName(api, 'GET /pets listPets').scope, 'paths > /pets > get');
  assert.equal(byName(api, 'POST /pets createPet').start, 26);
  assert.equal(byName(api, 'GET /pets/{petId} showPetById').scope, 'paths > /pets/{petId}');
  assert(byName(api, 'paths').refs!.includes('Pets'));
  const users = fixture('json/users.json').spans;
  assert.deepEqual(users.map(s => s.kind), ['json_item', 'json_item', 'json_item', 'json_item']);
});

test('yaml: Kubernetes documents, workflows and OpenAPI', () => {
  const k8s = fixture('yaml/k8s-multidoc.yaml').spans;
  assert.deepEqual(k8s.filter(s => s.kind === 'yaml_doc').map(s => s.name), ['Deployment/checkout', 'Service/checkout', 'ConfigMap/checkout-config']);
  const flow = fixture('yaml/workflow.yml').spans;
  assert(byName(flow, 'jobs.test.steps').refs!.includes('actions/checkout'));
  assert(byName(flow, 'jobs.test.steps').refs!.includes('upload-artifact'));
  const api = fixture('yaml/openapi.yaml').spans;
  assert.equal(byName(api, 'GET /orders listOrders').scope, 'paths > /orders > get');
  assert.equal(byName(api, 'DELETE /orders/{orderId} cancelOrder').kind, 'yaml_key');
  const compose = fixture('yaml/docker-compose.yml').spans;
  assert(byName(compose, 'services.web').refs!.includes('web'));
  const tricky = fixture('yaml/tricky.yml').spans;
  assert.equal(byName(tricky, 'production').end, 25);
});

test('xml: Maven coordinates, Spring beans and AEM/JCR nodes', () => {
  const pom = fixture('xml/pom.xml').spans;
  const dependency = byName(pom, 'dependency org.postgresql:postgresql');
  assert.equal(dependency.scope, 'project > dependencies > dependency');
  assert.deepEqual(dependency.refs, ['org.postgresql', 'postgresql']);
  assert.equal(dependency.signature, '<dependency>');
  const beans = fixture('xml/beans.xml').spans;
  assert.deepEqual(byName(beans, 'bean invoiceService').refs, ['invoiceService', 'com.acme.billing.InvoiceService', 'InvoiceService', 'invoiceRepository', 'taxCalculator']);
  const page = fixture('xml/aem-page/.content.xml').spans;
  const hero = byName(page, 'hero Welcome to ACME');
  assert.equal(hero.signature, '<hero jcr:primaryType="nt:unstructured" sling:resourceType="acme/components/hero" fragmentPath="/content/dam/acme/fragments/hero-home" jcr:title="Welcome to ACME">');
  assert.deepEqual(hero.refs, ['acme/components/hero', 'hero', '/content/dam/acme/fragments/hero-home', 'hero-home']);
  assert(byName(page, 'jcr:root cq:Page').refs!.includes('/conf/acme/settings/wcm/templates/content-page'));
  const dialog = fixture('xml/aem-dialog/.content.xml').spans;
  assert.equal(byName(dialog, 'title ./jcr:title').scope, 'jcr:root > content > tabs > properties > title');
  const android = fixture('xml/activity_main.xml').spans;
  assert.deepEqual(byName(android, 'Button submit_button').refs?.slice(0, 2), ['@+id/submit_button', 'submit_button']);
  assert(byName(android, 'Button submit_button').refs!.includes('@string/submit'));
});

test('html and templates: scripts, SFC blocks, template directives and HTL', () => {
  const page = fixture('html/index.html').spans;
  assert.equal(byName(page, 'script').kind, 'html_script');
  assert.equal(byName(page, 'nav#main-nav').start, 13);
  assert(!page.some(s => s.name.includes('is not a tag')));
  const vue = fixture('html/TodoApp.vue').spans;
  assert.deepEqual(vue.map(s => s.kind), ['vue_block', 'vue_block', 'vue_block']);
  assert.deepEqual(vue.map(s => s.name), ['template', 'script lang=ts setup', 'style lang=scss scoped']);
  const svelte = fixture('html/Catalog.svelte').spans;
  assert(svelte.some(s => s.kind === 'tpl_block' && s.name === 'if visible.length === 0'));
  const django = fixture('html/orders.html').spans;
  assert.deepEqual(django.filter(s => s.kind === 'tpl_block').map(s => s.name), ['block extrastyle', 'block content', 'block footer']);
  const hbs = fixture('html/layout.hbs').spans;
  assert(hbs.some(s => s.name === 'if user' && s.kind === 'tpl_block'));
  const htl = fixture('html/hero.html').spans;
  assert.equal(byName(htl, 'template cta').kind, 'html_template');
  assert(byName(htl, 'div.cmp-hero').refs!.includes('com.acme.core.models.HeroModel'));
  assert(byName(htl, 'div.cmp-hero').refs!.includes('HeroModel'));
});

test('stylesheets: rules, at-rules, mixins and literals that contain braces', () => {
  const css = fixture('css/site.css').spans;
  assert.equal(byName(css, '@media (max-width: 768px)').kind, 'css_at_rule');
  assert.equal(byName(css, '.btn').start, 18);
  const scss = fixture('css/theme.scss').spans;
  assert.equal(byName(scss, '@mixin respond').kind, 'css_mixin');
  assert.equal(byName(scss, '@function rem').kind, 'css_function');
  assert.equal(byName(scss, '&__title').scope, '.card > &__title');
  assert(byName(scss, '.card').refs!.includes('card-base'));
  const less = fixture('css/mixins.less').spans;
  assert.equal(byName(less, '.bordered(@width: 1px; @style: solid)').kind, 'css_mixin');
  const tricky = fixture('css/animations.css').spans;
  assert.equal(byName(tricky, '.tooltip::after').end, 26);
});

test('sql: statements, labels, dollar quoting, GO batches and DELIMITER', () => {
  const init = fixture('sql/V1__init.sql').spans;
  assert.equal(byName(init, 'idx_users_email').scope, 'create index');
  assert.deepEqual(byName(init, 'open_orders').refs, ['open_orders', 'orders', 'users', 'u.id']);
  const sqlc = fixture('sql/queries.sql').spans;
  assert.deepEqual(sqlc.map(s => s.name), ['GetAuthor', 'ListAuthors', 'CreateAuthor', 'UpdateAuthor', 'DeleteAuthor']);
  assert.equal(byName(sqlc, 'GetAuthor').scope, 'select');
  const dump = fixture('sql/dump.sql').spans;
  assert.equal(byName(dump, 'public.touch_updated_at').end, 17);
  assert.equal(byName(dump, 'copy public.accounts').end, 32);
  const tsql = fixture('sql/procedures.sql').spans;
  assert.deepEqual(tsql.map(s => s.name), ['use reporting', 'dbo.usp_GetOrderTotals', 'dbo.fn_TaxRate']);
  const mysql = fixture('sql/mysql-delimiter.sql').spans;
  assert.deepEqual(mysql.map(s => s.scope), ['create table', 'create procedure', 'create trigger']);
});

test('build files: Docker stages, make targets, CMake blocks and shell functions', () => {
  const docker = fixture('dockerfile/Dockerfile').spans;
  assert.deepEqual(docker.map(s => s.name), ['builder', 'runtime']);
  assert.equal(byName(docker, 'builder').start, 4);
  assert.deepEqual(byName(docker, 'runtime').refs, ['node', 'runtime', 'NODE_ENV', 'builder', '/app/dist', '/app/node_modules']);
  const heredoc = fixture('dockerfile/heredoc.dockerfile').spans;
  assert.deepEqual(heredoc.map(s => s.name), ['base', 'app']);
  const make = fixture('makefile/Makefile').spans;
  assert.deepEqual(make.map(s => s.kind), ['make_variable', 'make_variable', 'make_target', 'make_target', 'make_target', 'make_target', 'make_target', 'make_define', 'make_target']);
  assert.equal(byName(make, 'build/%.o').start, 18);
  assert.equal(byName(make, 'bin/app').refs, undefined);
  const cmake = fixture('cmake/CMakeLists.txt').spans;
  assert.equal(byName(cmake, 'widget_add_tool').kind, 'cmake_function');
  assert.equal(byName(cmake, 'if(WIDGET_BUILD_TESTS)').kind, 'cmake_block');
  const shell = fixture('shell/deploy.sh').spans;
  assert.deepEqual(shell.map(s => s.name), ['usage', 'build_image', 'push_image', 'main']);
  assert(!fixture('shell/lib.bash').spans.some(s => s.name === 'not_a_function'));
  const nested = fixture('shell/install.sh').spans;
  assert.deepEqual(nested.map(s => s.name), ['fetch', 'install_all']);
  assert.equal(fixture('shell/loop').spans.length, 0);
});

test('schema languages: protobuf, GraphQL, Thrift, HCL and Gradle', () => {
  const proto = fixture('proto/shop.proto').spans;
  assert.equal(byName(proto, 'Order').kind, 'proto_message');
  assert.equal(byName(proto, 'Status').scope, 'Order > Status');
  assert(byName(proto, 'GetOrderRequest').start === 42);
  assert(byName(proto, 'OrderService').refs!.includes('CreateOrderRequest'));
  const graphql = fixture('graphql/schema.graphql').spans;
  assert.equal(byName(graphql, 'User').start, 1);
  assert.equal(byName(graphql, 'SearchResult').kind, 'graphql_union');
  assert.equal(fixture('graphql/operations.graphql').spans[4].name, 'query');
  const thrift = fixture('thrift/billing.thrift').spans;
  assert.equal(byName(thrift, 'BillingService').kind, 'thrift_service');
  assert.equal(byName(thrift, 'BillingService').start, 33);
  const hcl = fixture('hcl/main.tf').spans;
  assert.equal(byName(hcl, 'aws_s3_bucket.assets').start, 23);
  assert(byName(hcl, 'aws_s3_bucket_versioning.assets').refs!.includes('aws_s3_bucket.assets'));
  assert(!hcl.some(s => s.name.includes('fake')));
  const gradle = fixture('gradle/build.gradle').spans;
  assert.equal(byName(gradle, 'tasks.register printVersion').kind, 'gradle_block');
  assert(byName(gradle, 'dependencies').refs!.includes('com.google.guava:guava'));
  const jenkins = fixture('gradle/Jenkinsfile').spans;
  assert.deepEqual(jenkins.filter(s => s.name.startsWith('stage ')).map(s => s.name), ['stage Build', 'stage Test', 'stage Deploy']);
});

test('config files: TOML tables, INI sections and properties groups', () => {
  const cargo = fixture('toml/Cargo.toml').spans;
  assert.equal(byName(cargo, 'dependencies').scope, 'dependencies');
  assert.deepEqual(byName(cargo, 'dependencies').refs, ['bytes', 'thiserror', 'widget-types', 'serde', 'tokio']);
  assert(byName(fixture('toml/pyproject.toml').spans, 'tool.poetry.dependencies').scope === 'tool > poetry > dependencies');
  assert.equal(byName(fixture('toml/netlify.toml').spans, 'redirects[1]').start, 15);
  const php = fixture('ini/php.ini').spans;
  assert.equal(byName(php, 'memory_limit').start, 11);
  const props = fixture('properties/application.properties').spans;
  assert.deepEqual(props.map(s => s.start), [1, 6, 13, 18]);
  assert(props[1].refs!.includes('org.postgresql.Driver'));
  assert(props[1].refs!.includes('DB_PASSWORD'));
});

// ---- dispatch ---------------------------------------------------------------------------------------

test('format detection by name, extension and content', () => {
  const cases: [string, StructuredFormat | undefined, string?][] = [
    ['README.md', 'markdown'], ['docs/guide.MDX', 'markdown'], ['x.rst', 'rst'], ['x.adoc', 'adoc'],
    ['package.json', 'json'], ['tsconfig.json', 'json'], ['a/b/.eslintrc.json', 'json'], ['.babelrc', 'json', '{ "presets": [] }'], ['.babelrc', 'yaml', 'presets:\n  - env\n'],
    ['ci.yml', 'yaml'], ['values.YAML', 'yaml'], ['Cargo.toml', 'toml'], ['Pipfile', 'toml'], ['setup.cfg', 'ini'], ['.editorconfig', 'ini'],
    ['app.properties', 'properties'], ['pom.xml', 'xml'], ['a/.content.xml', 'xml'], ['App.csproj', 'xml'], ['web.config', 'xml', '<?xml version="1.0"?><configuration/>'],
    ['web.config', undefined, 'not xml'], ['index.html', 'html'], ['page.jsp', 'html'], ['x.vue', 'vue'], ['x.svelte', 'svelte'], ['x.hbs', 'html'],
    ['a.css', 'css'], ['a.scss', 'scss'], ['a.less', 'less'], ['a.sql', 'sql'], ['Dockerfile', 'dockerfile'], ['Dockerfile.dev', 'dockerfile'],
    ['api.Dockerfile', 'dockerfile'], ['Makefile', 'makefile'], ['common.mk', 'makefile'], ['CMakeLists.txt', 'cmake'], ['x.cmake', 'cmake'],
    ['build.gradle', 'gradle'], ['build.gradle.kts', 'gradle'], ['Jenkinsfile', 'gradle'], ['run.sh', 'shell'], ['bin/tool', 'shell', '#!/usr/bin/env bash\necho hi\n'],
    ['bin/tool', undefined, 'echo hi\n'], ['a.proto', 'proto'], ['a.graphql', 'graphql'], ['a.gql', 'graphql'], ['a.thrift', 'thrift'], ['main.tf', 'hcl'],
    ['nginx.conf', 'conf', 'worker_processes 1;'], ['supervisord.conf', 'ini', '[supervisord]\nnodaemon=true'],
    // not structured, or deliberately declined
    ['notes.txt', undefined], ['image.png', undefined], ['data.csv', undefined], ['analysis.ipynb', undefined], ['app.min.css', undefined],
    ['package-lock.json', undefined], ['yarn.lock', undefined], ['pnpm-lock.yaml', undefined], ['composer.lock', undefined], ['Cargo.lock', undefined],
    ['poetry.lock', undefined], ['go.sum', undefined], ['Gemfile.lock', undefined], ['logo.svg', undefined], ['x.jsonl', undefined], ['index.d.ts', undefined],
    ['', undefined], ['constructor', undefined], ['toString.json', 'json'], ['__proto__', undefined],
  ];
  for (const [path, expected, text] of cases) assert.equal(structuredFormat(path, text ?? ''), expected, `${path}`);
});

test('unsupported paths, lockfiles, notebooks and huge JSON return undefined; empty files return []', () => {
  assert.equal(chunkStructured('notes.txt', '# not markdown'), undefined);
  assert.equal(chunkStructured('package-lock.json', '{"lockfileVersion": 3}\n'.repeat(3)), undefined);
  assert.equal(chunkStructured('notebook.ipynb', '{"cells": []}'), undefined);
  assert.equal(chunkStructured('big.json', '[' + '1,'.repeat(MAX_JSON_CHARS / 2) + '1]'), undefined);
  assert.notEqual(chunkStructured('ok.json', '[' + '1,'.repeat(1000) + '1]'), undefined);
  assert.deepEqual(chunkStructured('empty.md', ''), []);
  assert.deepEqual(chunkStructured('empty.json', ''), []);
  assert.deepEqual(chunkStructured('empty.xml', ''), []);
  assert.equal(chunkStructured('x.md', undefined as unknown as string), undefined);
  assert.equal(chunkStructured(undefined as unknown as string, 'x'), undefined);
  assert.equal(chunkStructured('huge.md', 'a\n'.repeat(MAX_TEXT_CHARS)), undefined);
});

// ---- planner (white box) ----------------------------------------------------------------------------

function nodes(text: string, tree: TreeNode[]): { src: Source; tree: TreeNode[] } {
  return { src: new Source(text), tree };
}

const rows = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const node = (start: number, end: number, name: string, children: TreeNode[] = [], extra: Partial<TreeNode> = {}): TreeNode => ({ start, end, name, kind: 'test_node', children, ...extra });

test('planner: a node that fits becomes one span; large children get nested detail spans', () => {
  const { src, tree } = nodes(rows(60), [node(1, 60, 'outer', [node(5, 14, 'a'), node(20, 30, 'b'), node(31, 59, 'wrapper', [node(32, 40, 'deep')])])]);
  const spans = planTree(src, tree);
  assert.deepEqual(spans.map(s => `${s.start}-${s.end} ${s.name} [${s.scope}]`), [
    '1-60 outer [outer]',
    '5-14 a [outer > a]',
    '20-30 b [outer > b]',
    '31-59 wrapper [outer > wrapper]',
    '32-40 deep [outer > wrapper > deep]',
  ]);
});

test('planner: oversized nodes are split along their children; tiny siblings are merged', () => {
  const kids: TreeNode[] = [];
  for (let i = 0; i < 50; i++) kids.push(node(10 + i * 2, 10 + i * 2, `k${i}`));
  const { src, tree } = nodes(rows(130), [node(1, 130, 'big', [node(2, 9, 'head'), ...kids, node(111, 125, 'tail')])]);
  const spans = planTree(src, tree);
  assert(spans.every(s => s.end - s.start + 1 <= 80));
  assert.equal(spans[0].name, 'head');
  const merged = spans.filter(s => s.name.startsWith('k0'));
  assert.equal(merged.length, 1);
  assert(merged[0].end - merged[0].start + 1 <= 40, 'merged runs stay within mergeLines');
  assert(spans.some(s => s.name === 'tail'));
  // Lines 126-130 belong to no child; they come back as a residual span of the oversized owner.
  assert.equal(spans[spans.length - 1].name, 'big');
  assert(spans.every(s => s.scope === 'big' || s.scope === 'big > head' || s.scope === 'big > tail'));
});

test('planner: nodes without children are cut into even pieces at blank lines', () => {
  const text = Array.from({ length: 200 }, (_, i) => (i % 50 === 49 ? '' : `row ${i}`)).join('\n');
  const spans = planTree(new Source(text), [node(1, 200, 'table')]);
  assert(spans.length >= 3 && spans.length <= 4);
  for (const s of spans) assert(s.end - s.start + 1 <= 80 && s.name === 'table');
  for (let i = 1; i < spans.length; i++) assert(spans[i].start > spans[i - 1].end - 1);
});

test('planner: character budget bounds dense lines; a single enormous line is skipped', () => {
  const dense = Array.from({ length: 40 }, () => 'x'.repeat(500)).join('\n');
  const spans = planTree(new Source(dense), [node(1, 40, 'dense')]);
  for (const s of spans) assert((s.end - s.start + 1) * 501 <= 6000 + 501);
  assert(spans.length >= 4);
  assert.deepEqual(planTree(new Source('x'.repeat(50_000)), [node(1, 1, 'minified')]), []);
});

test('planner: wrappers with an empty scope name never become spans; anchors and forced nodes do', () => {
  const text = rows(40);
  const wrapper = node(2, 39, 'items', [node(3, 9, 'first'), node(10, 17, 'second')], { scopeName: '' });
  const spans = planTree(new Source(text), [node(1, 40, 'root', [wrapper])]);
  assert.deepEqual(spans.map(s => s.name), ['root', 'first', 'second']);
  assert.equal(spans[1].scope, 'root > first');
  const anchored = planTree(new Source(rows(10)), [node(2, 2, 'one', [], { anchor: true }), node(5, 5, 'two', [], { anchor: true }), node(7, 7, 'noise')]);
  assert.deepEqual(anchored.map(s => s.name), ['one', 'two']);
  const forced = planTree(new Source(rows(40)), [node(1, 40, 'map', [node(2, 2, 'k1', [], { force: true }), node(3, 3, 'k2', [], { force: true })])]);
  assert.deepEqual(forced.map(s => s.name), ['map', 'k1', 'k2']);
});

test('planner: the span cap prunes nested detail spans first and results stay sorted', () => {
  const kids: TreeNode[] = [];
  for (let i = 0; i < 40; i++) kids.push(node(2 + i * 3, 4 + i * 3, `c${i}`));
  const { src, tree } = nodes(rows(125), [node(1, 125, 'root', kids)]);
  const spans = planTree(src, tree, { maxLines: 200, maxChars: 100_000 });
  assert(spans.length <= Math.max(24, Math.ceil(125 / 3)));
  assert.equal(spans[0].name, 'root');
  for (let i = 1; i < spans.length; i++) assert(spans[i].start >= spans[i - 1].start);
});

// ---- robustness ---------------------------------------------------------------------------------------

test('binary garbage and random token soup never throw and always satisfy the invariants', () => {
  const random = prng(1234);
  for (const format of FORMATS) {
    const path = FORMAT_PATHS[format];
    const bytes = Buffer.alloc(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
    for (const encoding of ['latin1', 'utf8'] as const) {
      const text = bytes.toString(encoding);
      timed(`garbage ${path}`, BOUND_MS.garbage, () => assertValid(chunkStructured(path, text), text, `garbage ${path}`));
    }
  }
});

const VOCABULARY = [
  '{', '}', '[', ']', '(', ')', '<', '>', '"', "'", '`', '#', '##', '###', '---', '...', '===', '```', '~~~', '<!--', '-->', '/*', '*/', '//', '--', ';', ',', ':', '=',
  '|', '\\', '$', '${', '$(', '<<EOF', 'EOF', '\n', '\n', '\n', '\n', '  ', '\t', ' ', 'a', 'b', 'key', 'value', '- ', '<a>', '</a>', '<a/>', '<b x="1">', '{{#if x}}', '{{/if}}',
  '{% block x %}', '{% endblock %}', 'FROM x', 'RUN x', 'CREATE TABLE t (', 'BEGIN', 'END', 'function f {', 'message M {', 'type T {', 'resource "a" "b" {', 'define X',
  'endef', 'if(x)', 'endif()', 'DELIMITER //', 'GO', '$$', '@media x', '.cls', 'jobs:', '[section]', 'k = v', 'k=v', '<![CDATA[', ']]>', '<?x', '?>', '\r\n', '\u00e9\u4e2d',
];

test('random token soup in every format keeps the invariants and finishes quickly', () => {
  const random = prng(99);
  for (const format of FORMATS) {
    const path = FORMAT_PATHS[format];
    for (let round = 0; round < 12; round++) {
      const parts: string[] = [];
      const count = 20 + Math.floor(random() * 2500);
      for (let i = 0; i < count; i++) parts.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)]);
      const text = parts.join(random() < 0.3 ? '' : ' ');
      timed(`soup ${path}`, BOUND_MS.hostile, () => assertValid(chunkStructured(path, text), text, `soup ${path} #${round}`));
    }
  }
});

test('mutated fixtures (deleted, duplicated and inserted characters) keep the invariants', () => {
  const random = prng(7);
  for (const file of fixtures) {
    const original = readFileSync(file, 'utf8');
    for (let round = 0; round < 6; round++) {
      let text = original;
      for (let edit = 0; edit < 1 + Math.floor(random() * 6); edit++) {
        const at = Math.floor(random() * (text.length + 1));
        const kind = random();
        if (kind < 0.4) text = text.slice(0, at) + text.slice(at + 1 + Math.floor(random() * 40));
        else if (kind < 0.7) text = text.slice(0, at) + text.slice(Math.max(0, at - 30), at) + text.slice(at);
        else text = text.slice(0, at) + VOCABULARY[Math.floor(random() * VOCABULARY.length)] + text.slice(at);
      }
      assertValid(chunkStructured(file, text), text, `mutated ${relative(FIXTURE_ROOT, file)} #${round}`);
    }
  }
});

const UNTERMINATED: [string, string][] = [
  ['a.json', '{"a": "unterminated string\n"b": [1, 2'], ['a.json', '{"a": /* open comment'], ['a.xml', '<a><b attr="x\n<c>text'], ['a.xml', '<!-- open comment <a>'],
  ['a.xml', '<![CDATA[ never closed <a>'], ['a.html', '<div class="x><p>unterminated attribute</div>'], ['a.html', '<script>var s = "</script'], ['a.md', '```js\nfence never closed\n# heading'],
  ['a.md', '---\ntitle: front matter never closed\n# Heading'], ['a.yaml', 'a: "never closed\nb: [1, 2\nc: |\n  block'], ['a.toml', '[table\nkey = """never closed\n'],
  ['a.css', '.a { color: red; /* never closed'], ['a.scss', '.a { b: url(unclosed'], ['a.sql', "SELECT 'never closed;\nSELECT 2;"], ['a.sql', 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN'],
  ['a.sh', 'f() {\n  echo "never closed\n}'], ['a.sh', 'cat <<EOF\nnever terminated\n'], ['Makefile', 'define X\nnever ended'], ['CMakeLists.txt', 'add_library(a\n  b.cpp\n'],
  ['Dockerfile', 'RUN <<EOF\nnever terminated\n'], ['a.tf', 'resource "a" "b" {\n  x = "${never closed\n'], ['a.tf', 'x = <<EOT\nnever terminated'], ['a.graphql', '"""never closed\ntype T {'],
  ['a.proto', 'message M {\n  string s = 1 [default = "open\n'], ['a.html', '{% block x %}{% if y %}<div>'], ['a.html', '{{#each x}}{{#if y}}'], ['a.svelte', '{#if x}<p>{#each y}'],
  ['a.properties', 'key=value \\\n'], ['a.ini', '[section\nkey'], ['a.adoc', '----\nlisting never closed\n== heading'], ['a.rst', 'Title\n=====\n\n.. code::\n\n   indented'],
];

test('unterminated strings, comments, tags, fences and blocks are tolerated', () => {
  for (const [path, text] of UNTERMINATED) assertValid(chunkStructured(path, text), text, `unterminated ${path}: ${JSON.stringify(text.slice(0, 30))}`);
});

/** Text of about `size` characters made by repeating `unit` (no newline unless the unit has one). */
const repeatTo = (unit: string, size: number): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

test('a single very long line is handled quickly in every format (3.5 MB below the cap, 5 MB above it)', () => {
  const units: Record<string, string> = {
    'a.md': 'word `code` [link](x) ', 'a.rst': 'word ``code`` ', 'a.adoc': 'word xref:x[y] ', 'a.yaml': 'a: [1, 2], ', 'a.toml': 'a = 1 ', 'a.ini': 'a=1;', 'a.properties': 'a=1 ',
    'a.xml': '<a b="c">x</a>', 'a.html': '<p class="x">y</p>{% if z %}', 'a.vue': '<template><i/></template>', 'a.svelte': '{#if x}<b/>{/if}', 'a.css': 'a{b:c}', 'a.scss': 'a{b:#{c}}', 'a.less': '.a(@b){c:@{d}}',
    'a.sql': "SELECT 'a;' FROM t;", 'Dockerfile': 'RUN a \\ ', 'Makefile': 'a: b; c ', 'CMakeLists.txt': 'set(a b) ', 'build.gradle': 'a { b "c${d}" }', 'a.sh': 'f() { echo "$(g)"; } ',
    'a.proto': 'message A { int32 b = 1; } ', 'a.graphql': 'type A { b: C } ', 'a.thrift': 'struct A { 1: i32 b } ', 'a.tf': 'a "b" { c = "${d}" } ', 'a.conf': 'a { b c; } ',
  };
  for (const [path, unit] of Object.entries(units)) {
    const medium = repeatTo(unit, 3_500_000);
    timed(`3.5 MB line ${path}`, BOUND_MS.giantLine, () => assertValid(chunkStructured(path, medium), medium, `long line ${path}`));
    const huge = repeatTo(unit, 5 * 1024 * 1024);
    assert.equal(timed(`5 MB line ${path}`, BOUND_MS.giantLine, () => chunkStructured(path, huge)), undefined);
  }
  const json = '[' + '{"a":1},'.repeat(180_000) + '{}]';
  assert(json.length < MAX_JSON_CHARS);
  timed('1.4 MB single-line JSON', BOUND_MS.giantLine, () => assertValid(chunkStructured('a.json', json), json, 'single-line json'));
});

test('very deep nesting (20,000 levels) uses explicit stacks and depth caps', () => {
  const depth = 20_000;
  const cases: [string, string][] = [
    ['a.json', '['.repeat(depth) + ']'.repeat(depth)], ['a.json', '{"a":'.repeat(depth)], ['a.xml', '<a>\n'.repeat(depth) + '</a>\n'.repeat(depth)],
    ['a.xml', '<a>'.repeat(depth)], ['a.html', '<div>\n'.repeat(depth)], ['a.html', '{% if x %}\n'.repeat(depth)], ['a.css', 'a {\n'.repeat(depth) + '}\n'.repeat(depth)],
    ['a.scss', '.a { &:hover {\n'.repeat(depth)], ['a.tf', 'a {\n'.repeat(depth)], ['a.proto', 'message A {\n'.repeat(depth)], ['a.graphql', 'type A {\n'.repeat(depth)],
    ['build.gradle', 'a {\n'.repeat(depth)], ['a.sql', '('.repeat(depth)], ['a.sql', 'CREATE PROCEDURE p AS\nBEGIN\n'.repeat(depth)], ['CMakeLists.txt', 'if(x)\n'.repeat(depth)],
    ['a.sh', 'f() {\n'.repeat(depth)], ['a.sh', 'case x in\n'.repeat(depth)], ['a.svelte', '{#if x}\n'.repeat(depth)], ['a.html', '{{#if x}}\n'.repeat(depth)],
    ['a.yaml', Array.from({ length: 1500 }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n')], ['a.yaml', '- '.repeat(depth)], ['a.md', '> '.repeat(depth) + 'x'],
    ['a.md', '#'.repeat(depth)], ['a.toml', '['.repeat(depth)], ['a.ini', '['.repeat(depth)],
  ];
  for (const [path, text] of cases) timed(`deep ${path}`, BOUND_MS.deepNesting, () => assertValid(chunkStructured(path, text), text, `deep ${path}`));
});

test('100,000 sibling elements stay linear and produce merged runs, not 100,000 spans', () => {
  const n = 100_000;
  const cases: [string, string, number][] = [
    ['a.xml', '<root>\n' + '<i a="1"/>\n'.repeat(n) + '</root>', 4000], ['a.xml', '<root>\n' + '<i>\n</i>\n'.repeat(n / 2) + '</root>', n],
    ['a.html', '<ul>\n' + '<li>x</li>\n'.repeat(n) + '</ul>', 4000], ['a.json', '[\n' + '{"a":1},\n'.repeat(n / 2) + '{}\n]', 4000],
    ['a.json', '{\n' + Array.from({ length: 60_000 }, (_, i) => `"k${i}": ${i}`).join(',\n') + '\n}', 4000], ['a.yaml', 'a:\n' + '  k: v\n'.repeat(n), 4000],
    ['a.md', '# h\n'.repeat(n), 4000], ['a.sql', 'INSERT INTO t VALUES (1);\n'.repeat(n), 4000], ['a.css', 'a{b:c}\n'.repeat(n), 4000],
    ['a.properties', Array.from({ length: n }, (_, i) => `k${i}=v`).join('\n'), 26_000], ['a.toml', Array.from({ length: n }, (_, i) => `k${i} = 1`).join('\n'), 4000],
    ['a.ini', Array.from({ length: n }, (_, i) => `[s${i}]\nk=v`).join('\n'), n], ['a.tf', 'variable "x" {}\n'.repeat(n / 2), n], ['a.proto', 'message M { int32 a = 1; }\n'.repeat(n / 2), n],
    ['Dockerfile', 'RUN echo\n'.repeat(n), 4000], ['Makefile', 'a:\n\tb\n'.repeat(n / 2), n], ['a.sh', 'f() { :; }\n'.repeat(n / 2), 4000],
    ['CMakeLists.txt', 'set(a b)\n'.repeat(n), 4000], ['build.gradle', 'a b\n'.repeat(n), 4000], ['a.graphql', 'scalar S\n'.repeat(n), 4000],
  ];
  for (const [path, text, spanCap] of cases) {
    const spans = timed(`siblings ${path}`, BOUND_MS.siblings, () => chunkStructured(path, text))!;
    assertValid(spans, text, `siblings ${path}`);
    assert(spans.length <= spanCap, `${path}: ${spans.length} spans (cap ${spanCap})`);
  }
});

test('ReDoS-style and quote-confusion inputs stay linear', () => {
  const size = 200_000;
  const hostile = [
    '`'.repeat(size), '<!--'.repeat(size / 4), '"'.repeat(size), "'".repeat(size), '['.repeat(size), '{{'.repeat(size / 2), '- '.repeat(size / 2), '#'.repeat(size), '$('.repeat(size / 2),
    '\\'.repeat(size), '='.repeat(size), '<a '.repeat(size / 3), '<a b="'.repeat(size / 6), "<a b='".repeat(size / 6), '/*'.repeat(size / 2), ' \t'.repeat(size / 2), '\n'.repeat(size),
    'a'.repeat(size) + '!', '<'.repeat(size), '</'.repeat(size / 2), '<![CDATA['.repeat(size / 9), '<?'.repeat(size / 2), '{%'.repeat(size / 2), '{#'.repeat(size / 2), '<<EOF\n'.repeat(size / 6),
    '$$'.repeat(size / 2), '--'.repeat(size / 2), '\u00e9'.repeat(size), 'ab\n'.repeat(size / 3) + '```', '|---'.repeat(size / 4), '+++\n', ':'.repeat(size), '[[a]]\n'.repeat(size / 6),
    'key: &a *a\n'.repeat(size / 11), 'x = """\n'.repeat(size / 8), '(\n'.repeat(size / 2), '))\n'.repeat(size / 3),
  ];
  for (const text of hostile) {
    for (const path of Object.values(FORMAT_PATHS)) {
      timed(`hostile ${path} ${JSON.stringify(text.slice(0, 6))}`, BOUND_MS.hostile, () => assertValid(chunkStructured(path, text), text, `hostile ${path}`));
    }
  }
});
