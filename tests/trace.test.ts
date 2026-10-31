import test from 'node:test';
import assert from 'node:assert/strict';
import { condenseQuery, createFrameResolver, frameKind, orderFrames, parseQuery, resolveFrame, type FrameLanguage, type StackFrame } from '../src/trace.js';

const L = (...lines: string[]): string => lines.join('\n');

interface Expected { path: string; line?: number; column?: number; func?: string; language?: FrameLanguage; qualifier?: string; segment?: number }

function checkFrames(actual: StackFrame[], expected: Expected[], label: string): void {
  const brief = JSON.stringify(actual.map(f => [f.path, f.line, f.column, f.func]));
  assert.equal(actual.length, expected.length, `${label}: frame count, got ${brief}`);
  expected.forEach((want, i) => {
    const frame = actual[i];
    assert.equal(frame.index, i, `${label}: index of frame ${i}`);
    assert(frame.raw.length <= 300 && frame.raw === frame.raw.trim(), `${label}: raw of frame ${i}`);
    for (const key of Object.keys(want) as (keyof Expected)[]) assert.equal(frame[key], want[key], `${label}: frame ${i} ${key}, got ${brief}`);
  });
}

interface ParseCase {
  name: string;
  text: string;
  frames?: Expected[];
  errors?: string[];
  tests?: string[];
  innermostFirst?: boolean;
  isTrace?: boolean;
}

function runCases(group: string, cases: ParseCase[]): void {
  for (const c of cases) {
    test(`parse ${group}: ${c.name}`, () => {
      const parsed = parseQuery(c.text);
      if (c.frames) checkFrames(parsed.frames, c.frames, c.name);
      if (c.errors) assert.deepEqual(parsed.errorLines, c.errors, `${c.name}: error lines`);
      if (c.tests) assert.deepEqual(parsed.testNames, c.tests, `${c.name}: test names`);
      if (c.innermostFirst !== undefined) assert.equal(parsed.innermostFirst, c.innermostFirst, `${c.name}: innermostFirst`);
      if (c.isTrace !== undefined) assert.equal(parsed.isTrace, c.isTrace, `${c.name}: isTrace`);
    });
  }
}

runCases('python', [
  {
    name: 'plain traceback with a site-packages frame',
    text: L(
      'Traceback (most recent call last):',
      '  File "/app/manage.py", line 22, in <module>',
      '    main()',
      '  File "/app/manage.py", line 18, in main',
      '    execute_from_command_line(sys.argv)',
      '  File "/usr/local/lib/python3.9/site-packages/django/core/management/__init__.py", line 419, in execute_from_command_line',
      '    utility.execute()',
      'django.db.utils.OperationalError: no such table: auth_user'),
    frames: [
      { path: '/app/manage.py', line: 22, func: '<module>', language: 'python', segment: 0 },
      { path: '/app/manage.py', line: 18, func: 'main' },
      { path: '/usr/local/lib/python3.9/site-packages/django/core/management/__init__.py', line: 419, func: 'execute_from_command_line' },
    ],
    errors: ['django.db.utils.OperationalError: no such table: auth_user'],
    innermostFirst: false,
    isTrace: true,
  },
  {
    name: 'chained exceptions create segments and keep custom exception names',
    text: L(
      'Traceback (most recent call last):',
      '  File "app/db.py", line 10, in connect',
      '    return sqlite3.connect(path)',
      'sqlite3.OperationalError: unable to open database file',
      '',
      'The above exception was the direct cause of the following exception:',
      '',
      'Traceback (most recent call last):',
      '  File "app/main.py", line 5, in <module>',
      '    connect()',
      '  File "app/db.py", line 12, in connect',
      '    raise DatabaseUnavailable("cannot open") from exc',
      'app.db.DatabaseUnavailable: cannot open'),
    frames: [
      { path: 'app/db.py', line: 10, func: 'connect', segment: 0 },
      { path: 'app/main.py', line: 5, func: '<module>', segment: 1 },
      { path: 'app/db.py', line: 12, func: 'connect', segment: 1 },
    ],
    errors: ['sqlite3.OperationalError: unable to open database file', 'app.db.DatabaseUnavailable: cannot open'],
  },
  {
    name: 'pseudo files are not frames',
    text: L(
      'Traceback (most recent call last):',
      '  File "<stdin>", line 1, in <module>',
      '  File "<frozen importlib._bootstrap>", line 1007, in _find_and_load',
      '  File "/home/user/proj/pkg/mod.py", line 3, in <module>',
      '    import missing',
      "ModuleNotFoundError: No module named 'missing'"),
    frames: [{ path: '/home/user/proj/pkg/mod.py', line: 3, func: '<module>' }],
    errors: ["ModuleNotFoundError: No module named 'missing'"],
  },
  {
    name: 'doctest failure',
    text: L(
      '**********************************************************************',
      'File "mylib/text.py", line 14, in mylib.text.slugify',
      'Failed example:',
      '    slugify("Hello World")',
      'Expected:',
      "    'hello-world'",
      'Got:',
      "    'hello world'",
      '**********************************************************************'),
    frames: [{ path: 'mylib/text.py', line: 14, func: 'mylib.text.slugify' }],
  },
  {
    name: 'Django plain-text error report patches line numbers from the code lines',
    text: L(
      'Traceback:',
      '',
      'File "/srv/app/venv/lib/python3.8/site-packages/django/core/handlers/exception.py" in inner',
      '  34.             response = get_response(request)',
      '',
      'File "/srv/app/shop/views.py" in checkout',
      '  88.     total = cart.total()',
      '',
      'Exception Type: AttributeError at /checkout/',
      "Exception Value: 'NoneType' object has no attribute 'total'"),
    frames: [
      { path: '/srv/app/venv/lib/python3.8/site-packages/django/core/handlers/exception.py', line: 34, func: 'inner' },
      { path: '/srv/app/shop/views.py', line: 88, func: 'checkout' },
    ],
    errors: ['Exception Type: AttributeError at /checkout/', "Exception Value: 'NoneType' object has no attribute 'total'"],
  },
  {
    name: 'IPython 8 traceback',
    text: L(
      '---------------------------------------------------------------------------',
      'ZeroDivisionError                         Traceback (most recent call last)',
      'Cell In[3], line 4',
      '      2     return 1 / x',
      '----> 4 f(0)',
      '',
      'File ~/proj/calc.py:2, in f(x)',
      '      1 def f(x):',
      '----> 2     return 1 / x',
      '',
      'ZeroDivisionError: division by zero'),
    frames: [{ path: '~/proj/calc.py', line: 2, func: 'f' }],
    errors: ['ZeroDivisionError: division by zero'],
  },
  {
    name: 'IPython 7 traceback awaits the arrow line',
    text: L(
      'ValueError                                Traceback (most recent call last)',
      '<ipython-input-3-6a5b> in <module>',
      '----> 1 run()',
      '',
      '/home/me/proj/runner.py in run(n)',
      '     10     for i in range(n):',
      '---> 11         step(i)',
      '',
      'ValueError: bad step'),
    frames: [{ path: '/home/me/proj/runner.py', line: 11, func: 'run' }],
    errors: ['ValueError: bad step'],
  },
  {
    name: 'traceback inside a markdown quote and ANSI colours',
    text: L(
      '> \u001b[31mTraceback (most recent call last):\u001b[0m',
      '>   File "/w/a.py", line 3, in go',
      '>     boom()',
      '> RuntimeError: kaput'),
    frames: [{ path: '/w/a.py', line: 3, func: 'go' }],
    errors: ['RuntimeError: kaput'],
  },
]);

runCases('pytest', [
  {
    name: 'long failure report',
    text: L(
      '=================================== FAILURES ===================================',
      '_______________________ test_parse_negative_number[-1] ________________________',
      '',
      'value = -1',
      '',
      '    def test_parse_negative_number(value):',
      '>       assert parse(value) == 1',
      'E       assert 2 == 1',
      'E        +  where 2 = parse(-1)',
      '',
      'tests/test_parser.py:27: AssertionError',
      '----------------------------- Captured stdout call -----------------------------',
      'parsing -1',
      '=========================== short test summary info ============================',
      'FAILED tests/test_parser.py::test_parse_negative_number[-1] - assert 2 == 1',
      '========================= 1 failed, 5 passed in 0.12s =========================='),
    frames: [{ path: 'tests/test_parser.py', line: 27, language: 'python' }],
    errors: ['assert 2 == 1', 'AssertionError'],
    tests: ['test_parse_negative_number[-1]', 'tests/test_parser.py::test_parse_negative_number[-1]'],
    isTrace: true,
  },
  {
    name: 'short traceback style lists the test first',
    text: L(
      'tests/test_api.py:15: in test_create',
      '    resp = client.post("/items", json=payload)',
      'src/api/client.py:44: in post',
      '    return self._request("POST", url, **kw)',
      'src/api/client.py:61: in _request',
      '    raise ApiError(resp.status_code)',
      'E   api.errors.ApiError: 500'),
    frames: [
      { path: 'tests/test_api.py', line: 15, func: 'test_create' },
      { path: 'src/api/client.py', line: 44, func: 'post' },
      { path: 'src/api/client.py', line: 61, func: '_request' },
    ],
    errors: ['api.errors.ApiError: 500'],
    innermostFirst: false,
  },
  {
    name: 'short summary only',
    text: L(
      'FAILED tests/unit/test_models.py::TestUser::test_email_unique - django.db.utils.IntegrityError: UNIQUE constraint failed: users.email',
      "ERROR tests/unit/test_views.py::test_index - fixture 'client' not found"),
    frames: [],
    errors: ['django.db.utils.IntegrityError: UNIQUE constraint failed: users.email', "fixture 'client' not found"],
    tests: ['tests/unit/test_models.py::TestUser::test_email_unique', 'tests/unit/test_views.py::test_index'],
    isTrace: true,
  },
  {
    name: 'verbose progress lines and xdist prefix',
    text: L(
      '[gw1] [ 50%] FAILED tests/test_io.py::test_read_closed',
      'tests/test_io.py::test_write PASSED                                      [ 60%]',
      'tests/test_io.py::test_flush FAILED                                      [ 70%]'),
    tests: ['tests/test_io.py::test_read_closed', 'tests/test_io.py::test_flush'],
  },
  {
    name: 'unittest report',
    text: L(
      '======================================================================',
      'FAIL: test_total (shop.tests.CartTest.test_total)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      '  File "/repo/shop/tests.py", line 31, in test_total',
      '    self.assertEqual(cart.total(), 10)',
      'AssertionError: 9 != 10'),
    frames: [{ path: '/repo/shop/tests.py', line: 31, func: 'test_total' }],
    errors: ['AssertionError: 9 != 10'],
    tests: ['test_total (shop.tests.CartTest.test_total)'],
  },
  {
    name: 'warnings keep a low priority but are reported',
    text: L('/repo/pkg/old.py:8: DeprecationWarning: use new_api instead', '  warnings.warn("use new_api instead", DeprecationWarning)'),
    frames: [{ path: '/repo/pkg/old.py', line: 8 }],
    errors: ['DeprecationWarning: use new_api instead'],
  },
]);

