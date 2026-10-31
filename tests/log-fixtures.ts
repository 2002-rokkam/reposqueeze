// Synthetic log fixtures, one per test runner / toolchain, shaped like real output (all content is invented).
// Each fixture lists lines that a compaction must keep (failing tests, assertion details, root errors, final counts) and
// regular expressions for noise that must disappear or be folded into a counted marker.

export interface LogFixture {
  name: string;
  runner: string;
  text: string;
  /** Substrings that must survive compaction at budget 1000. */
  keep: string[];
  /** Number of lines that must be flagged as failure signals (at least). */
  minSignals: number;
}

const range = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));
const join = (...parts: (string | string[])[]) => parts.flat().join('\n') + '\n';

const pytest = join(
  '============================= test session starts ==============================',
  'platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.2.0',
  'rootdir: /home/runner/work/shop/shop',
  'plugins: cov-4.1.0, xdist-3.3.1',
  'collected 412 items',
  '',
  range(40, i => `tests/test_module_${i}.py ${'.'.repeat(8 + (i % 5))}${' '.repeat(30)}[${String(Math.floor((i * 100) / 41)).padStart(3)}%]`),
  'tests/test_auth.py ..F....s..                                            [ 90%]',
  'tests/test_db.py ..F.                                                    [ 95%]',
  '',
  '=================================== FAILURES ===================================',
  '______________________ test_login_rejects_bad_password ______________________',
  '',
  'client = <FlaskClient <Flask \'shop\'>>',
  '',
  '    def test_login_rejects_bad_password(client):',
  '        resp = client.post("/login", json={"user": "ann", "password": "wrong"})',
  '>       assert resp.status_code == 401',
  'E       assert 500 == 401',
  'E        +  where 500 = <WrapperTestResponse 25 bytes [500 INTERNAL SERVER ERROR]>.status_code',
  '',
  'tests/test_auth.py:42: AssertionError',
  '----------------------------- Captured stderr call -----------------------------',
  range(25, i => `DEBUG shop.auth: checking credential ${i} for user ann`),
  '_____________________________ test_pool_exhaustion _____________________________',
  '',
  '    def test_pool_exhaustion(pool):',
  '>       conn = pool.acquire(timeout=0.1)',
  'E       TimeoutError: connection pool exhausted (max=4)',
  '',
  'src/shop/db.py:88: TimeoutError',
  '=========================== short test summary info ============================',
  'FAILED tests/test_auth.py::test_login_rejects_bad_password - assert 500 == 401',
  'FAILED tests/test_db.py::test_pool_exhaustion - TimeoutError: connection pool exhausted (max=4)',
  '=================== 2 failed, 407 passed, 3 skipped in 12.34s ===================');

const pytestVerbose = join(
  '============================= test session starts ==============================',
  'collecting ... collected 300 items',
  range(120, i => `tests/test_users.py::test_case_${i} PASSED${' '.repeat(18)}[ ${String(Math.floor(i / 3)).padStart(2)}%]`),
  'tests/test_users.py::test_case_120 FAILED                               [ 41%]',
  range(60, i => `tests/test_orders.py::test_order_${i} PASSED${' '.repeat(17)}[ ${String(42 + Math.floor(i / 4))}%]`),
  '=================================== FAILURES ===================================',
  '_______________________________ test_case_120 ________________________________',
  'E   KeyError: \'email\'',
  'tests/test_users.py:77: KeyError',
  '=========================== short test summary info ============================',
  'FAILED tests/test_users.py::test_case_120 - KeyError: \'email\'',
  '========================= 1 failed, 179 passed in 3.21s ========================');

