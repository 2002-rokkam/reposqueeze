import test from 'node:test';
import assert from 'node:assert/strict';
import { isTestPath } from '../bench/lib/testfiles.js';
import { goldMentions } from '../bench/lib/mentions.js';
import { instanceLanguage, kindOfPath, languageOfPath } from '../bench/lib/lang.js';

test('detects test files across languages and conventions', () => {
  const tests = [
    'tests/test_foo.py', 'test/unit/foo.js', 'src/__tests__/a.ts', 'testing/test_x.py', 'conftest.py', 'pkg/conftest.py',
    'internal/foo_test.go', 'a/b/FooTest.java', 'a/b/FooTests.cs', 'a/b/FooIT.java', 'src/test/java/x/Foo.java',
    'src/foo.test.ts', 'src/foo.spec.js', 'spec/models/user_spec.rb', 'lib/foo_spec.rb', 'lib/test_foo.rb', 'app/tests.py',
    'src/tests.rs', 'tests/integration.rs', 'internal/foo/testdata/x.json', 'src/__snapshots__/a.snap', 'src/Foo.test.js.snap',
    'a/TestUtils.java', 'tests/Unit/FooTest.php', 'src/FooTestCase.php', 'integration-tests/a.js', 'unit_tests/foo.py',
    'module/functionalTest/x.kt', 'src/testFixtures/kotlin/A.kt', 'x/test_data/y.txt', 'a/b/foo_unittest.cc', 'src/test_something.c',
    'tests/Feature/Foo.php', 'a\\b\\test_x.py', 'src/specs/foo.js', 'test/test_helper.rb', 'pkg/testutil/helper.go',
  ];
  for (const path of tests) assert.equal(isTestPath(path), true, path);
});

test('does not flag production code that merely contains the word test', () => {
  const sources = [
    'src/main.py', 'django/db/models/query.py', 'pkg/latest.js', 'pkg/contest.py', 'src/attest.ts', 'src/_pytest/python.py',
    'org/apache/druid/query/spec/MultipleIntervalSegmentSpec.java', 'pkg/spec/foo.go', 'docs/testing.rst', 'src/protest.py',
    'a/Latest.java', 'a/Contest.java', 'a/Testimony.java', 'a/AbstractTester.java', 'README.md', 'src/Attestation.java',
    'lib/greatest.ts', 'src/testify.go', 'tokio/src/runtime/mod.rs', '', 'src/inspect.rs',
  ];
  for (const path of sources) assert.equal(isTestPath(path), false, path);
});

test('is robust to pathological names', () => {
  const started = performance.now();
  assert.equal(isTestPath('a/'.repeat(50_000) + 'x.py'), false);
  assert.equal(isTestPath(`${'a'.repeat(500_000)}_test.py`), true);
  assert.equal(isTestPath('日本語/テスト/ファイル.py'), false);
  assert.equal(isTestPath('tests/日本語.py'), true);
  assert.ok(performance.now() - started < 1500);
});

test('literal file mentions are detected with token boundaries', () => {
  const text = 'Traceback:\n  File "/home/u/django/db/models/query.py", line 20, in get\nAlso see utils.py and models.query.';
  const m = goldMentions(text, ['django/db/models/query.py']);
  assert.equal(m.path, true);
  assert.equal(m.basename, true);
  assert.equal(m.any, true);
  assert.equal(goldMentions('the xmodels/query.py file', ['django/db/models/query.py']).path, false);
  assert.equal(goldMentions('see query.pyc output', ['a/query.py']).basename, false);
  assert.equal(goldMentions('see my-query.py output', ['a/query.py']).basename, false);
  assert.equal(goldMentions('C:\\repo\\django\\db\\models\\query.py fails', ['django/db/models/query.py']).path, true);
});

test('generic file names alone are not a mention; stems are reported separately', () => {
  const m = goldMentions('__init__.py is imported twice', ['pkg/__init__.py']);
  assert.equal(m.basename, false);
  assert.equal(m.any, false);
  const stem = goldMentions('ArithmeticPostAggregator returns NaN', ['processing/src/ArithmeticPostAggregator.java']);
  assert.equal(stem.stem, true);
  assert.equal(stem.any, false);
});

test('mention search handles huge statements and repeated near-matches', () => {
  const statement = 'query.p query.py'.repeat(100_000).replace(/query\.py/g, 'query.pyc');
  const started = performance.now();
  assert.equal(goldMentions(statement, ['a/models/query.py']).any, false);
  assert.ok(performance.now() - started < 2000);
});

test('language and kind classification', () => {
  assert.equal(languageOfPath('a/b.rs'), 'Rust');
  assert.equal(languageOfPath('a/b.h'), null);
  assert.equal(kindOfPath('a/b.h'), 'code');
  assert.equal(kindOfPath('docs/a.rst'), 'doc');
  assert.equal(kindOfPath('setup.cfg'), 'config');
  assert.equal(kindOfPath('LICENSE'), 'other');
  assert.equal(instanceLanguage(['src/a.ts', 'src/b.ts', 'docs/x.md'], 'babel/babel'), 'TypeScript');
  assert.equal(instanceLanguage(['src/redis.h'], 'redis/redis'), 'C');
  assert.equal(instanceLanguage(['CHANGES.md'], 'Gin-Gonic/gin'), 'Go');
  assert.equal(instanceLanguage(['a.zzz'], 'unknown/repo'), 'Other');
  // tie between two languages resolves to the repository language
  assert.equal(instanceLanguage(['a.js', 'b.ts'], 'facebook/docusaurus'), 'TypeScript');
});