runCases('node', [
  {
    name: 'uncaught error with source pointer and express frames',
    text: L(
      '/app/src/server.js:41',
      "    throw new Error('boom');",
      '    ^',
      '',
      'Error: boom',
      '    at Server.handle (/app/src/server.js:41:11)',
      '    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)',
      '    at next (/app/node_modules/express/lib/router/route.js:137:13)',
      '    at processTicksAndRejections (node:internal/process/task_queues:96:5)'),
    frames: [
      { path: '/app/src/server.js', line: 41 },
      { path: '/app/src/server.js', line: 41, column: 11, func: 'Server.handle', language: 'javascript' },
      { path: '/app/node_modules/express/lib/router/layer.js', line: 95, column: 5, func: 'Layer.handle [as handle_request]' },
      { path: '/app/node_modules/express/lib/router/route.js', line: 137, column: 13, func: 'next' },
      { path: 'node:internal/process/task_queues', line: 96, column: 5, func: 'processTicksAndRejections' },
    ],
    errors: ['Error: boom'],
    innermostFirst: true,
  },
  {
    name: 'windows paths, new, async and placeholders',
    text: L(
      "TypeError: Cannot read properties of undefined (reading 'map')",
      '    at Object.<anonymous> (C:\\Users\\dev\\shop\\src\\cart.js:12:18)',
      '    at new Cart (C:\\Users\\dev\\shop\\src\\cart.js:5:9)',
      '    at async checkout (file:///C:/Users/dev/shop/src/checkout.mjs:30:7)',
      '    at async Promise.all (index 1)',
      '    at Array.map (<anonymous>)'),
    frames: [
      { path: 'C:/Users/dev/shop/src/cart.js', line: 12, column: 18, func: 'Object.<anonymous>' },
      { path: 'C:/Users/dev/shop/src/cart.js', line: 5, column: 9, func: 'new Cart' },
      { path: 'C:/Users/dev/shop/src/checkout.mjs', line: 30, column: 7, func: 'checkout' },
    ],
    errors: ["TypeError: Cannot read properties of undefined (reading 'map')"],
  },
  {
    name: 'jest failure',
    text: L(
      'FAIL src/cart.test.ts',
      '  ● Cart › applies discount',
      '',
      '    expect(received).toBe(expected) // Object.is equality',
      '',
      '    Expected: 90',
      '    Received: 100',
      '',
      '      12 |   const cart = new Cart([{ price: 100 }]);',
      '      13 |   cart.applyDiscount(0.1);',
      '    > 14 |   expect(cart.total()).toBe(90);',
      '         |                        ^',
      '',
      '      at Object.<anonymous> (src/cart.test.ts:14:26)',
      '      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)'),
    frames: [
      { path: 'src/cart.test.ts', line: 14, column: 26, func: 'Object.<anonymous>' },
      { path: 'node_modules/jest-circus/build/utils.js', line: 298, column: 28, func: 'Promise.then.completed' },
    ],
    errors: ['expect(received).toBe(expected) // Object.is equality'],
    tests: ['Cart › applies discount'],
    isTrace: true,
  },
  {
    name: 'mocha failure',
    text: L(
      '  1 passing (8ms)',
      '  1 failing',
      '',
      '  1) Cart',
      '       applies discount:',
      '',
      '      AssertionError: expected 100 to equal 90',
      '      + expected - actual',
      '',
      '      -100',
      '      +90',
      '',
      '      at Context.<anonymous> (test/cart.spec.js:21:30)',
      '      at processImmediate (node:internal/timers:476:21)'),
    frames: [
      { path: 'test/cart.spec.js', line: 21, column: 30, func: 'Context.<anonymous>' },
      { path: 'node:internal/timers', line: 476, column: 21, func: 'processImmediate' },
    ],
    errors: ['AssertionError: expected 100 to equal 90'],
    tests: ['Cart applies discount'],
  },
  {
    name: 'vitest failure',
    text: L(
      ' FAIL  src/math.test.ts > add > handles negatives',
      'AssertionError: expected 1 to be 2 // Object.is equality',
      '',
      '- Expected',
      '+ Received',
      '',
      '- 2',
      '+ 1',
      '',
      ' ❯ src/math.test.ts:8:18'),
    frames: [{ path: 'src/math.test.ts', line: 8, column: 18 }],
    errors: ['AssertionError: expected 1 to be 2 // Object.is equality'],
    tests: ['add > handles negatives'],
  },
  {
    name: 'webpack and next.js bundles',
    text: L(
      'Error: Hydration failed',
      '    at throwOnHydrationMismatch (webpack-internal:///./node_modules/react-dom/cjs/react-dom.development.js:12507:9)',
      '    at HomePage (webpack-internal:///./src/pages/index.tsx?c3a1:33:9)',
      '    at renderWithHooks (webpack://_N_E/./node_modules/react-dom/cjs/react-dom.development.js?abcd:10021:18)'),
    frames: [
      { path: './node_modules/react-dom/cjs/react-dom.development.js', line: 12507, column: 9, func: 'throwOnHydrationMismatch' },
      { path: './src/pages/index.tsx', line: 33, column: 9, func: 'HomePage' },
      { path: './node_modules/react-dom/cjs/react-dom.development.js', line: 10021, column: 18, func: 'renderWithHooks' },
    ],
  },
  {
    name: 'browser stack formats',
    text: L(
      'render@https://cdn.example.com/static/js/main.4f2a.js:1:23456',
      'onClick@file:///Users/me/app/index.js:10:5',
      'at t.render (https://cdn.example.com/static/js/vendor.js?v=12:2:99)'),
    frames: [
      { path: '/static/js/main.4f2a.js', line: 1, column: 23456, func: 'render' },
      { path: '/Users/me/app/index.js', line: 10, column: 5, func: 'onClick' },
      { path: '/static/js/vendor.js', line: 2, column: 99, func: 't.render' },
    ],
  },
  {
    name: 'stack inside a JSON log line with escaped newlines',
    text: '{"level":"error","msg":"fail","stack":"Error: fail\\n    at run (/srv/app/job.js:7:3)\\n    at /srv/app/main.js:2:1"}',
    frames: [
      { path: '/srv/app/job.js', line: 7, column: 3, func: 'run' },
      { path: '/srv/app/main.js', line: 2, column: 1 },
    ],
  },
]);

runCases('typescript tooling', [
  {
    name: 'tsc diagnostics in both formats',
    text: L(
      "src/index.ts(12,5): error TS2304: Cannot find name 'foo'.",
      "src/util/strings.ts:7:3 - error TS2322: Type 'string' is not assignable to type 'number'."),
    frames: [{ path: 'src/index.ts', line: 12, column: 5, language: 'javascript' }, { path: 'src/util/strings.ts', line: 7, column: 3 }],
    errors: ["error TS2304: Cannot find name 'foo'.", "error TS2322: Type 'string' is not assignable to type 'number'."],
  },
  {
    name: 'eslint stylish rows attach to the preceding path',
    text: L(
      '/home/dev/proj/src/app.js',
      "  12:5   error    'foo' is not defined          no-undef",
      '  30:10  warning  Unexpected console statement  no-console',
      '',
      '/home/dev/proj/src/util.js',
      '  3:1  error  Parsing error: Unexpected token'),
    frames: [
      { path: '/home/dev/proj/src/app.js', line: 12, column: 5 },
      { path: '/home/dev/proj/src/app.js', line: 30, column: 10 },
      { path: '/home/dev/proj/src/util.js', line: 3, column: 1 },
    ],
  },
  {
    name: 'github workflow annotations',
    text: L('::error file=src/app.py,line=12,col=5::Undefined variable x', '::warning file=src/app.py,line=30::Line too long', '::error file=web/a.tsx,line=4::bad jsx'),
    frames: [
      { path: 'src/app.py', line: 12, column: 5, language: 'python' },
      { path: 'src/app.py', line: 30 },
      { path: 'web/a.tsx', line: 4 },
    ],
    errors: ['Undefined variable x', 'bad jsx'],
  },
]);