const unittest = join(
  range(30, i => `test_feature_${i} (suite.tests.FeatureTests) ... ok`),
  'test_parse_header (suite.tests.ParserTests) ... FAIL',
  'test_roundtrip (suite.tests.ParserTests) ... ERROR',
  '',
  '======================================================================',
  'ERROR: test_roundtrip (suite.tests.ParserTests)',
  '----------------------------------------------------------------------',
  'Traceback (most recent call last):',
  '  File "/home/runner/work/lib/lib/suite/tests.py", line 55, in test_roundtrip',
  '    data = decode(encode(sample))',
  '  File "/home/runner/work/lib/lib/suite/codec.py", line 12, in decode',
  '    raise ValueError("bad frame: %r" % frame)',
  'ValueError: bad frame: b\'\\x00\\x01\'',
  '',
  '======================================================================',
  'FAIL: test_parse_header (suite.tests.ParserTests)',
  '----------------------------------------------------------------------',
  'Traceback (most recent call last):',
  '  File "/home/runner/work/lib/lib/suite/tests.py", line 31, in test_parse_header',
  '    self.assertEqual(parse(b"H1"), {"v": 1})',
  'AssertionError: {\'v\': 2} != {\'v\': 1}',
  '',
  '----------------------------------------------------------------------',
  'Ran 32 tests in 0.114s',
  '',
  'FAILED (failures=1, errors=1)');

const jest = join(
  range(14, i => `PASS src/components/widget${i}.test.tsx (${(1.2 + i / 10).toFixed(2)} s)`),
  'FAIL src/services/cart.test.ts',
  '  ● Cart › applies discount codes › rejects expired codes',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '    Expected: "EXPIRED"',
  '    Received: "OK"',
  '',
  '      41 |     const result = cart.apply("SPRING23");',
  '    > 42 |     expect(result.status).toBe("EXPIRED");',
  '         |                           ^',
  '      43 |   });',
  '',
  '      at Object.<anonymous> (src/services/cart.test.ts:42:27)',
  '      at node_modules/jest-circus/build/run.js:315:5',
  '      at node_modules/jest-circus/build/run.js:245:3',
  '      at node_modules/jest-circus/build/run.js:196:7',
  '',
  'Test Suites: 1 failed, 14 passed, 15 total',
  'Tests:       1 failed, 112 passed, 113 total',
  'Snapshots:   0 total',
  'Time:        8.412 s',
  'Ran all test suites.');

const vitest = join(
  range(25, i => ` ✓ src/lib/util${i}.test.ts (${3 + (i % 4)} tests) ${10 + i}ms`),
  ' ❯ src/lib/money.test.ts (4 tests | 1 failed) 14ms',
  '   × formats negative amounts 3ms',
  '',
  ' FAIL  src/lib/money.test.ts > formats negative amounts',
  'AssertionError: expected \'-$5.00\' to be \'($5.00)\' // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- ($5.00)',
  '+ -$5.00',
  '',
  ' ❯ src/lib/money.test.ts:21:30',
  '     19|   it("formats negative amounts", () => {',
  '     20|     const out = format(-5);',
  '     21|     expect(out).toBe("($5.00)");',
  '       |                 ^',
  '',
  ' Test Files  1 failed | 24 passed (25)',
  '      Tests  1 failed | 99 passed (100)',
  '   Duration  4.31s');

const mocha = join(
  range(40, i => `    ✓ handles case ${i} (${i % 7}ms)`),
  '    1) rejects malformed payloads',
  '',
  '  40 passing (1s)',
  '  1 failing',
  '',
  '  1) payload validation',
  '       rejects malformed payloads:',
  '',
  '      AssertionError: expected [Function] to throw an error',
  '      + expected - actual',
  '',
  '      at Context.<anonymous> (test/payload.test.js:18:30)',
  '      at processImmediate (node:internal/timers:476:21)');

