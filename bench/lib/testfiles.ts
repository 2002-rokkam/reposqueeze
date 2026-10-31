/**
 * Heuristic test-file detector used to keep tests out of the gold set.
 *
 * It is deliberately path-only (no file content) and errs towards classic conventions of the
 * nine SWE-bench Multilingual languages plus Python. Known consequence, shared with SWE-bench's
 * own patch/test_patch partition: framework code that lives in a `test/` package
 * (for example `django/test/`) is classified as test code.
 */

const TEST_DIRS = new Set([
  'test', 'tests', '__tests__', 'testing', 'e2e', 'testdata', 'test_data', 'test-data',
  '__mocks__', '__snapshots__', '__fixtures__', 'fixtures', 'unittests', 'unit_tests', 'unit-tests',
  'testutil', 'testutils', 'test_utils', 'test-utils', 'testlib',
]);

/** `spec/` is RSpec/Jasmine in Ruby and JS but an ordinary Java/Go package name elsewhere. */
const SPEC_DIRS = new Set(['spec', 'specs']);
const SPEC_EXTENSIONS = new Set(['rb', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'coffee', 'feature', 'erb']);

/** Directory names like `integration-tests`, `core_test`, `functionalTest`, `testFixtures`. */
const TEST_DIR_AFFIX = /(?:^|[-_.])tests?$|[a-z0-9]Tests?$|^test(?:Fixtures|Support|Helpers)$/;
const SPEC_DIR_AFFIX = /(?:^|[-_.])specs?$/;

const CLASS_EXTENSIONS = 'java|kt|kts|scala|groovy|cs|vb|php|swift|dart';

const FILE_PATTERNS: RegExp[] = [
  /^conftest\.py$/,
  /^tests?\.[A-Za-z0-9]+$/i, // tests.py (Django), tests.rs, test.js
  /^test[_-][^/]+$/i, // test_foo.py, test-utils.js
  /[_-]tests?\.[A-Za-z0-9+]+$/i, // foo_test.go, foo-tests.cc
  /[_-]unittests?\.[A-Za-z0-9+]+$/i, // foo_unittest.cc
  /\.(?:tests?|specs?|e2e|e2e-spec)\.[A-Za-z0-9]+$/i, // foo.test.ts, foo.spec.js
  /[_-]spec\.[A-Za-z0-9]+$/i, // foo_spec.rb
  /\.snap$/i,
  new RegExp(`^Test[A-Z0-9_][A-Za-z0-9_]*\\.(?:${CLASS_EXTENSIONS})$`), // TestUtils.java
  new RegExp(`^[A-Za-z0-9_]*Tests?\\.(?:${CLASS_EXTENSIONS})$`), // FooTest.java, FooTests.cs, Test.java
  new RegExp(`^[A-Za-z0-9_]*TestCase\\.(?:${CLASS_EXTENSIONS})$`), // FooTestCase.php
  new RegExp(`^[A-Za-z0-9_]*[a-z0-9]IT(?:Case)?\\.(?:${CLASS_EXTENSIONS})$`), // FooIT.java (integration tests)
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isTestPath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length) return false;
  const name = parts[parts.length - 1];
  const specAllowed = SPEC_EXTENSIONS.has(extensionOf(name));
  for (const dir of parts.slice(0, -1)) {
    if (TEST_DIRS.has(dir.toLowerCase()) || TEST_DIR_AFFIX.test(dir)) return true;
    if (specAllowed && (SPEC_DIRS.has(dir.toLowerCase()) || SPEC_DIR_AFFIX.test(dir))) return true;
  }
  return FILE_PATTERNS.some(pattern => pattern.test(name));
}