runCases('java and kotlin', [
  {
    name: 'uncaught exception',
    text: L(
      'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null',
      '\tat com.acme.text.Trimmer.trim(Trimmer.java:17)',
      '\tat com.acme.App.main(App.java:9)'),
    frames: [
      { path: 'Trimmer.java', line: 17, func: 'com.acme.text.Trimmer.trim', qualifier: 'com.acme.text', language: 'java' },
      { path: 'App.java', line: 9, func: 'com.acme.App.main', qualifier: 'com.acme' },
    ],
    errors: ['Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null'],
    innermostFirst: true,
  },
  {
    name: 'caused by chain, omitted frames and module prefixes',
    text: L(
      "org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'userService'",
      '\tat org.springframework.beans.factory.support.AbstractAutowireCapableBeanFactory.createBean(AbstractAutowireCapableBeanFactory.java:597)',
      '\tat java.base/java.lang.Thread.run(Thread.java:833)',
      'Caused by: java.lang.IllegalArgumentException: bad config',
      '\tat com.acme.config.Loader.load(Loader.java:33)',
      '\tat com.acme.service.UserService.<init>(UserService.java:21)',
      '\t... 23 more'),
    frames: [
      { path: 'AbstractAutowireCapableBeanFactory.java', line: 597, segment: 0 },
      { path: 'Thread.java', line: 833, func: 'java.lang.Thread.run', segment: 0 },
      { path: 'Loader.java', line: 33, func: 'com.acme.config.Loader.load', segment: 1 },
      { path: 'UserService.java', line: 21, func: 'com.acme.service.UserService.<init>', segment: 1 },
    ],
    errors: [
      "org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'userService'",
      'Caused by: java.lang.IllegalArgumentException: bad config',
    ],
  },
  {
    name: 'logback decorated frames',
    text: L(
      '2024-05-01 12:00:01.123 ERROR 1234 --- [nio-8080-exec-1] c.a.web.OrderController : Failed',
      'java.lang.IllegalStateException: no stock',
      '\tat com.acme.order.OrderService.reserve(OrderService.java:88) ~[classes/:na]',
      '\tat com.acme.web.OrderController.create(OrderController.java:40) ~[classes/:na]',
      '\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103) ~[na:na]',
      '\t... 54 common frames omitted'),
    frames: [
      { path: 'OrderService.java', line: 88, func: 'com.acme.order.OrderService.reserve' },
      { path: 'OrderController.java', line: 40, func: 'com.acme.web.OrderController.create' },
      { path: 'DirectMethodHandleAccessor.java', line: 103 },
    ],
    errors: ['java.lang.IllegalStateException: no stock'],
  },
  {
    name: 'kotlin frames and unknown sources',
    text: L(
      'java.lang.IllegalStateException: Check failed.',
      '\tat com.acme.billing.InvoiceKt.total(Invoice.kt:14)',
      '\tat com.acme.billing.InvoiceTest.totals add up(InvoiceTest.kt:22)',
      '\tat jdk.internal.reflect.GeneratedMethodAccessor1.invoke(Unknown Source)',
      '\tat sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)'),
    frames: [
      { path: 'Invoice.kt', line: 14, language: 'kotlin', func: 'com.acme.billing.InvoiceKt.total' },
      { path: 'InvoiceTest.kt', line: 22, language: 'kotlin' },
    ],
  },
  {
    name: 'surefire report',
    text: L(
      '[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.05 s <<< FAILURE! - in com.acme.CartTest',
      '[ERROR] com.acme.CartTest.appliesDiscount  Time elapsed: 0.012 s  <<< FAILURE!',
      'org.opentest4j.AssertionFailedError: expected: <90> but was: <100>',
      '\tat org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)',
      '\tat com.acme.CartTest.appliesDiscount(CartTest.java:31)',
      '[ERROR] Failures: ',
      '[ERROR]   CartTest.appliesDiscount:31 expected: <90> but was: <100>'),
    frames: [{ path: 'AssertionUtils.java', line: 55 }, { path: 'CartTest.java', line: 31, func: 'com.acme.CartTest.appliesDiscount' }],
    errors: ['org.opentest4j.AssertionFailedError: expected: <90> but was: <100>'],
    tests: ['com.acme.CartTest', 'com.acme.CartTest.appliesDiscount', 'CartTest.appliesDiscount'],
    isTrace: true,
  },
  {
    name: 'maven compiler errors',
    text: L(
      '[ERROR] COMPILATION ERROR : ',
      '[ERROR] /home/dev/app/src/main/java/com/acme/Cart.java:[42,17] cannot find symbol',
      '[ERROR]   symbol:   method totl()',
      '[ERROR]   location: variable cart of type com.acme.Cart'),
    frames: [{ path: '/home/dev/app/src/main/java/com/acme/Cart.java', line: 42, column: 17 }],
    errors: ['cannot find symbol', 'symbol: method totl()', 'location: variable cart of type com.acme.Cart'],
  },
  {
    name: 'javac and gradle',
    text: L(
      'src/main/java/com/acme/Cart.java:42: error: cannot find symbol',
      '        return items.stream().mapToInt(Item::price).sum() + shipping();',
      '                                                            ^',
      '  symbol:   method shipping()',
      '  location: class Cart',
      '1 error',
      '',
      'CartTest > appliesDiscount() FAILED'),
    frames: [{ path: 'src/main/java/com/acme/Cart.java', line: 42 }],
    errors: ['error: cannot find symbol', 'symbol: method shipping()', 'location: class Cart'],
    tests: ['CartTest > appliesDiscount()'],
  },
  {
    name: 'junit 3 style failures',
    text: L('Failed tests:   testTotal(com.acme.CartTest): expected:<90> but was:<100>', 'Tests run: 4, Failures: 1, Errors: 0, Skipped: 0'),
    tests: ['testTotal(com.acme.CartTest)'],
  },
]);

runCases('go', [
  {
    name: 'panic with goroutine frames and module paths',
    text: L(
      'panic: runtime error: index out of range [5] with length 3',
      '',
      'goroutine 1 [running]:',
      'main.foo(0x1234, 0xc000010000)',
      '\t/home/u/proj/main.go:123 +0x1d',
      'github.com/acme/pkg.(*Server).Handle(0xc000, {0x4b3f60, 0x4e5a30})',
      '\t/home/u/go/pkg/mod/github.com/acme/pkg@v1.2.3/server.go:45 +0x25',
      'main.main()',
      '\t/home/u/proj/main.go:20 +0x25',
      'exit status 2'),
    frames: [
      { path: '/home/u/proj/main.go', line: 123, func: 'foo', qualifier: 'main', language: 'go' },
      { path: '/home/u/go/pkg/mod/github.com/acme/pkg@v1.2.3/server.go', line: 45, func: 'Server.Handle', qualifier: 'github.com/acme/pkg' },
      { path: '/home/u/proj/main.go', line: 20, func: 'main', qualifier: 'main' },
    ],
    errors: ['panic: runtime error: index out of range [5] with length 3'],
    innermostFirst: true,
  },
  {
    name: 'goroutine created by',
    text: L(
      'panic: send on closed channel',
      '',
      'goroutine 18 [running]:',
      'main.worker(0xc0000a4000)',
      '\t/work/proc/worker.go:31 +0x65',
      'created by main.start in goroutine 1',
      '\t/work/proc/start.go:14 +0x8e'),
    frames: [
      { path: '/work/proc/worker.go', line: 31, func: 'worker', qualifier: 'main' },
      { path: '/work/proc/start.go', line: 14, func: 'start', qualifier: 'main' },
    ],
    errors: ['panic: send on closed channel'],
  },
  {
    name: 'testify failure',
    text: L(
      '--- FAIL: TestTotal (0.00s)',
      '    cart_test.go:27: ',
      '        \tError Trace:\t/home/dev/shop/cart_test.go:27',
      '        \tError:      \tNot equal: ',
      '        \t            \texpected: 90',
      '        \t            \tactual  : 100',
      '        \tTest:       \tTestTotal',
      'FAIL',
      'exit status 1',
      'FAIL\tgithub.com/acme/shop\t0.004s'),
    frames: [{ path: 'cart_test.go', line: 27, language: 'go' }],
    errors: ['Error: Not equal:'],
    tests: ['TestTotal'],
    isTrace: true,
  },
  {
    name: 'compile errors',
    text: L('# github.com/acme/shop/cart', 'cart/cart.go:42:9: undefined: shipping', 'cart/cart.go:57:2: missing return'),
    frames: [{ path: 'cart/cart.go', line: 42, column: 9 }, { path: 'cart/cart.go', line: 57, column: 2 }],
    errors: ['undefined: shipping', 'missing return'],
  },
  {
    name: 'subtests and relative paths',
    text: L('=== RUN   TestParse/empty', './parse_test.go:19: want "", got "x"', '    --- FAIL: TestParse/empty (0.00s)', '--- FAIL: TestParse (0.00s)'),
    frames: [{ path: './parse_test.go', line: 19 }],
    tests: ['TestParse/empty', 'TestParse'],
  },
]);

runCases('rust', [
  {
    name: 'new style panic with backtrace',
    text: L(
      "thread 'main' panicked at src/lib.rs:12:5:",
      'called `Option::unwrap()` on a `None` value',
      'stack backtrace:',
      '   0: rust_begin_unwind',
      '             at /rustc/abc123/library/std/src/panicking.rs:593:5',
      '   2: mycrate::foo::h0123456789abcdef',
      '             at ./src/x.rs:10:5',
      '   3: mycrate::main',
      '             at ./src/main.rs:4:5'),
    frames: [
      { path: 'src/lib.rs', line: 12, column: 5, language: 'rust' },
      { path: '/rustc/abc123/library/std/src/panicking.rs', line: 593, column: 5, func: 'rust_begin_unwind' },
      { path: './src/x.rs', line: 10, column: 5, func: 'mycrate::foo', qualifier: 'mycrate' },
      { path: './src/main.rs', line: 4, column: 5, func: 'mycrate::main' },
    ],
    errors: ["thread 'main' panicked at src/lib.rs:12:5: called `Option::unwrap()` on a `None` value"],
    innermostFirst: true,
  },
  {
    name: 'old style panic message',
    text: "thread 'tokio-runtime-worker' panicked at 'index out of bounds: the len is 3 but the index is 5', src/buf.rs:77:13",
    frames: [{ path: 'src/buf.rs', line: 77, column: 13 }],
    errors: ["thread 'tokio-runtime-worker' panicked at src/buf.rs:77:13: index out of bounds: the len is 3 but the index is 5"],
  },
  {
    name: 'compile error with arrow',
    text: L(
      'error[E0382]: borrow of moved value: `v`',
      '  --> src/main.rs:6:20',
      '   |',
      '4  |     let v = vec![1, 2, 3];',
      '   |         - move occurs because `v` has type `Vec<i32>`',
      '6  |     println!("{:?}", v);',
      '   |                      ^ value borrowed here after move',
      '',
      'error: aborting due to previous error'),
    frames: [{ path: 'src/main.rs', line: 6, column: 20 }],
    errors: ['error[E0382]: borrow of moved value: `v`'],
  },
  {
    name: 'cargo test failure',
    text: L(
      'running 2 tests',
      'test parser::tests::parses_ints ... ok',
      'test parser::tests::rejects_empty ... FAILED',
      '',
      'failures:',
      '',
      '---- parser::tests::rejects_empty stdout ----',
      "thread 'parser::tests::rejects_empty' panicked at src/parser.rs:88:9:",
      'assertion `left == right` failed',
      '  left: 1',
      ' right: 0',
      '',
      'failures:',
      '    parser::tests::rejects_empty',
      '',
      'test result: FAILED. 1 passed; 1 failed; 0 ignored'),
    frames: [{ path: 'src/parser.rs', line: 88, column: 9 }],
    errors: ["thread 'parser::tests::rejects_empty' panicked at src/parser.rs:88:9: assertion `left == right` failed"],
    tests: ['parser::tests::rejects_empty'],
    isTrace: true,
  },
]);