const goTest = join(
  range(60, i => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.00s)`),
  '=== RUN   TestRouterRejectsBadHost',
  '    router_test.go:57: expected status 400, got 200',
  '--- FAIL: TestRouterRejectsBadHost (0.01s)',
  '=== RUN   TestPanicsOnNil',
  'panic: runtime error: invalid memory address or nil pointer dereference [recovered]',
  '\tpanic: runtime error: invalid memory address or nil pointer dereference',
  '[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4a1b2c]',
  '',
  'goroutine 18 [running]:',
  'testing.tRunner.func1.2({0x5d4a20, 0x7ec3e0})',
  '\t/usr/local/go/src/testing/testing.go:1545 +0x238',
  'testing.tRunner.func1()',
  '\t/usr/local/go/src/testing/testing.go:1548 +0x397',
  'panic({0x5d4a20?, 0x7ec3e0?})',
  '\t/usr/local/go/src/runtime/panic.go:914 +0x21f',
  'example.com/app/router.(*Router).Lookup(0x0, {0xc0000a2010, 0x3})',
  '\t/home/runner/work/app/app/router/router.go:88 +0x2a',
  'example.com/app/router.TestPanicsOnNil(0xc0001a2340)',
  '\t/home/runner/work/app/app/router/router_test.go:71 +0x45',
  'testing.tRunner(0xc0001a2340, 0x6a1b50)',
  '\t/usr/local/go/src/testing/testing.go:1595 +0x103',
  'created by testing.(*T).Run in goroutine 1',
  '\t/usr/local/go/src/testing/testing.go:1648 +0x3ad',
  'FAIL\texample.com/app/router\t0.052s',
  'FAIL');

const goJson = join(
  range(40, i => `{"Time":"2025-03-01T10:00:${String(i % 60).padStart(2, '0')}.000Z","Action":"run","Package":"example.com/app","Test":"TestItem${i}"}\n{"Time":"2025-03-01T10:00:${String(i % 60).padStart(2, '0')}.001Z","Action":"pass","Package":"example.com/app","Test":"TestItem${i}","Elapsed":0}`),
  '{"Time":"2025-03-01T10:01:00.000Z","Action":"output","Package":"example.com/app","Test":"TestBroken","Output":"    broken_test.go:12: got 3, want 4\\n"}',
  '{"Time":"2025-03-01T10:01:00.001Z","Action":"fail","Package":"example.com/app","Test":"TestBroken","Elapsed":0}',
  '{"Time":"2025-03-01T10:01:00.002Z","Action":"fail","Package":"example.com/app","Elapsed":0.03}');

const cargo = join(
  'running 61 tests',
  range(58, i => `test parser::tests::case_${i} ... ok`),
  'test codec::tests::roundtrip ... FAILED',
  'test codec::tests::empty_input ... ok',
  'test net::tests::timeout ... FAILED',
  '',
  'failures:',
  '',
  '---- codec::tests::roundtrip stdout ----',
  'thread \'codec::tests::roundtrip\' panicked at src/codec.rs:131:9:',
  'assertion `left == right` failed',
  '  left: [1, 2, 3]',
  ' right: [1, 2, 4]',
  'stack backtrace:',
  '   0: rust_begin_unwind',
  '             at /rustc/abc123/library/std/src/panicking.rs:645:5',
  '   1: core::panicking::panic_fmt',
  '             at /rustc/abc123/library/core/src/panicking.rs:72:14',
  '   2: app::codec::tests::roundtrip',
  '             at ./src/codec.rs:131:9',
  '---- net::tests::timeout stdout ----',
  'thread \'net::tests::timeout\' panicked at src/net.rs:50:5:',
  'timed out waiting for peer',
  '',
  'failures:',
  '    codec::tests::roundtrip',
  '    net::tests::timeout',
  '',
  'test result: FAILED. 59 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s',
  'error: test failed, to rerun pass `--lib`');

const maven = join(
  '[INFO] -------------------------------------------------------',
  '[INFO]  T E S T S',
  '[INFO] -------------------------------------------------------',
  range(30, i => `[INFO] Running com.shop.service.Service${i}Test\n[INFO] Tests run: ${3 + (i % 3)}, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.0${i % 9} s - in com.shop.service.Service${i}Test`),
  '[INFO] Running com.shop.web.CheckoutControllerTest',
  '[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.21 s <<< FAILURE! - in com.shop.web.CheckoutControllerTest',
  '[ERROR] rejectsEmptyCart  Time elapsed: 0.05 s  <<< FAILURE!',
  'org.opentest4j.AssertionFailedError: expected: <400> but was: <200>',
  '\tat org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)',
  '\tat org.junit.jupiter.api.AssertionUtils.failNotEqual(AssertionUtils.java:62)',
  '\tat org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:182)',
  '\tat com.shop.web.CheckoutControllerTest.rejectsEmptyCart(CheckoutControllerTest.java:48)',
  '\tat java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)',
  '\tat java.base/java.lang.reflect.Method.invoke(Method.java:568)',
  '\tat org.junit.platform.commons.util.ReflectionUtils.invokeMethod(ReflectionUtils.java:725)',
  '\tat org.junit.platform.engine.support.hierarchical.ThrowableCollector.execute(ThrowableCollector.java:73)',
  '',
  '[INFO] Results:',
  '[ERROR] Failures: ',
  '[ERROR]   CheckoutControllerTest.rejectsEmptyCart:48 expected: <400> but was: <200>',
  '[ERROR] Tests run: 124, Failures: 1, Errors: 0, Skipped: 2',
  '[INFO] BUILD FAILURE',
  '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.1.2:test (default-test) on project shop: There are test failures.');

const javaTrace = join(
  '2025-03-01 10:15:02.114 ERROR 4120 --- [nio-8080-exec-3] o.a.c.c.C.[.[.[/].[dispatcherServlet] : Servlet.service() threw exception',
  'java.lang.IllegalStateException: Failed to load ApplicationContext',
  '\tat org.springframework.test.context.cache.DefaultCacheAwareContextLoaderDelegate.loadContext(DefaultCacheAwareContextLoaderDelegate.java:180)',
  '\tat org.springframework.test.context.support.DefaultTestContext.getApplicationContext(DefaultTestContext.java:130)',
  '\tat org.springframework.test.context.web.ServletTestExecutionListener.setUpRequestContextIfNecessary(ServletTestExecutionListener.java:191)',
  '\tat com.shop.config.AppConfigTest.setUp(AppConfigTest.java:33)',
  '\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)',
  '\tat java.base/java.lang.reflect.Method.invoke(Method.java:580)',
  '\tat org.junit.platform.commons.util.ReflectionUtils.invokeMethod(ReflectionUtils.java:725)',
  '\tat org.junit.platform.engine.support.hierarchical.ThrowableCollector.execute(ThrowableCollector.java:73)',
  'Caused by: org.springframework.beans.factory.BeanCreationException: Error creating bean with name \'dataSource\'',
  '\tat org.springframework.beans.factory.support.AbstractAutowireCapableBeanFactory.initializeBean(AbstractAutowireCapableBeanFactory.java:1786)',
  '\tat org.springframework.beans.factory.support.AbstractAutowireCapableBeanFactory.doCreateBean(AbstractAutowireCapableBeanFactory.java:600)',
  '\t... 52 common frames omitted',
  'Caused by: java.net.ConnectException: Connection refused: localhost/127.0.0.1:5432',
  '\tat java.base/sun.nio.ch.Net.pollConnect(Native Method)',
  '\tat java.base/sun.nio.ch.Net.pollConnectNow(Net.java:672)',
  '\tat com.shop.db.PoolFactory.open(PoolFactory.java:71)',
  '\t... 61 more');

const nodeTrace = join(
  'Error: connect ECONNREFUSED 127.0.0.1:6379',
  '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)',
  '    at Object.connect (/home/runner/work/api/api/src/cache.js:19:11)',
  '    at /home/runner/work/api/api/node_modules/ioredis/built/Redis.js:170:41',
  '    at /home/runner/work/api/api/node_modules/ioredis/built/Redis.js:174:15',
  '    at new Promise (<anonymous>)',
  '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
  '    at async startServer (/home/runner/work/api/api/src/server.js:40:3)',
  'npm ERR! code ELIFECYCLE',
  'npm ERR! errno 1',
  'npm ERR! api@1.0.0 test: `jest --ci`',
  'npm ERR! Exit status 1');

const pythonRecursion = join(
  'Traceback (most recent call last):',
  '  File "/app/main.py", line 10, in <module>',
  '    run()',
  '  File "/app/main.py", line 6, in run',
  '    walk(Node())',
  range(300, () => '  File "/app/tree.py", line 22, in walk\n    return walk(node.child)').flatMap(s => s.split('\n')),
  'RecursionError: maximum recursion depth exceeded');

const dotnet = join(
  range(35, i => `  Passed Shop.Tests.Orders.Case${i} [${2 + (i % 5)} ms]`),
  '  Failed Shop.Tests.Orders.RejectsNegativeQuantity [12 ms]',
  '  Error Message:',
  '   Assert.Equal() Failure: Values differ',
  'Expected: 0',
  'Actual:   -3',
  '  Stack Trace:',
  '     at Shop.Tests.Orders.RejectsNegativeQuantity() in /src/Shop.Tests/Orders.cs:line 61',
  '     at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments, Signature sig, Boolean isConstructor)',
  '     at System.Reflection.MethodBaseInvoker.InvokeWithNoArgs(Object obj, BindingFlags invokeAttr)',
  '',
  'Failed!  - Failed:     1, Passed:    35, Skipped:     0, Total:    36, Duration: 1 s');

const rspec = join(
  '..........................................F.....................',
  '',
  'Failures:',
  '',
  '  1) Invoice#total applies the loyalty discount',
  '     Failure/Error: expect(invoice.total).to eq(90)',
  '',
  '       expected: 90',
  '            got: 100',
  '',
  '       (compared using ==)',
  '     # ./spec/invoice_spec.rb:27:in `block (3 levels) in <top (required)>\'',
  '     # /usr/local/bundle/gems/rspec-core-3.12.2/lib/rspec/core/example.rb:263:in `instance_exec\'',
  '     # /usr/local/bundle/gems/rspec-core-3.12.2/lib/rspec/core/example.rb:263:in `block in run\'',
  '',
  'Finished in 3.21 seconds (files took 0.9 seconds to load)',
  '65 examples, 1 failure',
  '',
  'Failed examples:',
  '',
  'rspec ./spec/invoice_spec.rb:25 # Invoice#total applies the loyalty discount');

const phpunit = join(
  'PHPUnit 10.3.1 by Sebastian Bergmann and contributors.',
  '',
  'Runtime:       PHP 8.2.10',
  '',
  '.....................................................  53 / 120 ( 44%)',
  '.....................F...............................  106 / 120 ( 88%)',
  '..............                                        120 / 120 (100%)',
  '',
  'Time: 00:02.113, Memory: 24.00 MB',
  '',
  'There was 1 failure:',
  '',
  '1) Tests\\Feature\\CartTest::testRemovesItems',
  'Failed asserting that 2 matches expected 1.',
  '',
  '/home/runner/work/shop/shop/tests/Feature/CartTest.php:58',
  '/home/runner/work/shop/shop/vendor/phpunit/phpunit/src/Framework/TestCase.php:1215',
  '',
  'FAILURES!',
  'Tests: 120, Assertions: 301, Failures: 1.');

const ctest = join(
  'Test project /home/runner/work/engine/engine/build',
  range(40, i => `      Start ${i + 1}: unit_${i}\n${String(i + 1).padStart(2)}/42 Test #${i + 1}: unit_${i} ...................   Passed    0.0${i % 9} sec`),
  '41/42 Test #41: physics_collide ...............***Failed    0.31 sec',
  '42/42 Test #42: render_smoke ..................   Passed    1.20 sec',
  '',
  '98% tests passed, 1 tests failed out of 42',
  '',
  'The following tests FAILED:',
  '\t 41 - physics_collide (Failed)',
  'Errors while running CTest');