runCases('c and c++', [
  {
    name: 'gcc diagnostics',
    text: L(
      "src/net/socket.c: In function 'sock_open':",
      "src/net/socket.c:57:13: error: 'fd' undeclared (first use in this function)",
      '   57 |     if (fd < 0)',
      '      |             ^~',
      'src/net/socket.c:57:13: note: each undeclared identifier is reported only once for each function it appears in',
      'src/net/socket.h:12:10: fatal error: sys/epoll.h: No such file or directory'),
    frames: [{ path: 'src/net/socket.c', line: 57, column: 13, language: 'c' }, { path: 'src/net/socket.h', line: 12, column: 10 }],
    errors: ["error: 'fd' undeclared (first use in this function)", 'fatal error: sys/epoll.h: No such file or directory'],
  },
  {
    name: 'gdb backtrace',
    text: L(
      'Program received signal SIGSEGV, Segmentation fault.',
      '0x0000555555555171 in parse_header (buf=0x0) at src/parser.c:88',
      '88\t    return buf[0];',
      '(gdb) bt',
      '#0  0x0000555555555171 in parse_header (buf=0x0) at src/parser.c:88',
      '#1  0x00005555555551c3 in handle (fd=3) at src/server.c:140',
      '#2  0x0000555555555230 in main (argc=1, argv=0x7fffffffe0a8) at src/main.c:22'),
    frames: [
      { path: 'src/parser.c', line: 88, func: 'parse_header', language: 'c' },
      { path: 'src/server.c', line: 140, func: 'handle' },
      { path: 'src/main.c', line: 22, func: 'main' },
    ],
    errors: ['Program received signal SIGSEGV, Segmentation fault.'],
    innermostFirst: true,
  },
  {
    name: 'address sanitizer',
    text: L(
      '==4242==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000014 at pc 0x0000004f2d5a bp 0x7ffc sp 0x7ffc',
      'READ of size 4 at 0x602000000014 thread T0',
      '    #0 0x4f2d5a in sum_array /home/dev/proj/src/util.c:31:12',
      '    #1 0x4f3010 in main /home/dev/proj/src/main.c:9:5',
      '    #2 0x7f3c1a8f0d8f  (/lib/x86_64-linux-gnu/libc.so.6+0x29d8f)',
      'SUMMARY: AddressSanitizer: heap-buffer-overflow /home/dev/proj/src/util.c:31:12 in sum_array'),
    frames: [
      { path: '/home/dev/proj/src/util.c', line: 31, column: 12, func: 'sum_array' },
      { path: '/home/dev/proj/src/main.c', line: 9, column: 5, func: 'main' },
    ],
    errors: [
      'ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000014 at pc 0x0000004f2d5a bp 0x7ffc sp 0x7ffc',
      'SUMMARY: AddressSanitizer: heap-buffer-overflow /home/dev/proj/src/util.c:31:12 in sum_array',
    ],
  },
  {
    name: 'valgrind',
    text: L(
      '==9921== Invalid read of size 4',
      '==9921==    at 0x1091C3: sum (util.c:31)',
      '==9921==    by 0x109205: main (main.c:9)',
      "==9921==  Address 0x4a47044 is 0 bytes after a block of size 4 alloc'd"),
    frames: [{ path: 'util.c', line: 31, func: 'sum', language: 'c' }, { path: 'main.c', line: 9, func: 'main' }],
    errors: ['Invalid read of size 4'],
  },
  {
    name: 'ubsan and assert',
    text: L(
      "src/calc.c:19:12: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'",
      "calc: src/calc.c:44: divide: Assertion `b != 0' failed."),
    frames: [{ path: 'src/calc.c', line: 19, column: 12 }],
    errors: [
      "runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'",
      "Assertion `b != 0' failed.",
    ],
  },
  {
    name: 'linker error and msvc',
    text: L(
      "/usr/bin/ld: main.o: in function `main':",
      "main.c:(.text+0x1a): undefined reference to `helper'",
      'C:\\proj\\src\\Widget.cpp(88,12): error C2065: \'count\': undeclared identifier'),
    frames: [{ path: 'main.c' }, { path: 'C:/proj/src/Widget.cpp', line: 88, column: 12 }],
  },
]);

runCases('csharp', [
  {
    name: 'null reference with windows path',
    text: L(
      'System.NullReferenceException: Object reference not set to an instance of an object.',
      '   at Acme.Services.UserService.GetUser(Int32 id) in C:\\Users\\x\\proj\\UserService.cs:line 42',
      '   at Acme.Program.Main(String[] args) in /src/Program.cs:line 5',
      '   at System.Threading.Tasks.Task.Run()'),
    frames: [
      { path: 'C:/Users/x/proj/UserService.cs', line: 42, func: 'Acme.Services.UserService.GetUser', qualifier: 'Acme.Services', language: 'csharp' },
      { path: '/src/Program.cs', line: 5, func: 'Acme.Program.Main' },
    ],
    errors: ['System.NullReferenceException: Object reference not set to an instance of an object.'],
    innermostFirst: true,
  },
  {
    name: 'aggregate exception with async state machine',
    text: L(
      'System.AggregateException: One or more errors occurred. ---> System.InvalidOperationException: Sequence contains no elements',
      '   at System.Linq.Enumerable.First[TSource](IEnumerable`1 source)',
      '   at Shop.Cart.CheapestItem() in /src/Shop/Cart.cs:line 58',
      '   at Shop.Program.<Main>d__1.MoveNext() in /src/Shop/Program.cs:line 12',
      '   --- End of inner exception stack trace ---',
      '   at Shop.Program.Main(String[] args) in /src/Shop/Program.cs:line 9'),
    frames: [
      { path: '/src/Shop/Cart.cs', line: 58, func: 'Shop.Cart.CheapestItem', segment: 0 },
      { path: '/src/Shop/Program.cs', line: 12, func: 'Shop.Program.<Main>d__1.MoveNext', segment: 0 },
      { path: '/src/Shop/Program.cs', line: 9, func: 'Shop.Program.Main', segment: 1 },
    ],
    errors: ['System.AggregateException: One or more errors occurred. ---> System.InvalidOperationException: Sequence contains no elements'],
  },
  {
    name: 'dotnet test output',
    text: L(
      '  Failed Shop.Tests.CartTests.AppliesDiscount [12 ms]',
      '  Error Message:',
      '   Assert.Equal() Failure',
      'Expected: 90',
      'Actual:   100',
      '  Stack Trace:',
      '     at Shop.Tests.CartTests.AppliesDiscount() in /src/Shop.Tests/CartTests.cs:line 31'),
    frames: [{ path: '/src/Shop.Tests/CartTests.cs', line: 31, func: 'Shop.Tests.CartTests.AppliesDiscount' }],
    tests: ['Shop.Tests.CartTests.AppliesDiscount'],
  },
  {
    name: 'msbuild error',
    text: "/src/Shop/Cart.cs(58,17): error CS0103: The name 'total' does not exist in the current context [/src/Shop/Shop.csproj]",
    frames: [{ path: '/src/Shop/Cart.cs', line: 58, column: 17, language: 'csharp' }],
    errors: ["error CS0103: The name 'total' does not exist in the current context [/src/Shop/Shop.csproj]"],
  },
]);

runCases('ruby', [
  {
    name: 'no method error',
    text: L(
      "/app/models/user.rb:12:in `validate!': undefined method `foo' for nil:NilClass (NoMethodError)",
      "\tfrom /app/models/user.rb:3:in `block in <main>'",
      "\tfrom /usr/local/bundle/gems/activesupport-6.1.4/lib/active_support/x.rb:9:in `call'"),
    frames: [
      { path: '/app/models/user.rb', line: 12, func: 'validate!', language: 'ruby' },
      { path: '/app/models/user.rb', line: 3, func: '<main>' },
      { path: '/usr/local/bundle/gems/activesupport-6.1.4/lib/active_support/x.rb', line: 9, func: 'call' },
    ],
    errors: ["undefined method `foo' for nil:NilClass (NoMethodError)"],
    innermostFirst: true,
  },
  {
    name: 'ruby 3.4 quoting',
    text: L("lib/cart.rb:30:in 'Cart#total': divided by 0 (ZeroDivisionError)", "\tfrom lib/app.rb:8:in 'Object#<main>'"),
    frames: [{ path: 'lib/cart.rb', line: 30, func: 'Cart#total' }, { path: 'lib/app.rb', line: 8, func: 'Object#<main>' }],
    errors: ['divided by 0 (ZeroDivisionError)'],
  },
  {
    name: 'rspec failure',
    text: L(
      'Failures:',
      '',
      '  1) Cart#total applies discount',
      '     Failure/Error: expect(cart.total).to eq(90)',
      '',
      '       expected: 90',
      '            got: 100',
      '',
      '       (compared using ==)',
      "     # ./spec/cart_spec.rb:14:in `block (3 levels) in <top (required)>'",
      "     # ./lib/cart.rb:30:in `total'",
      '',
      'Finished in 0.01 seconds (files took 0.2 seconds to load)',
      '1 example, 1 failure',
      '',
      'Failed examples:',
      '',
      'rspec ./spec/cart_spec.rb:12 # Cart#total applies discount'),
    frames: [{ path: './spec/cart_spec.rb', line: 14, func: '<top (required)>' }, { path: './lib/cart.rb', line: 30, func: 'total' }],
    errors: ['Failure/Error: expect(cart.total).to eq(90)'],
    tests: ['Cart#total applies discount'],
  },
  {
    name: 'minitest error with rails paths',
    text: L(
      'Error:',
      'CartTest#test_total:',
      "NoMethodError: undefined method `price' for nil:NilClass",
      "    app/models/cart.rb:21:in `block in total'",
      "    app/models/cart.rb:20:in `sum'",
      "    app/models/cart.rb:20:in `total'",
      "    test/models/cart_test.rb:9:in `block in <class:CartTest>'"),
    frames: [
      { path: 'app/models/cart.rb', line: 21, func: 'total' },
      { path: 'app/models/cart.rb', line: 20, func: 'sum' },
      { path: 'app/models/cart.rb', line: 20, func: 'total' },
      { path: 'test/models/cart_test.rb', line: 9, func: '<class:CartTest>' },
    ],
    errors: ["NoMethodError: undefined method `price' for nil:NilClass"],
    tests: ['CartTest#test_total'],
  },
]);