const gcc = join(
  range(30, i => `[ ${String(Math.floor((i * 100) / 33)).padStart(2)}%] Building CXX object src/CMakeFiles/engine.dir/module_${i}.cpp.o`),
  '/home/runner/work/engine/engine/src/physics.cpp: In member function \'void World::step(double)\':',
  '/home/runner/work/engine/engine/src/physics.cpp:212:17: error: \'collider\' was not declared in this scope',
  '  212 |                 collider.resolve(dt);',
  '      |                 ^~~~~~~~',
  '/home/runner/work/engine/engine/src/physics.cpp:240:5: warning: unused variable \'iterations\' [-Wunused-variable]',
  'make[2]: *** [src/CMakeFiles/engine.dir/build.make:187: src/CMakeFiles/engine.dir/physics.cpp.o] Error 1',
  'make[1]: *** [CMakeFiles/Makefile2:114: src/CMakeFiles/engine.dir/all] Error 2',
  'make: *** [Makefile:136: all] Error 2');

const tsc = join(
  'src/api/client.ts(41,17): error TS2322: Type \'string\' is not assignable to type \'number\'.',
  'src/api/client.ts(58,9): error TS2345: Argument of type \'undefined\' is not assignable to parameter of type \'Request\'.',
  'src/ui/table.tsx(12,3): error TS2741: Property \'rows\' is missing in type \'{}\' but required in type \'Props\'.',
  'Found 3 errors in 2 files.',
  '',
  'Errors  Files',
  '     2  src/api/client.ts:41',
  '     1  src/ui/table.tsx:12');