runCases('php', [
  {
    name: 'uncaught exception with trace',
    text: L(
      'PHP Fatal error:  Uncaught Exception: boom in /var/www/app/Foo.php:42',
      'Stack trace:',
      "#0 /var/www/app/Foo.php(42): Foo->bar()",
      "#1 /var/www/index.php(5): Foo::baz('arg')",
      '#2 [internal function]: Foo->{closure}()',
      '#3 {main}',
      '  thrown in /var/www/app/Foo.php on line 42'),
    frames: [
      { path: '/var/www/app/Foo.php', line: 42, language: 'php' },
      { path: '/var/www/app/Foo.php', line: 42, func: 'Foo->bar', qualifier: 'Foo' },
      { path: '/var/www/index.php', line: 5, func: 'Foo::baz' },
      { path: '/var/www/app/Foo.php', line: 42 },
    ],
    errors: ['PHP Fatal error: Uncaught Exception: boom'],
  },
  {
    name: 'warning with on line suffix',
    text: 'Warning: Undefined variable $x in /var/www/html/index.php on line 12',
    frames: [{ path: '/var/www/html/index.php', line: 12, language: 'php' }],
  },
  {
    name: 'phpunit failure',
    text: L(
      'There was 1 failure:',
      '',
      '1) Tests\\Unit\\CartTest::testTotal',
      'Failed asserting that 100 matches expected 90.',
      '',
      '/var/www/html/tests/Unit/CartTest.php:31',
      '/var/www/html/vendor/phpunit/phpunit/src/Framework/TestCase.php:1234',
      '',
      'FAILURES!',
      'Tests: 3, Assertions: 4, Failures: 1.'),
    frames: [
      { path: '/var/www/html/tests/Unit/CartTest.php', line: 31, language: 'php' },
      { path: '/var/www/html/vendor/phpunit/phpunit/src/Framework/TestCase.php', line: 1234 },
    ],
    errors: ['Failed asserting that 100 matches expected 90.'],
    tests: ['Tests\\Unit\\CartTest::testTotal'],
  },
]);

runCases('swift and kotlin tooling', [
  {
    name: 'swift runtime and xctest',
    text: L(
      'Fatal error: Index out of range: file Swift/Array.swift, line 444',
      "/Users/dev/App/Sources/Cart.swift:31:20: error: value of type 'Cart' has no member 'totl'",
      "Test Case '-[AppTests.CartTests testTotal]' failed (0.002 seconds).",
      '/Users/dev/App/Tests/CartTests.swift:15: error: -[AppTests.CartTests testTotal] : XCTAssertEqual failed: ("100") is not equal to ("90")'),
    frames: [
      { path: 'Swift/Array.swift', line: 444, language: 'swift' },
      { path: '/Users/dev/App/Sources/Cart.swift', line: 31, column: 20 },
      { path: '/Users/dev/App/Tests/CartTests.swift', line: 15 },
    ],
    tests: ['AppTests.CartTests.testTotal'],
  },
  {
    name: 'kotlin compiler',
    text: L(
      'e: /home/dev/app/src/main/kotlin/Cart.kt: (31, 20): Unresolved reference: totl',
      'e: file:///home/dev/app/src/main/kotlin/Util.kt:12:5 Type mismatch: inferred type is String but Int was expected'),
    frames: [
      { path: '/home/dev/app/src/main/kotlin/Cart.kt', line: 31, column: 20, language: 'kotlin' },
      { path: '/home/dev/app/src/main/kotlin/Util.kt', line: 12, column: 5, language: 'kotlin' },
    ],
    errors: ['Unresolved reference: totl'],
  },
]);

// ---------------------------------------------------------------------------------------------------------------
// Normalisation and robustness

const PY = L('Traceback (most recent call last):', '  File "/a/b.py", line 3, in f', '    g()', 'ValueError: nope');

test('CRLF, lone CR, tabs and ANSI colours are normalised away', () => {
  const expected = parseQuery(PY);
  assert.equal(expected.frames.length, 1);
  const variants = [
    PY.replace(/\n/g, '\r\n'),
    PY.replace(/\n/g, '\r'),
    PY.replace(/^ {2}/gm, '\t'),
    PY.split('\n').map(line => `\u001b[1;31m${line}\u001b[0m`).join('\n'),
    PY.split('\n').map(line => `[1;31m${line}[0m`).join('\n'),
  ];
  for (const variant of variants) assert.deepEqual(parseQuery(variant), expected);
});

test('binary noise and control characters do not break parsing', () => {
  const noisy = `\u0000\u0001\u0002${PY.split('\n').join('\u0007\n')}\ufffd\ufffd`;
  assert.deepEqual(parseQuery(noisy), parseQuery(PY));
});

test('empty and non-string input is harmless', () => {
  for (const value of [undefined, null, 42, {}, [], '', '   ', '\n\n']) {
    const parsed = parseQuery(value as unknown as string);
    assert.deepEqual(parsed.frames, []);
    assert.equal(parsed.isTrace, false);
    assert.deepEqual(parsed.errorLines, []);
  }
  assert.equal(condenseQuery(undefined as unknown as string), '');
  assert.equal(condenseQuery(''), '');
  assert(condenseQuery('   \n  ').length > 0, 'whitespace-only input is not turned into an empty string');
  assert(condenseQuery('\u0000\u0001\u0002').length > 0);
});

test('unicode text survives parsing and condensing', () => {
  const text = L('Erreur: le fichier « données.csv » est introuvable', '  File "/srv/prøject/módulo.py", line 4, in lé_ée', '    x()', 'FileNotFoundError: [Errno 2] 没有那个文件: \'数据.csv\'');
  const parsed = parseQuery(text);
  assert.equal(parsed.frames[0].path, '/srv/prøject/módulo.py');
  assert.equal(parsed.frames[0].func, 'lé_ée');
  assert(condenseQuery(text).includes('FileNotFoundError'));
});

test('absurdly long lines are windowed: frames inside them are found, raw stays bounded', () => {
  const line = `${'noise '.repeat(20_000)}   at foo (/srv/app/a.js:1:2)   ${'x'.repeat(150_000)}   at bar (/srv/app/b.js:3:4)`;
  const parsed = parseQuery(line);
  assert.deepEqual(parsed.frames.map(f => f.func), ['foo', 'bar']);
  assert(parsed.frames.every(f => f.raw.length <= 300));
  const flattened = parseQuery(`Error: boom${Array.from({ length: 30 }, (_, i) => `    at fn${i} (/srv/app/file${i}.js:${i + 1}:5)`).join('')}`);
  assert.equal(flattened.frames.length, 30);
  assert.equal(flattened.frames[29].func, 'fn29');
});

test('frames beyond the cap keep the head and the tail', () => {
  const text = Array.from({ length: 12_000 }, (_, i) => `    at f${i} (/srv/app/file${i}.js:${i + 1}:1)`).join('\n');
  const parsed = parseQuery(text);
  assert.equal(parsed.frames.length, 5000);
  assert.equal(parsed.frames[0].func, 'f0');
  assert.equal(parsed.frames[4999].func, 'f11999');
  assert(parsed.frames.every((f, i) => f.index === i));
});