const eslint = join(
  '/home/runner/work/web/web/src/app.ts',
  '   12:7   error    \'unused\' is assigned a value but never used  @typescript-eslint/no-unused-vars',
  '   40:15  warning  Unexpected any. Specify a different type      @typescript-eslint/no-explicit-any',
  '',
  '/home/runner/work/web/web/src/util.ts',
  '   3:1  error  Missing return type on function  @typescript-eslint/explicit-function-return-type',
  '',
  '✖ 3 problems (2 errors, 1 warning)');

const webpack = join(
  range(20, i => `asset chunk-${i}.js ${100 + i} KiB [emitted] (name: chunk${i})`),
  'ERROR in ./src/index.tsx 7:0-34',
  'Module not found: Error: Can\'t resolve \'./missing-module\' in \'/home/runner/work/web/web/src\'',
  ' @ ./src/index.tsx 7:0-34',
  'webpack 5.88.2 compiled with 1 error in 4310 ms');

const dockerBuild = join(
  '#1 [internal] load build definition from Dockerfile',
  '#1 DONE 0.0s',
  range(12, i => `#${i + 2} [${i + 1}/14] RUN apt-get install -y package${i}\n#${i + 2} 0.${i}12 Reading package lists...\n#${i + 2} DONE 1.${i}s`),
  '#15 [14/14] RUN make build',
  '#15 1.204 make: *** [Makefile:9: build] Error 2',
  '#15 ERROR: process "/bin/sh -c make build" did not complete successfully: exit code: 2',
  '------',
  ' > [14/14] RUN make build:',
  '------',
  'Dockerfile:22',
  'ERROR: failed to solve: process "/bin/sh -c make build" did not complete successfully: exit code: 2');

const npmInstall = join(
  range(60, i => `npm WARN deprecated package-${i}@1.${i}.0: this version is no longer supported`),
  'npm ERR! code E404',
  'npm ERR! 404 Not Found - GET https://registry.npmjs.org/@acme%2fprivate-pkg - Not found',
  'npm ERR! 404  \'@acme/private-pkg@^2.1.0\' is not in this registry.',
  'npm ERR! A complete log of this run can be found in: /home/runner/.npm/_logs/2025-03-01T10_00_00_000Z-debug-0.log');

const pipInstall = join(
  range(40, i => `Collecting package${i}==1.${i}.0\n  Downloading package${i}-1.${i}.0-py3-none-any.whl (${100 + i} kB)`),
  'ERROR: Could not find a version that satisfies the requirement missing-pkg==9.9.9 (from versions: none)',
  'ERROR: No matching distribution found for missing-pkg==9.9.9');

const progress = join(
  'Downloading artifact 1/3',
  range(80, i => `\u001b[2K\rProgress ${i}%\u001b[0G`).join('') + '\r',
  'Downloaded artifact 1/3',
  'ERROR: checksum mismatch for artifact 1');

const ghaPytest = pytest.split('\n').filter(Boolean).map((line, i) => {
  const stamp = `2025-03-01T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String(1000000 + i * 37).slice(-7)}Z`;
  return `test (3.11)\tRun pytest\t${stamp} ${line}`;
}).join('\n') + '\n';

export const FIXTURES: LogFixture[] = [
  { name: 'pytest', runner: 'pytest', text: pytest, minSignals: 6, keep: ['test_login_rejects_bad_password', 'assert 500 == 401', 'tests/test_auth.py:42: AssertionError', 'test_pool_exhaustion', 'TimeoutError: connection pool exhausted (max=4)', 'short test summary info', '2 failed, 407 passed, 3 skipped in 12.34s'] },
  { name: 'pytest-verbose', runner: 'pytest', text: pytestVerbose, minSignals: 3, keep: ['test_case_120', "KeyError: 'email'", '1 failed, 179 passed in 3.21s'] },
  { name: 'unittest', runner: 'unittest', text: unittest, minSignals: 4, keep: ['FAIL: test_parse_header', 'ERROR: test_roundtrip', 'ValueError: bad frame', "AssertionError: {'v': 2} != {'v': 1}", 'Ran 32 tests', 'FAILED (failures=1, errors=1)'] },
  { name: 'jest', runner: 'jest', text: jest, minSignals: 3, keep: ['FAIL src/services/cart.test.ts', 'rejects expired codes', 'Expected: "EXPIRED"', 'Received: "OK"', 'src/services/cart.test.ts:42:27', 'Tests:       1 failed, 112 passed, 113 total'] },
  { name: 'vitest', runner: 'vitest', text: vitest, minSignals: 3, keep: ['FAIL  src/lib/money.test.ts > formats negative amounts', "AssertionError: expected '-$5.00'", 'Tests  1 failed | 99 passed (100)'] },
  { name: 'mocha', runner: 'mocha', text: mocha, minSignals: 2, keep: ['1 failing', 'rejects malformed payloads', 'AssertionError: expected [Function] to throw an error', 'test/payload.test.js:18:30'] },
  { name: 'go-test', runner: 'go-test', text: goTest, minSignals: 4, keep: ['--- FAIL: TestRouterRejectsBadHost', 'router_test.go:57: expected status 400, got 200', 'nil pointer dereference', 'router/router.go:88', 'router_test.go:71', 'FAIL\texample.com/app/router'] },
  { name: 'go-test-json', runner: 'go-test', text: goJson, minSignals: 1, keep: ['TestBroken', 'got 3, want 4'] },
  { name: 'cargo-test', runner: 'cargo-test', text: cargo, minSignals: 4, keep: ['codec::tests::roundtrip ... FAILED', "panicked at src/codec.rs:131:9", 'left: [1, 2, 3]', 'right: [1, 2, 4]', 'test result: FAILED. 59 passed; 2 failed'] },
  { name: 'maven-surefire', runner: 'junit-maven', text: maven, minSignals: 4, keep: ['CheckoutControllerTest.rejectsEmptyCart:48', 'expected: <400> but was: <200>', 'CheckoutControllerTest.java:48', 'BUILD FAILURE'] },
  { name: 'java-caused-by', runner: 'java', text: javaTrace, minSignals: 3, keep: ['java.lang.IllegalStateException: Failed to load ApplicationContext', 'BeanCreationException', 'java.net.ConnectException: Connection refused: localhost/127.0.0.1:5432', 'AppConfigTest.java:33', 'PoolFactory.java:71'] },
  { name: 'node-trace', runner: 'node', text: nodeTrace, minSignals: 2, keep: ['Error: connect ECONNREFUSED 127.0.0.1:6379', 'src/cache.js:19:11', 'src/server.js:40:3', 'npm ERR! code ELIFECYCLE'] },
  { name: 'python-recursion', runner: 'python', text: pythonRecursion, minSignals: 2, keep: ['Traceback (most recent call last):', 'RecursionError: maximum recursion depth exceeded', '/app/main.py', 'walk(Node())'] },
  { name: 'dotnet-test', runner: 'dotnet', text: dotnet, minSignals: 3, keep: ['Failed Shop.Tests.Orders.RejectsNegativeQuantity', 'Assert.Equal() Failure', 'Orders.cs:line 61', 'Failed!  - Failed:     1, Passed:    35'] },
  { name: 'rspec', runner: 'rspec', text: rspec, minSignals: 3, keep: ['Invoice#total applies the loyalty discount', 'expected: 90', 'got: 100', 'spec/invoice_spec.rb:27', '65 examples, 1 failure'] },
  { name: 'phpunit', runner: 'phpunit', text: phpunit, minSignals: 3, keep: ['Tests\\Feature\\CartTest::testRemovesItems', 'Failed asserting that 2 matches expected 1.', 'CartTest.php:58', 'Tests: 120, Assertions: 301, Failures: 1.'] },
  { name: 'ctest', runner: 'ctest', text: ctest, minSignals: 3, keep: ['physics_collide', '98% tests passed, 1 tests failed out of 42'] },
  { name: 'gcc-make', runner: 'gcc', text: gcc, minSignals: 3, keep: ["physics.cpp:212:17: error: 'collider' was not declared in this scope", 'make: *** [Makefile:136: all] Error 2'] },
  { name: 'tsc', runner: 'tsc', text: tsc, minSignals: 3, keep: ['src/api/client.ts(41,17): error TS2322', 'src/ui/table.tsx(12,3): error TS2741', 'Found 3 errors in 2 files.'] },
  { name: 'eslint', runner: 'eslint', text: eslint, minSignals: 1, keep: ['@typescript-eslint/no-unused-vars', '✖ 3 problems (2 errors, 1 warning)'] },
  { name: 'webpack', runner: 'webpack', text: webpack, minSignals: 2, keep: ['ERROR in ./src/index.tsx', "Can't resolve './missing-module'", 'compiled with 1 error'] },
  { name: 'docker-build', runner: 'docker', text: dockerBuild, minSignals: 3, keep: ['make: *** [Makefile:9: build] Error 2', 'failed to solve', 'Dockerfile:22'] },
  { name: 'npm-install', runner: 'npm', text: npmInstall, minSignals: 3, keep: ['npm ERR! code E404', '@acme/private-pkg'] },
  { name: 'pip-install', runner: 'pip', text: pipInstall, minSignals: 2, keep: ['Could not find a version that satisfies the requirement missing-pkg==9.9.9', 'No matching distribution found for missing-pkg==9.9.9'] },
  { name: 'progress-redraw', runner: 'progress', text: progress, minSignals: 1, keep: ['ERROR: checksum mismatch for artifact 1', 'Progress 79%'] },
  { name: 'gha-prefixed-pytest', runner: 'pytest', text: ghaPytest, minSignals: 6, keep: ['test_login_rejects_bad_password', 'assert 500 == 401', '2 failed, 407 passed, 3 skipped in 12.34s'] }
];