test('identical consecutive frames (recursion) collapse into one', () => {
  const text = L('Traceback (most recent call last):', ...Array.from({ length: 500 }, () => '  File "/app/tree.py", line 17, in walk\n    return walk(node.parent)'), 'RecursionError: maximum recursion depth exceeded');
  assert.equal(parseQuery(text).frames.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// isTrace

test('isTrace needs a frame, or an error line together with a failure marker', () => {
  const negatives = [
    'This test should not fail when the cache is warm.',
    'Error handling is inconsistent in the parser; see the discussion above.',
    L('1) install the package', '2) run the tests', '3) observe the failure'),
    'The function raises an exception sometimes but I cannot reproduce it.',
    'ValueError: raised when the value is out of range',
    'See src/app.py:12 for the relevant code.',
    'at the end of the day, nobody expects the parser to fail at line 12',
  ];
  for (const text of negatives) assert.equal(parseQuery(text).isTrace, false, text);
  const positives = [PY, 'src/a.ts(1,2): error TS2304: nope', L('FAILED tests/a.py::t - KeyError: 1'), '    at foo (/a.js:1:2)', L('--- FAIL: TestX (0.00s)', 'panic: boom')];
  for (const text of positives) assert.equal(parseQuery(text).isTrace, true, text);
});

// ---------------------------------------------------------------------------------------------------------------
// Symbols, quoted strings and paths

test('symbols, quoted strings and paths from an issue text', () => {
  const issue = L(
    '`DataFrame.groupby` ignores `sort=False` when `by` is a `Grouper`.',
    'See pandas/core/groupby/grouper.py:210 and [the helper](src/utils/helpers.ts) and C:\\work\\repo\\lib\\tool.cs.',
    'It raises "Cannot reindex on an axis with duplicate labels" unexpectedly.',
    'https://github.com/org/repo/blob/0a1b2c3d/lib/core/engine.rb#L12-L20',
    '```python',
    'def resolve_keys(self, obj):',
    '    return self._get_grouper(obj, MAX_RETRIES)',
    '```');
  const parsed = parseQuery(issue);
  for (const symbol of ['DataFrame.groupby', 'groupby', 'resolve_keys', '_get_grouper', 'MAX_RETRIES', 'Grouper']) assert(parsed.symbols.includes(symbol), `symbol ${symbol} in ${JSON.stringify(parsed.symbols)}`);
  for (const word of ['when', 'unexpectedly', 'raises', 'the', 'self']) assert(!parsed.symbols.includes(word), `plain word ${word} is not a symbol`);
  assert(parsed.symbols.length <= 60 && new Set(parsed.symbols).size === parsed.symbols.length);
  assert.deepEqual(parsed.paths, ['pandas/core/groupby/grouper.py', 'src/utils/helpers.ts', 'C:/work/repo/lib/tool.cs', 'lib/core/engine.rb']);
  assert(parsed.quoted.includes('Cannot reindex on an axis with duplicate labels'));
  assert(parsed.quoted.every(q => q.length >= 8));
});

test('symbols from a trace put application frames first and skip builtin exceptions', () => {
  const parsed = parseQuery(L('Traceback (most recent call last):', '  File "/app/svc/checkout.py", line 9, in place_order', '    cart.total()',
    '  File "/usr/lib/python3.9/threading.py", line 954, in run', '    self._target()', '  File "/app/svc/cart.py", line 31, in Cart.total', '    return self._sum()', "AttributeError: 'NoneType' object has no attribute 'price'"));
  assert.equal(parsed.symbols[0], 'Cart.total');
  assert(parsed.symbols.includes('place_order') && parsed.symbols.includes('total') && parsed.symbols.includes('Cart'));
  assert(!parsed.symbols.includes('AttributeError') && !parsed.symbols.includes('run') && !parsed.symbols.includes('threading'));
  assert(parsed.symbols.includes('price'), 'identifier quoted in the error message');
});

test('message fragments become quoted candidates, runtime values do not', () => {
  const parsed = parseQuery("ValueError: could not parse header 'X-Request-Id' at offset 4096 (got 12 bytes)");
  assert(parsed.quoted.includes('could not parse header'), JSON.stringify(parsed.quoted));
  assert(!parsed.quoted.some(q => /4096|X-Request-Id/.test(q)));
});

// ---------------------------------------------------------------------------------------------------------------
// frameKind and orderFrames

test('frameKind separates application, dependency and runtime frames', () => {
  const kind = (path: string, language: FrameLanguage, func?: string): string => frameKind({ path, language, func, raw: '', index: 0 });
  assert.equal(kind('/app/src/a.py', 'python'), 'app');
  assert.equal(kind('/usr/local/lib/python3.9/site-packages/django/db/x.py', 'python'), 'dependency');
  assert.equal(kind('/usr/lib/python3.9/threading.py', 'python'), 'runtime');
  assert.equal(kind('node:internal/process/task_queues', 'javascript'), 'runtime');
  assert.equal(kind('/app/node_modules/express/lib/router.js', 'javascript'), 'dependency');
  assert.equal(kind('Thread.java', 'java', 'java.lang.Thread.run'), 'runtime');
  assert.equal(kind('Foo.cs', 'csharp', 'System.Linq.Enumerable.First'), 'runtime');
  assert.equal(kind('/rustc/abc/library/core/src/panicking.rs', 'rust'), 'runtime');
  assert.equal(kind('/usr/local/go/src/runtime/panic.go', 'go'), 'runtime');
  assert.equal(kind('/work/svc/main.go', 'go', 'main'), 'app');
});

test('orderFrames lists innermost application frames first', () => {
  const parsed = parseQuery(L('Traceback (most recent call last):', '  File "/app/main.py", line 5, in <module>', '    go()', '  File "/app/lib.py", line 9, in go', '    helper()',
    '  File "/usr/local/lib/python3.9/site-packages/dep/x.py", line 3, in helper', '    boom()', 'RuntimeError: boom'));
  assert.deepEqual(orderFrames(parsed).map(f => f.func), ['go', '<module>', 'helper']);
  const js = parseQuery(L('Error: x', '    at inner (/app/a.js:1:1)', '    at outer (/app/b.js:2:2)', '    at Module._compile (node:internal/modules/cjs/loader:1256:14)'));
  assert.deepEqual(orderFrames(js).map(f => f.func), ['inner', 'outer', 'Module._compile']);
});

// ---------------------------------------------------------------------------------------------------------------
// resolveFrame

const printed = (path: string, language: FrameLanguage = 'unknown', extra: Partial<StackFrame> = {}): StackFrame => ({ path, language, raw: path, index: 0, ...extra });

interface ResolveCase { name: string; frame: StackFrame; repo: string[]; expected: string[]; prefix?: boolean }

const resolveCases: ResolveCase[] = [
  {
    name: 'docker path with ambiguous basenames prefers the longest suffix',
    frame: printed('/app/src/utils/index.js', 'javascript'),
    repo: ['src/utils/index.js', 'lib/utils/index.js', 'src/index.js', 'index.js', 'docs/readme.md'],
    expected: ['src/utils/index.js', 'lib/utils/index.js', 'index.js', 'src/index.js'],
  },
  {
    name: 'site-packages prefix',
    frame: printed('/usr/local/lib/python3.9/site-packages/django/db/models/query.py', 'python'),
    repo: ['django/db/models/sql/query.py', 'tests/queries/query.py', 'django/db/models/query.py'],
    expected: ['django/db/models/query.py', 'tests/queries/query.py', 'django/db/models/sql/query.py'],
  },
  {
    name: 'go module path with a version directory',
    frame: printed('/home/u/go/pkg/mod/github.com/acme/pkg@v1.2.3/server/handler.go', 'go'),
    repo: ['other/handler.go', 'server/handler.go', 'handler.go'],
    expected: ['server/handler.go', 'handler.go', 'other/handler.go'],
  },
  {
    name: 'windows path',
    frame: printed('C:\\Users\\x\\proj\\src\\app\\Main.cs', 'csharp'),
    repo: ['tests/Main.cs', 'src/app/Main.cs'],
    expected: ['src/app/Main.cs', 'tests/Main.cs'],
  },
  {
    name: 'case-insensitive match for windows and macOS paths',
    frame: printed('C:\\Proj\\SRC\\App.cs', 'csharp'),
    repo: ['src/App.cs', 'docs/Other.cs'],
    expected: ['src/App.cs'],
  },
  {
    name: 'compiled javascript maps back to typescript sources',
    frame: printed('dist/utils/index.js', 'javascript'),
    repo: ['src/other/index.ts', 'src/utils/index.ts', 'src/utils/index.js'],
    expected: ['src/utils/index.js', 'src/utils/index.ts', 'src/other/index.ts'],
  },
  {
    name: 'webpack relative path',
    frame: printed('./src/pages/index.js', 'javascript'),
    repo: ['src/pages/index.js', 'pages/index.js'],
    expected: ['src/pages/index.js', 'pages/index.js'],
  },
  {
    name: 'gem versions are stripped from directories',
    frame: printed('/usr/local/bundle/gems/activesupport-6.1.4/lib/active_support/x.rb', 'ruby'),
    repo: ['lib/active_support/x.rb', 'activesupport/lib/active_support/x.rb'],
    expected: ['activesupport/lib/active_support/x.rb', 'lib/active_support/x.rb'],
  },
  {
    name: 'rust toolchain paths match the rust repository',
    frame: printed('/rustc/0123abcd/library/core/src/panicking.rs', 'rust'),
    repo: ['library/core/src/panicking.rs', 'src/panicking.rs', 'src/other.rs'],
    expected: ['library/core/src/panicking.rs', 'src/panicking.rs'],
  },
  {
    name: 'runtime frames need more than a basename match',
    frame: printed('/usr/lib/python3.9/threading.py', 'python'),
    repo: ['src/threading.py', 'lib/threading.py'],
    expected: [],
  },
  { name: 'node internals never resolve', frame: printed('node:internal/modules/cjs/loader', 'javascript'), repo: ['loader.js', 'lib/internal/modules/cjs/loader.js'], expected: [] },
  { name: 'no candidate', frame: printed('/app/missing.py', 'python'), repo: ['a.py', 'b/c.py'], expected: [] },
  { name: 'empty repository', frame: printed('/app/a.py', 'python'), repo: [], expected: [] },
  { name: 'empty path', frame: printed('', 'python'), repo: ['a.py'], expected: [] },
  { name: 'repository paths with backslashes are matched and returned verbatim', frame: printed('/srv/app/lib/util.rb', 'ruby'), repo: ['lib\\util.rb'], expected: ['lib\\util.rb'] },
];

for (const c of resolveCases) {
  test(`resolveFrame: ${c.name}`, () => {
    assert.deepEqual(resolveFrame(c.frame, c.repo), c.expected);
    assert.deepEqual(createFrameResolver(c.repo)(c.frame), c.expected);
  });
}

test('resolveFrame: java and kotlin class names map to package directories', () => {
  const repo = ['src/main/java/com/acme/service/UserService.java', 'src/main/java/com/other/UserService.java', 'src/test/java/com/acme/service/UserServiceTest.java', 'src/main/kotlin/com/x/billing/Invoice.kt', 'src/com/x/Outer.java'];
  const java = parseQuery('\tat com.acme.service.UserService.load(UserService.java:42)').frames[0];
  assert.deepEqual(resolveFrame(java, repo), ['src/main/java/com/acme/service/UserService.java', 'src/main/java/com/other/UserService.java']);
  const kotlin = parseQuery('\tat com.x.billing.InvoiceKt.total(Invoice.kt:14)').frames[0];
  assert.deepEqual(resolveFrame(kotlin, repo), ['src/main/kotlin/com/x/billing/Invoice.kt']);
  const inner = parseQuery('\tat com.x.Outer$Inner.run(Outer.java:7)').frames[0];
  assert.deepEqual(resolveFrame(inner, repo), ['src/com/x/Outer.java']);
});

test('resolveFrame: results come from the repository only, without duplicates, at most eight', () => {
  let seed = 7;
  const rand = (n: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const names = ['index.js', 'utils.py', 'main.go', 'Foo.java', 'mod.rs', 'a.c'];
  const dirs = ['src', 'lib', 'app', 'pkg', 'x', 'y', 'test', 'a/b', 'c/d/e'];
  const repo = Array.from({ length: 400 }, () => `${dirs[rand(dirs.length)]}/${dirs[rand(dirs.length)]}/${names[rand(names.length)]}`);
  const resolver = createFrameResolver(repo);
  for (let i = 0; i < 200; i++) {
    const path = `/${dirs[rand(dirs.length)]}/${dirs[rand(dirs.length)]}/${names[rand(names.length)]}`;
    const frame = printed(path, 'unknown');
    const result = resolveFrame(frame, repo);
    assert(result.length <= 8 && new Set(result).size === result.length);
    assert(result.every(p => repo.includes(p)));
    assert.deepEqual(resolver(frame), result);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// condenseQuery

interface CondenseCase { name: string; text: string; budget?: number; expected: string }

const condenseCases: CondenseCase[] = [
  {
    name: 'bug template: headings, checklist, comments, environment and the stdin frame disappear',
    text: L(
      '### Describe the bug', '', 'Calling `Cart.apply_discount()` twice raises `ValueError` since 2.3.', '',
      '### To Reproduce', '', 'Steps to reproduce the behavior:', '1. Create a cart with `Cart(items=[...])`', '2. Call `cart.apply_discount(0.1)` two times', '',
      '```python', 'from shop.cart import Cart', 'cart = Cart(items=[Item("a", 100)])', 'cart.apply_discount(0.1)', 'cart.apply_discount(0.1)', '```', '',
      '### Expected behavior', 'The second call should be a no-op.', '',
      '### Traceback', '```', 'Traceback (most recent call last):', '  File "/home/runner/work/shop/shop/shop/cart.py", line 88, in apply_discount',
      '    raise ValueError("discount already applied")', '  File "<stdin>", line 1, in <module>', 'ValueError: discount already applied', '```', '',
      '### Environment', '- OS: Ubuntu 20.04', '- Python version: 3.8.10', '- shop version: 2.3.1', '',
      '<!-- Please do not remove this template -->', '- [x] I have searched the existing issues'),
    expected: L(
      'Calling `Cart.apply_discount()` twice raises `ValueError` since 2.3.',
      'Create a cart with `Cart(items=[...])`',
      'Call `cart.apply_discount(0.1)` two times',
      'from shop.cart import Cart',
      'cart = Cart(items=[Item("a", 100)])',
      'cart.apply_discount(0.1)',
      'The second call should be a no-op.',
      'shop/cart.py:88: in apply_discount',
      'raise ValueError("discount already applied")',
      'ValueError: discount already applied'),
  },
  {
    name: 'pip freeze listing',
    text: L('Why does `parse_header` in `net/http.py` return `None` for folded headers?', '', 'My environment:', '```', ...Array.from({ length: 45 }, (_, i) => `package-number-${i}==1.${i}.0`), '```'),
    expected: 'Why does `parse_header` in `net/http.py` return `None` for folded headers?',
  },
  {
    name: 'scikit-learn style show_versions dump',
    text: L('`KMeans.fit` ignores `sample_weight` when `init="k-means++"`', '', 'System:', '    python: 3.9.7 (default, Sep 16 2021, 13:09:58)  [GCC 7.5.0]', 'executable: /usr/bin/python3',
      '   machine: Linux-5.4.0-x86_64-with-glibc2.31', '', 'Python dependencies:', '      pip: 21.2.4', '   setuptools: 58.0.4', '    sklearn: 1.0.1', '      numpy: 1.21.2',
      '      scipy: 1.7.1', '     Cython: None', '     pandas: 1.3.3', ' matplotlib: 3.4.3', '     joblib: 1.0.1', 'threadpoolctl: 2.2.0'),
    expected: '`KMeans.fit` ignores `sample_weight` when `init="k-means++"`',
  },
  {
    name: 'single-line JSON payload',
    text: L('The webhook handler crashes on large payloads.', '', JSON.stringify({ data: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item${i}` })) })),
    expected: 'The webhook handler crashes on large payloads.',
  },
  {
    name: 'images, data URIs, base64 attributes and query strings',
    text: L('Rendering a chart hides the legend (`Legend.render`).', '', '![screenshot](https://user-images.githubusercontent.com/1/2.png)',
      `data:image/png;base64,${'iVBORw0KGgo'.repeat(300)}`, `<img src="data:image/gif;base64,${'R0lGODlh'.repeat(100)}">`, 'See [the docs](https://docs.example.org/legend?utm_source=x&ref=y#section) for details.'),
    expected: L('Rendering a chart hides the legend (`Legend.render`).', 'See the docs https://docs.example.org/legend for details.'),
  },
  {
    name: 'CI log: timestamps, progress bars and repeated lines',
    text: L('2024-05-01T12:00:01.123Z ##[group]Run pytest', '2024-05-01T12:00:02.456Z collected 40 items',
      ...Array.from({ length: 12 }, (_, i) => `2024-05-01T12:00:0${i % 10}.000Z   Downloading wheel-${i}.whl (${10 + i} kB)  [${'#'.repeat(10)}] ${i * 8}%`),
      "2024-05-01T12:00:09.000Z FAILED tests/test_store.py::test_roundtrip - KeyError: 'checksum'",
      "2024-05-01T12:00:09.000Z FAILED tests/test_store.py::test_roundtrip - KeyError: 'checksum'"),
    expected: L('Run pytest', 'collected 40 items', 'Downloading wheel-0.whl (10 kB) 0%', "FAILED tests/test_store.py::test_roundtrip - KeyError: 'checksum'"),
  },
  {
    name: 'feature request template with placeholders',
    text: L('<!-- Thanks for filing! Please check the boxes -->', '**Is your feature request related to a problem? Please describe.**', 'A clear and concise description of what the problem is.',
      '- [x] I have searched for similar requests', '', "**Describe the solution you'd like**", 'Add a `--dry-run` flag to `deploy()` in `cli/deploy.py`', '',
      "**Describe alternatives you've considered**", 'None', '', '**Additional context**', 'Add any other context or screenshots about the feature request here.'),
    expected: 'Add a `--dry-run` flag to `deploy()` in `cli/deploy.py`',
  },
  {
    name: 'recursion error keeps one frame',
    text: L('Traceback (most recent call last):', ...Array.from({ length: 300 }, () => ['  File "/srv/app/tree.py", line 17, in walk', '    return walk(node.parent)']).flat(), 'RecursionError: maximum recursion depth exceeded'),
    budget: 800,
    expected: L('tree.py:17: in walk', 'return walk(node.parent)', 'RecursionError: maximum recursion depth exceeded'),
  },
  {
    name: 'windows paths are shortened',
    text: L("Unhandled exception. System.IO.FileNotFoundException: Could not find file 'C:\\Users\\dev\\proj\\data\\input.csv'.",
      '   at Acme.Import.Reader.Open(String path) in C:\\Users\\dev\\proj\\src\\Acme.Import\\Reader.cs:line 31',
      '   at Acme.Import.Program.Main(String[] args) in C:\\Users\\dev\\proj\\src\\Acme.Import\\Program.cs:line 12'),
    expected: L("Unhandled exception. System.IO.FileNotFoundException: Could not find file 'C:\\Users\\dev\\proj\\data\\input.csv'.",
      'proj/src/Acme.Import/Reader.cs:31: in Acme.Import.Reader.Open', 'proj/src/Acme.Import/Program.cs:12: in Acme.Import.Program.Main'),
  },
  {
    name: 'html wrappers are removed, bundler paths are cleaned',
    text: L('Crash when clicking **Save** in the settings panel (`SettingsPanel.onSave`).', '<details>', '<summary>Click to expand the log</summary>', '', '<p>', 'Error: handler is not a function',
      '    at SettingsPanel.onSave (webpack-internal:///./src/settings/panel.js?abcd:44:12)', '</p>', '</details>'),
    expected: L('Crash when clicking Save in the settings panel (`SettingsPanel.onSave`).', 'Click to expand the log', 'Error: handler is not a function', 'src/settings/panel.js:44: in SettingsPanel.onSave'),
  },
];

for (const c of condenseCases) {
  test(`condenseQuery fixture: ${c.name}`, () => {
    const out = condenseQuery(c.text, c.budget);
    assert.equal(out, c.expected);
    assert(out.length <= (c.budget ?? 6000));
    assert.equal(condenseQuery(c.text, c.budget), out, 'deterministic');
  });
}

const FILLER_SUBJECTS = ['the importer', 'a nightly job', 'the admin form', 'our exporter', 'the scheduler', 'a plain request', 'the report page', 'every worker'];
const FILLER_VERBS = ['stalls', 'retries quietly', 'returns early', 'allocates memory', 'logs nothing', 'waits forever', 'skips records', 'drops values'];
const FILLER_ENDINGS = ['when the queue is long', 'after the second deploy', 'on slower machines', 'for large accounts', 'during the weekly sync', 'with mixed encodings', 'under heavy load', 'if nobody is logged in'];
const filler = (i: number): string => `Observation ${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}: ${FILLER_SUBJECTS[i % 8]} ${FILLER_VERBS[(i * 3) % 8]} ${FILLER_ENDINGS[(i * 5) % 8]}, which was unexpected.`;

function longPythonIssue(): string {
  const frames = [
    ['/srv/app/library/views.py', 40, 'import_books'],
    ['/srv/app/library/importer.py', 88, 'apply'],
    ['/srv/app/venv/lib/python3.9/site-packages/django/db/models/query.py', 812, 'bulk_update'],
    ['/srv/app/venv/lib/python3.9/site-packages/django/db/models/sql/compiler.py', 1620, 'as_sql'],
  ] as const;
  return L(
    'QuerySet.bulk_update() crashes when a related field is passed as `fields`',
    '',
    '### Description',
    'Passing `author_id` to `Book.objects.bulk_update(books, ["author_id"])` fails inside `_prepare_for_bulk_update`; `RelatedPopulator` is not involved.',
    'Setting `ModelState.fields_cache` by hand does not help either.',
    '',
    ...Array.from({ length: 40 }, (_, i) => filler(i)),
    '',
    '```',
    'Traceback (most recent call last):',
    ...frames.flatMap(([path, line, func]) => [`  File "${path}", line ${line}, in ${func}`, '    pass']),
    "django.core.exceptions.FieldDoesNotExist: Book has no field named 'author_id'",
    '```',
    '',
    '### Environment',
    ...Array.from({ length: 60 }, (_, i) => `package-number-${i}==2.${i}.1`),
    '',
    ...Array.from({ length: 150 }, (_, i) => `2024-05-01 12:00:${String(i % 60).padStart(2, '0')},${100 + i} DEBUG query ${i}: SELECT * FROM library_book WHERE id = ${i}`));
}

test('digest: title, errors, innermost application frames, identifiers - in that order, within budget', () => {
  const text = longPythonIssue();
  assert(text.length > 9000);
  const out = condenseQuery(text, 1500);
  assert(out.length <= 1500, `length ${out.length}`);
  const lines = out.split('\n');
  assert.equal(lines[0], 'QuerySet.bulk_update() crashes when a related field is passed as `fields`');
  const error = out.indexOf("FieldDoesNotExist: Book has no field named 'author_id'");
  const inner = out.indexOf('library/importer.py:88: in apply');
  const outer = out.indexOf('library/views.py:40: in import_books');
  const dependency = out.indexOf('django/db/models/query.py:812: in bulk_update');
  assert(error > 0 && inner > error && outer > inner, `order in ${JSON.stringify(out.slice(0, 600))}`);
  assert(dependency > outer || dependency < 0, 'dependency frames come after application frames');
  for (const identifier of ['_prepare_for_bulk_update', 'RelatedPopulator', 'ModelState.fields_cache', 'author_id']) assert(out.includes(identifier), `${identifier} kept`);
  assert(!/package-number/.test(out) && out.split('SELECT * FROM').length <= 2, 'dependency listing is gone and repeated log lines collapse to at most one');
  assert.equal(condenseQuery(text, 1500), out, 'deterministic');
  const reparsed = parseQuery(out);
  assert(reparsed.frames.length >= 2 && reparsed.isTrace, 'the digest is still a trace');
});

test('digest: every budget is respected and the result is never empty', () => {
  const texts = [longPythonIssue(), condenseCases[0].text, L('x'.repeat(5000)), 'a b', '日本語のテキスト '.repeat(500)];
  for (const text of texts) {
    for (const budget of [32, 64, 100, 300, 800, 1500, 6000]) {
      const out = condenseQuery(text, budget);
      assert(out.length > 0 && out.length <= budget, `budget ${budget} length ${out.length}`);
    }
  }
  assert.equal(condenseQuery(longPythonIssue()), condenseQuery(longPythonIssue(), 6000));
  assert(condenseQuery('hello world', Number.NaN).length > 0);
  assert(condenseQuery('hello world '.repeat(40), -5).length <= 32);
});

test('digest: identifiers survive a hard budget', () => {
  const identifiers = ['resolve_keys', 'GroupBy.agg', '_cache_key', 'MAX_RETRIES', 'SparseArray', 'fit_transform', 'HTTPAdapter', 'parseHeader', 'to_datetime', 'read_csv',
    'ColumnTransformer', 'get_queryset', 'ModelAdmin', 'render_to_string', 'bulk_create'];
  const text = L('Intermittent failure in the data layer', '', ...Array.from({ length: 90 }, (_, i) => (i % 4 === 0 && i / 4 < identifiers.length ? `${filler(i)} Possibly related to \`${identifiers[i / 4]}\`.` : filler(i))));
  assert(text.length > 3000);
  const out = condenseQuery(text, 1500);
  assert(out.length <= 1500);
  for (const identifier of identifiers) assert(out.includes(identifier), `${identifier} in ${JSON.stringify(out)}`);
});

test('digest: a 400-frame java stack overflow keeps one frame and the cause', () => {
  const text = L('StackOverflowError when walking a deep tree', '', 'java.lang.StackOverflowError', ...Array.from({ length: 400 }, () => '\tat com.acme.tree.Node.visit(Node.java:30)'),
    'Caused by: java.lang.IllegalStateException: cycle detected', '\tat com.acme.tree.Walker.walk(Walker.java:12)', '\t... 400 more');
  const out = condenseQuery(text, 1000);
  assert.equal(out.split('Node.java').length, 2);
  assert(out.includes('Caused by: java.lang.IllegalStateException: cycle detected') && out.includes('Walker.java:12'));
});

// ---------------------------------------------------------------------------------------------------------------
// Pathological input

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
}

const FRAGMENTS = ['  File "', '", line ', ', in ', 'Traceback (most recent call last):', '\n', '\r\n', '\t', '    at ', ' (', ')', ':12:34', 'node_modules/', '/usr/lib/python3.9/site-packages/',
  'C:\\Users\\x\\', 'panic: ', 'goroutine 1 [running]:', 'main.foo(0x1)', '+0x1d', '#0  0x00007f in f () at a.c:1', 'error[E0425]: ', ' --> src/main.rs:5:9', '[ERROR] ', '`', '"', "'", '[', ']',
  '](', '![', '<!--', '-->', '<img ', '<a href="', 'https://example.com/x?y=1#z', 'github.com/a/b/blob/c/d.py', 'E   ', '=====', '_____ ', '\u001b[31m', '\u0000', '\ufffd',
  'aaaaaaaaaaaaaaaaaaaaaaaa', '0123456789abcdef', 'FAILED tests/a.py::t - ', '● ', '1) ', '... 23 more', ' in ', ' on line ', '\\n', '\\"', '::error file=a.py,line=1::',
  'def foo(', 'class Bar', '__init__', 'a.b.c.d.e', 'x'.repeat(300)];

function fuzzText(random: () => number, length: number): string {
  let out = '';
  while (out.length < length) out += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
  return out.slice(0, length);
}

function checkInvariants(text: string): void {
  const parsed = parseQuery(text);
  parsed.frames.forEach((frame, i) => {
    assert.equal(frame.index, i);
    assert(frame.path.length > 0 && frame.raw.length <= 300);
    for (const n of [frame.line, frame.column]) assert(n === undefined || (Number.isInteger(n) && n >= 0));
  });
  assert(parsed.errorLines.length <= 20 && parsed.errorLines.every(line => line.length <= 300) && new Set(parsed.errorLines).size === parsed.errorLines.length);
  assert(parsed.testNames.length <= 50 && parsed.symbols.length <= 60 && parsed.quoted.length <= 40);
  assert(parsed.quoted.every(q => q.length >= 8));
  assert(new Set(parsed.paths).size === parsed.paths.length && new Set(parsed.symbols).size === parsed.symbols.length);
  for (const budget of [32, 200, 1500]) {
    const out = condenseQuery(text, budget);
    assert(out.length <= budget && (out.length > 0 || text.length === 0), `budget ${budget}`);
  }
}

test('fuzz: random trace-like and binary text never throws and respects every invariant', () => {
  const random = seededRandom(20240501);
  for (let i = 0; i < 400; i++) checkInvariants(fuzzText(random, Math.floor(random() * 4000)));
  for (let i = 0; i < 100; i++) {
    let bytes = '';
    const n = Math.floor(random() * 3000);
    for (let k = 0; k < n; k++) bytes += String.fromCharCode(Math.floor(random() * 0x300));
    checkInvariants(bytes);
  }
});

function cpuMilliseconds<T>(work: () => T): { ms: number; value: T } {
  const before = process.cpuUsage();
  const value = work();
  const used = process.cpuUsage(before);
  return { ms: (used.user + used.system) / 1000, value };
}

const adversarial: Record<string, () => string> = {
  'one 2 MB word': () => 'a'.repeat(2_000_000),
  'two million newlines': () => '\n'.repeat(2_000_000),
  'unclosed "at (" runs': () => 'at ('.repeat(500_000),
  'nested parentheses': () => '('.repeat(2_000_000),
  'markdown link openers': () => `${'[a]('.repeat(500_000)}]( `,
  'colons and digits': () => ':1'.repeat(1_000_000),
  'bracket runs': () => '[['.repeat(1_000_000),
  'quote soup': () => '"\'`'.repeat(700_000),
  'frames on one line': () => 'at foo (/a.js:1:2) '.repeat(100_000),
  'escaped json stack': () => `{"stack":"${'Error: x\\n    at f (/a.js:1:2)'.repeat(60_000)}"}`,
  'underscore header': () => `${'_'.repeat(1_000_000)} x ${'_'.repeat(1_000_000)}`,
  'backslashes': () => '\\'.repeat(2_000_000),
  'hex and base64 lines': () => ('QUJD'.repeat(30) + '\n').repeat(15_000),
  'python frames': () => '  File "/app/x.py", line 3, in f\n    g()\n'.repeat(45_000),
  'go frame pairs': () => 'main.foo(0x1)\n\t/a/b.go:12 +0x1d\n'.repeat(50_000),
  'keyword soup': () => 'def class function error: Error: panic: ERROR '.repeat(45_000),
  'random fragments': () => fuzzText(seededRandom(99), 2_000_000),
};

test('2 MB adversarial inputs finish in linear time (CPU time < 1.5 s each for parseQuery and condenseQuery)', t => {
  const rows: string[] = [];
  for (const [name, make] of Object.entries(adversarial)) {
    const text = make();
    assert(text.length >= 1_000_000, name);
    const wallStart = performance.now();
    const parse = cpuMilliseconds(() => parseQuery(text));
    const condense = cpuMilliseconds(() => condenseQuery(text, 6000));
    const wall = performance.now() - wallStart;
    rows.push(`${name}: parse ${parse.ms.toFixed(0)} ms cpu, condense ${condense.ms.toFixed(0)} ms cpu, wall ${wall.toFixed(0)} ms`);
    assert(parse.ms < 1500, `${name}: parseQuery used ${parse.ms.toFixed(0)} ms of CPU`);
    assert(condense.ms < 1500, `${name}: condenseQuery used ${condense.ms.toFixed(0)} ms of CPU`);
    assert(condense.value.length > 0 && condense.value.length <= 6000, name);
    assert(wall < 30_000, `${name}: wall-clock ${wall.toFixed(0)} ms`);
  }
  t.diagnostic(rows.join('\n'));
});

test('text beyond the input cap keeps its head and its tail', () => {
  const head = '  File "/app/head.py", line 1, in first_function\n';
  const tail = '  File "/app/tail.py", line 2, in last_function\n';
  const text = head + 'filler line of no interest\n'.repeat(200_000) + 'x'.repeat(3_000_000) + '\n' + tail + 'ValueError: end';
  const parsed = parseQuery(text);
  assert.deepEqual(parsed.frames.map(f => f.func), ['first_function', 'last_function']);
  assert.deepEqual(parsed.errorLines, ['ValueError: end']);
});
