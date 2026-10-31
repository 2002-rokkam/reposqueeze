// Line classification for CI/test logs: priority tiers, test-runner awareness and stack-frame kinds.
// Patterns are deliberately label-based (anchored forms such as "ERROR", "FAILED test", "Caused by:") rather than bare
// keywords, so passing test names or configuration echoes that merely contain "error" are not treated as failures.

export const Tier = {
  RootError: 1, FailingTest: 2, Assertion: 3, AppFrame: 4, Summary: 5, Edge: 6,
  Context: 7, Warning: 8, Fold: 9, Rest: 10, Dead: 11
} as const;

export const Kind = {
  Normal: 0, Blank: 1, Pass: 2, SuitePass: 3, Skip: 4, PassNoise: 5, FrameApp: 6, FrameLib: 7, Noise: 8
} as const;

export interface Classification {
  tier: Uint8Array;
  kind: Uint8Array;
  /** 1 when the line is a failure signal (counted in failureSignalsTotal). */
  signal: Uint8Array;
  warn: Uint8Array;
}

// --- exclusions -------------------------------------------------------------------------------------------------------
// Lines that mention failure words but report success or merely echo configuration.
const ZERO_COUNT = /\b(?:0|no|zero)\s+(?:errors?|failures?|failed|failing|warnings?)\b|\b(?:errors?|failures?|failed|failing)\s*[:=]\s*0\b|\bwithout (?:any )?errors?\b|\b0 failing\b|\bfail(?:ed)?[-_](?:on|fast|under|if)\b|\bfail(?:On|Fast|Under)|--fail|-Werror|continue-on-error|ignore[-_]?errors?|TreatWarningsAsErrors|\bfailure\(\)|\berror[-_]?(?:on|handling|handler|prone)\b/i;

// --- frames -----------------------------------------------------------------------------------------------------------
const FRAME_AT = /^\s+at\s+\S*[.(<:/\\$][^\s]*|^\s+at\s+async\s+\S/;
const FRAME_PY = /^\s+File "[^"]*", line \d+/;
const FRAME_PY_CONT = /^\s{4,}\S|^\s+\^+~*\s*$/;
const FRAME_GO_PATH = /^\s+\S+\.go:\d+(?: \+0x[0-9a-f]+)?\s*$/;
const FRAME_GO_FUNC = /^(?:created by\s+)?[A-Za-z_][\w./*()-]*\.[\w*()-]+\(.*\)\s*$|^created by \S+/;
const FRAME_RUST = /^\s+\d+:\s+\S/;
const FRAME_RUST_AT = /^\s+at\s+\S+:\d+(?::\d+)?\s*$/;
const FRAME_RUBY = /^\s*(?:from\s+|#\s+)(?:\.\/|\/|[A-Za-z]:)?\S+:\d+:in\s/;
const FRAME_PHP = /^\s*#\d+\s+(?:\S+\(\d+\):|\{main\})/;
const FRAME_C = /^\s*#\d+\s+(?:0x[0-9a-f]+\s+in\s|\S+\s+\()/;
const FRAME_VITEST = /^\s*❯\s+(?:\S+\s+)?\S+:\d+:\d+\s*$/;
const FRAME_LOC = /^\s*[\w./\\-]+\.(?:py|js|jsx|ts|tsx|mjs|cjs|rb|go|rs|java|kt|cs|php|c|cc|cpp|h|hpp|swift):\d+(?::\d+)?:?\s+(?:in\s|[A-Z]\w+)/;
const FRAME_MORE = /^\s*\.\.\.\s+\d+\s+(?:more|common frames omitted|frames? (?:hidden|omitted|elided))/;
const LIB_FRAME = new RegExp([
  'node_modules[\\\\/]', '\\bnode:internal', '\\binternal[\\\\/](?:process|modules|timers|main|async_hooks)', '\\(<anonymous>\\)',
  'processTicksAndRejections', 'site-packages', 'dist-packages', '[\\\\/]lib[\\\\/]python\\d', '<frozen ', '[\\\\/]_pytest[\\\\/]', '[\\\\/]pluggy[\\\\/]',
  '\\bjava\\.base/', '\\bjava\\.(?:lang|util|io|net|nio)\\.', '\\bjdk\\.internal', '\\bsun\\.(?:reflect|nio|net|misc)\\.', '\\bjavax?\\.',
  '\\bcom\\.sun\\.', '\\borg\\.junit\\.', '\\borg\\.apache\\.maven\\.surefire', '\\borg\\.apache\\.(?:catalina|tomcat|coyote|maven)\\.',
  '\\borg\\.springframework\\.', '\\borg\\.gradle\\.', '\\borg\\.testng\\.', '\\bjunit\\.framework', '\\borg\\.opentest4j', '\\borg\\.mockito\\.',
  '\\bio\\.netty\\.', '\\bkotlinx?\\.', '\\bscala\\.', '\\bakka\\.', '\\bgroovy\\.', '\\borg\\.codehaus', '\\bjakarta\\.', '\\borg\\.hibernate\\.',
  '\\borg\\.eclipse\\.', '\\bio\\.(?:quarkus|micronaut|vertx)\\.', '\\bcom\\.fasterxml', '\\bworkers\\.', '\\bworker\\.',
  '^\\s+at (?:System|Microsoft|Xunit|NUnit|MSTest)\\.', '[\\\\/]usr[\\\\/]local[\\\\/]go[\\\\/]src', '[\\\\/]go[\\\\/]src[\\\\/](?:runtime|testing|reflect|net|sync)',
  '^\\s*(?:runtime|testing|reflect|sync|net/http|syscall)[./(]', '[\\\\/]pkg[\\\\/]mod[\\\\/]', '[\\\\/]vendor[\\\\/]', '[\\\\/]\\.cargo[\\\\/]',
  '[\\\\/]rustc[\\\\/]', '\\bstd::', '\\bcore::', '\\balloc::', '\\btokio::runtime', '\\btest::', '[\\\\/]gems[\\\\/]', '[\\\\/]lib[\\\\/]ruby[\\\\/]',
  '<internal:', '\\bphpunit[\\\\/]phpunit[\\\\/]', '[\\\\/]vendor[\\\\/]', '\\bIlluminate\\\\\\\\', '\\bSymfony\\\\\\\\', '\\bPHPUnit\\\\\\\\'
].join('|'));

// --- test summaries, failing tests, assertions -------------------------------------------------------------------------
const FAILED_COUNT_CI = /\b[1-9]\d*\s+(?:failed|failing|errors?|failures?|crashed|timed out)\b|\b(?:failed|failures?|errors?)\s*[:=]\s*[1-9]/i;
const FAILED_COUNT_CS = /\bFAILURES!|(?<![-_\w])FAIL\b(?![-_])|\bFAILED\b|\bFAILURE\b|\*\*\*Failed|\b(?:Failed|Errors?)!|[1-9]\d* tests? failed|\*\*\* \[[^\]]*\] Error \d+/;
const hasFailureCount = (line: string) => FAILED_COUNT_CI.test(line) || FAILED_COUNT_CS.test(line);
const SUMMARY = [
  /^={3,}.*\b(?:passed|failed|errors?|skipped|warnings?|deselected|no tests ran|xfailed|xpassed)\b.*={3,}\s*$/i,
  /^\s*(?:Tests?|Test Suites|Test Files|Snapshots?|Suites?)\s*:?\s+\S.*\d/,
  /^\s*(?:Duration|Start at|Time)\s*:?\s+[\d.]+\s*(?:m?s|min|seconds?)?\b/,
  /^Ran \d+ tests? in\b/, /^(?:OK|FAILED)(?: \([^)]*\))?\s*$/, /^\s*\d+ (?:passing|failing|pending)\b/,
  /^test result: (?:ok|FAILED)\./, /^(?:ok|FAIL|\?)\s+\S+\s+(?:[\d.]+s|\(cached\)|\[[^\]]+\])/, /^(?:PASS|FAIL)\s*$/,
  /^\[(?:INFO|ERROR|WARNING)\]\s+Tests run:\s*\d+/, /^\[(?:INFO|ERROR)\]\s+(?:BUILD (?:SUCCESS|FAILURE)|Total time|Finished at|Reactor Summary)/,
  /^BUILD (?:SUCCESSFUL|FAILED)\b|^\d+ actionable tasks?/, /^(?:Passed|Failed)!\s+-\s+Failed:/, /^Total tests:|^\s+(?:Passed|Failed|Skipped|Total):\s+\d+\s*$/,
  /^Finished in [\d.]+/, /^\d+ examples?, \d+ failures?/, /^OK \(\d+ tests?|^Tests: \d+, Assertions:|^FAILURES!|^Time: [\d:.]+, Memory:/,
  /^\d+% tests passed|^Total Test time|^The following tests FAILED:|^Errors while running CTest/, /^\[={5,}\]|^\[\s+(?:PASSED|FAILED)\s+\]/,
  /^\s*(?:error: test failed|error: process didn't exit successfully)/i,
  /^make(?:\[\d+\])?: \*\*\*|^ninja: build stopped|^gmake(?:\[\d+\])?: \*\*\*|^\s*Finished (?:`[^`]+` )?(?:dev|test|release)/,
  /^Run Summary|^Results:|^Summary:/
];
// Unanchored summary patterns scan the whole line, so they only run when a cheap keyword test passes.
const SUMMARY_EXIT = /Process completed with exit code \d+|exit(?:ed)? with (?:exit )?(?:code|status) \d+|^exit(?: code| status)? \d+\s*$|exit status \d+|returned non-zero exit status|\bexit code: \d+|Command failed with exit code|\bexit [1-9]\d* \(\d/i;
const SUMMARY_COUNTS = /\b\d+ (?:tests?|specs?|examples?|cases?) (?:passed|failed|run|completed)\b/i;
const FAILING_TEST = [
  /^(?:FAILED|ERROR)\s+\S+::\S+|^(?:FAILED|ERROR)\s+\S+\.(?:py|js|ts|rb|go|rs|php|java|cs)\b/, /^_{3,}\s+\S.*\s+_{3,}\s*$/, /^={3,} (?:FAILURES|ERRORS) ={3,}\s*$/,
  /^\s*(?:FAIL|FAILED)\s{1,4}\S+/, /^\s*●\s+\S.*(?:›|>)/, /^\s*●\s+Test suite failed to run/, /^\s*(?:✕|✗|✘|×|✖)\s+\S/, /^\s*\[-\]\s+\S/, /^\s*[⨯✘]\s+\S/,
  /^\s*(?:❯|>)\s+\S+\.(?:test|spec)\.\S+\s+\(.*\bfailed\b/, /^\s*not ok\s+\d+/, /^\s*--- FAIL:/, /^(?:FAIL|ERROR): \S+ \(/,
  /^test \S+ \.\.\. FAILED\s*$/, /^---- \S+ stdout ----$/, /^\s*failures:\s*$/, /^\s*(?:thread '[^']*' panicked|test result: FAILED)/,
  /<<<\s+(?:FAILURE|ERROR)!?/, /^\[ERROR\]\s+(?:Failures|Errors):\s*$/, /^\[ERROR\]\s+\S+(?:Test|Tests|IT|Spec)\.\S+(?::\d+)?\s/,
  /^\[\s+FAILED\s+\]/, /^\s*Failed\s+\S+\s+\[/, /^\s*\d+\)\s+\S.*(?:Failure|Error)|^\s+\d+\)\s+\S/, /^rspec \.\/spec\/\S+/, /^Failures:\s*$/,
  /^\d+\)\s+\S+::\S+/, /\*\*\*Failed|\*\*\*Exception|\*\*\*Timeout|^\s*\d+\s+-\s+\S+\s+\((?:Failed|Timeout|SEGFAULT|Subprocess aborted)\)/,
  /^FAILED:\s|^Failed\s+\S+Test\b/, /^\s*(?:FAIL|FAILED)\s*$/, /^\s*\[FAIL\]|^\s*FAIL\s+\S+\s+\(/
];
// pytest "tests/x.py ..F.." progress lines and unittest dots only count as failures when they contain F or E.
const PYTEST_PROGRESS = /^[\w./\\-]+\.(?:py|rb)\s+[.sxXFEpP]+(?:\s+\[\s*\d+%\])?\s*$|^[.sxXFE]{4,}(?:\s+\[\s*\d+%\])?\s*$/;
const ASSERTION = [
  /^E\s/, /^\s*(?:Expected|Received|Actual|Got|Diff)\b\s*[:=]/, /\bexpected\b.{0,120}\b(?:but|got|actual|received|to (?:be|equal|have|match)|was|found)\b/i,
  /\bAssertion(?:Error|FailedError)\b|\bassertion (?:failed|error)\b|\bAssertEqual|\bComparisonFailure|\bFailed asserting\b/i, /^\s*expect\(.*\)\.(?:not\.)?to\w+/,
  /^\s*(?:left|right):\s/, /^\s*(?:Expected|Actual) :?\s*</, /^\s*[-+]\s*(?:Expected|Received|expected|actual)\b/, /^\s*(?:\+\+\+|---)\s+\S+\s*$/,
  /^\s*@@ .* @@/, /^\s*(?:assert|require)\.\w+/i, /^\s+\S+_test\.go:\d+:/, /^\s*Error Trace:|^\s*Error:\s+(?:Not equal|Should)/
];
// Source excerpts under a failure: pytest marks the failing line with ">   ", jest/vitest/babel print numbered gutters.
const CODE_FRAME = /^\s*(?:>\s*)?\d+\s*\|\s?|^\s*\|\s*\^+|^>\s{3}\S/;

// --- root errors and warnings -------------------------------------------------------------------------------------------
const ROOT = [
  /^\s*(?:\[?(?:ERROR|FATAL|CRITICAL|SEVERE|PANIC)\]?)(?:[\s:\]|]|$)/, /^\s*(?:npm|yarn|pnpm|lerna|bun|pip|poetry|cargo|uv)\s+(?:ERR!|err!|error|ERROR)/,
  /\b(?:fatal )?error(?:\[[A-Z]?\d+\])?:\s/i, /\berror\s+(?:TS|CS|LNK|MSB|NU|CA|FS|BC|NETSDK|AD|IDE|C|E)\d{2,5}\b/,
  /^\s*(?:Caused by:|Exception in thread|Unhandled (?:exception|rejection|promise)|UnhandledPromiseRejection|Traceback \(most recent call last\))/i,
  /^\s*(?:Caused by: |Exception in thread "[^"]*" )?(?:[\w$]+\.)*[A-Z][\w$]*(?:Error|Exception|Failure|Fault)(?::|\s|$)/, /(?:[\w$]+\.)*[A-Z][\w$]*(?:Error|Exception)\b:/,
  /\bpanic(?:ked)?\b(?: at|:)|^\s*goroutine \d+ \[|\bfatal error: /, /Segmentation fault|core dumped|Bus error|Illegal instruction|\bSIGSEGV\b|\bSIGABRT\b|Aborted \(core|OOMKilled|[Oo]ut of memory|^Killed\s*$/,
  /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|ENOTFOUND|ELIFECYCLE|ERR_[A-Z_]{4,})\b/,
  /\bBUILD (?:FAILED|FAILURE)\b|^FAILURE: |What went wrong:|Execution failed for task|could not compile|[Cc]ompilation (?:failed|error)|Compile error|Failed to compile/,
  /command not found|No such file or directory|[Pp]ermission denied|[Cc]annot find (?:module|package|symbol|name|type)|ModuleNotFoundError|ImportError|undefined reference to|unresolved external symbol|undefined symbol/,
  /\b(?:timed out|time[- ]?out (?:of|exceeded|expired|reached)|Timeout of \d+|deadline exceeded|time limit exceeded)\b|connection (?:refused|reset|timed out)|Connection reset by peer|Could not resolve host|Name or service not known/i,
  // Bare "failed" is too common in prose and configuration, so lowercase forms need a failure-reporting context.
  /(?<![-_\w])FAIL(?:ED)?\b(?![-_])|\b[Ff]ailed (?:to|with|at|in|on|because|due|after|during)\b|(?<![-_\w])[Ff]ail(?:ed|ure|ures):|\b(?:has|have|had|job|step|build|test|tests|check|checks|command|task|run|install|process|compilation|connection|request|clone|fetch|checkout|upload|download|deploy|publish|assertion|validation) failed\b/,
  /^##\[error\]|^::error(?:\s|::)/, /\*\*\* \[[^\]]*\] Error \d+/, /\bTests? run failed\b|\bNot found: |\b[Aa]n error occurred\b|\bevaluation failed\b|\[ELIFECYCLE\]|\bCommand failed\b/
];
const WARNING = /(?:^|[\s\[(:])(?:warn(?:ing)?s?|WARN(?:ING)?)\b(?:[\]):]|\s|$)|\bdeprecat(?:ed|ion)\b|^\s*npm WARN|^##\[warning\]|^::warning/i;

// --- passing tests ----------------------------------------------------------------------------------------------------
const PASS = [
  /^\s*(?:✓|✔|√|✅|✔️)\s/, /^\s*\[\+\]\s/, /^\s*ok\s+\d+\s/, /^\s*--- PASS:/, /^test \S+ \.\.\. ok\s*$/, /\.\.\. ok\s*$/, /^\s*PASSED\s+\S+|\bPASSED\b(?:\s+\[\s*\d+%\])?\s*$/,
  /^\[\s*OK\s*\]|^\[\s*PASSED\s*\]|^\s*Passed\s+\S+\s+\[/, /^\s*\d+\/\d+\s+Test\s+#\d+:.*(?:Passed|\.{2,}\s*Passed)/, /^\[INFO\]\s+Tests run:.*Failures: 0, Errors: 0/,
  /^\s*[✓✔]\s*$|^\s*(?:PASS|ok)\s+\S+\.\S+/
];
const SUITE_PASS = [/^\s*PASS\s+\S+/, /^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/, /^\s*(?:✓|✔)\s+\S+\.(?:test|spec)\.\S+\s+\(\d+ tests?/, /^\[INFO\]\s+Tests run:.*Failures: 0, Errors: 0.*- in /];
const SKIP = [/^\s*(?:○|↓)\s+\S/, /^\s*--- SKIP:/, /^test \S+ \.\.\. ignored/, /\bSKIPPED\b|\bskipped\b.*\[\d+\]/, /^\s*Skipped\s+\S+\s+\[/, /^\s*pending:/i];
const PASS_NOISE = [
  /^\?\s+\S+\s+\[no test files\]/,
  /^=== (?:RUN|PAUSE|CONT|NAME)\s/, /^\s*\d+\/\d+\s+Test\s+#\d+:.*\bStart\b|^\s+Start\s+\d+:/, /^\[ RUN\s+\]|^\[-{5,}\]|^\[ {2,}OK {2,}\]/,
  /^\[INFO\]\s+Running\s+\S+|^\[INFO\]\s+-{5,}|^\[INFO\]\s+T E S T S|^\[INFO\]\s*$/, /^running \d+ tests?\s*$/, /^\s*(?:Determining projects to restore|Restored\s+\S+)/
];
// Unambiguous passing-test lines, recognised even when the test name contains words such as "fails" or "error".
const STRONG_PASS = /^\s*(?:✓|✔|√|✅|✔️|\[\+\])\s|^\s*--- PASS:|^test \S+ \.\.\. ok\s*$|\.\.\. ok\s*$|\bPASSED\b(?:\s+\[\s*\d+%\])?\s*$|^\s*ok\s+\d+\s/;
const PYTEST_DOTS = /^[.sxXpP]{3,}(?:\s+\[\s*\d+%\])?\s*$|^[\w./\\-]+\.(?:py|rb)\s+[.sxXpP]{2,}(?:\s+\[\s*\d+%\])?\s*$/;

// --- CI boilerplate ---------------------------------------------------------------------------------------------------
const GHA_NOISE = new RegExp('^(?:##\\[(?:endgroup|start-action|end-action|add-matcher|remove-matcher|debug|section|command)\\b|::(?:endgroup|add-matcher|remove-matcher|debug)|' +
  'Post job cleanup\\.|Cleaning up orphan processes|Temporarily overriding HOME=|Adding repository directory to the temporary git global config|' +
  'Removing (?:SSH command configuration|HTTP extra header|includeIf entries)|Pruning is unnecessary|\\[command\\](?:/usr/bin/git|"C:\\\\Program Files\\\\Git)|' +
  'Current runner version|Runner Image|Hosted Compute Agent|Version: \\d{8}|Commit: [0-9a-f]{40}|Build Date:|Worker ID:|Region:|Cloud:|Operating System$|Image: |Included Software:|Image Release:|' +
  'GITHUB_TOKEN Permissions|Secret source:|Prepare workflow directory|Prepare all required actions|Getting action download info|Download action repository|' +
  'Complete job name:|Evaluate and set job outputs|Cleaning up|Terminate orphan process:|Stop and remove container:|Remove container network:|git version \\d|' +
  'Syncing repository:|Getting Git version info|Working directory is|Deleting the contents of|Initializing the repository|Disabling automatic garbage collection|Setting up auth|Fetching the repository|Determining the checkout info|Checking out the ref|Persisting credentials|' +
  '\\s+(?:Contents|Metadata|Packages|Actions|Checks|Issues|Pull requests|Statuses): (?:read|write)$)');

const FAIL_WORDS = /fail|FAIL|rror|xception|anic|atal|ASSERT|ssert|xpected|SIG(?:SEGV|ABRT|KILL)|Segmentation|core dumped|Killed|Traceback|Caused|denied|refused|imed? ?out|imeout|not found|nresolved|undefined|annot|nable to|\bE[A-Z]{4,}|ERR_|exit|Exit|BUILD|ailure|wrong|such file|emory|bort|Unhandled|esolve|Illegal|ailed|ails|ERR|\\*\\*\\*|ot found/;
const EXIT_NONZERO = /\bexit(?:ed)?(?:[\s:=(]|with|code|status)+[1-9]\d{0,2}\b|returned non-zero exit status/i;

interface Cursor {
  tier: number; kind: number; signal: number; warn: number;
  /** Name of the rule that decided the classification (for audits and tests). */
  rule: string;
}

function summaryTier(line: string, out: Cursor): boolean {
  let matched = false;
  for (const re of SUMMARY) if (re.test(line)) { matched = true; break; }
  if (!matched && (line.includes('xit') || line.includes('Command failed')) && SUMMARY_EXIT.test(line)) matched = true;
  if (!matched && (line.includes('passed') || line.includes('failed') || line.includes(' run ') || line.includes('completed')) && SUMMARY_COUNTS.test(line)) matched = true;
  if (!matched) return false;
  out.tier = Tier.Summary;
  out.signal = hasFailureCount(line) || EXIT_NONZERO.test(line) ? 1 : 0;
  // Successful per-suite summaries are repeated for every class and are folded like passing tests.
  if (/^\[INFO\]\s+Tests run:/.test(line) && !out.signal) { out.kind = Kind.PassNoise; out.tier = Tier.Rest; }
  return true;
}

const isWarning = (line: string) => (line.includes('arn') || line.includes('ARN') || line.includes('eprecat')) && WARNING.test(line);

function firstMatch(patterns: readonly RegExp[], line: string): number {
  for (let i = 0; i < patterns.length; i++) if (patterns[i].test(line)) return i;
  return -1;
}

function frameKindOf(line: string, next: string | undefined): number {
  // Go (function line + tab-indented path line) and Rust (numbered frame + "at" line) frames span two lines.
  const twoLine = next !== undefined && ((FRAME_GO_FUNC.test(line) && FRAME_GO_PATH.test(next)) || (FRAME_RUST.test(line) && FRAME_RUST_AT.test(next)));
  const isFrame = twoLine || FRAME_AT.test(line) || FRAME_PY.test(line) || FRAME_RUBY.test(line) || FRAME_PHP.test(line) || FRAME_C.test(line) ||
    FRAME_MORE.test(line) || FRAME_GO_PATH.test(line) || FRAME_LOC.test(line) || FRAME_VITEST.test(line) || FRAME_RUST_AT.test(line);
  if (!isFrame) return 0;
  if (FRAME_MORE.test(line)) return 0;
  return LIB_FRAME.test(twoLine ? `${line}\n${next}` : line) ? Kind.FrameLib : Kind.FrameApp;
}

/**
 * Classify every line. The pass is linear: each line is tested against a bounded number of anchored patterns, with
 * small state machines for Python tracebacks, failure blocks and GitHub Actions command groups.
 */
export function classifyLines(lines: readonly string[]): Classification {
  const n = lines.length;
  const tier = new Uint8Array(n).fill(Tier.Rest), kind = new Uint8Array(n), signal = new Uint8Array(n), warn = new Uint8Array(n);
  const cur: Cursor = { tier: Tier.Rest, kind: Kind.Normal, signal: 0, warn: 0, rule: 'plain' };
  let pyTrace = false, pyFrameKind = 0, inGroup = false, inEnv = false, prevFrameKind = 0, postJob = false;
  // classifyOne is a pure function of the line and whether a path-like continuation follows, and logs repeat lines a lot.
  const memo: Map<string, number>[] = [new Map(), new Map()];

  for (let i = 0; i < n; i++) {
    const line = lines[i];
    cur.tier = Tier.Rest; cur.kind = Kind.Normal; cur.signal = 0; cur.warn = 0;
    if (line === '') { cur.tier = Tier.Dead; cur.kind = Kind.Blank; }
    else {
      const next = lines[i + 1];
      const table = memo[next !== undefined && (next.includes('.go:') || next.includes(' at ')) ? 1 : 0];
      const packed = table.get(line);
      if (packed !== undefined) {
        cur.tier = packed & 15; cur.kind = (packed >> 4) & 15; cur.signal = (packed >> 8) & 1; cur.warn = (packed >> 9) & 1;
      } else {
        classifyOne(line, next, cur);
        if (table.size < 200000) table.set(line, cur.tier | (cur.kind << 4) | (cur.signal << 8) | (cur.warn << 9));
      }
    }

    // Stateful refinements -------------------------------------------------------------------------------------------
    // Everything after a "Post job cleanup." marker is runner housekeeping unless it looks like a problem.
    if (line.startsWith('Post job cleanup.')) postJob = true;
    else if (line.startsWith('##[group]Run ')) postJob = false;
    else if (postJob && cur.tier >= Tier.Rest && cur.kind !== Kind.Blank) { cur.kind = Kind.Noise; cur.tier = Tier.Dead; cur.rule = 'post-job'; }
    if (cur.kind !== Kind.Blank) {
      if (line.startsWith('##[group]')) { inGroup = true; inEnv = false; }
      else if (line.startsWith('##[endgroup]')) { inGroup = false; inEnv = false; }
      else if (inGroup && /^(?:env|with):\s*$/.test(line)) { inEnv = true; cur.kind = Kind.Noise; cur.tier = Tier.Dead; }
      else if (inEnv && /^\s{2,}\S/.test(line)) { cur.kind = Kind.Noise; cur.tier = Tier.Dead; cur.signal = 0; cur.warn = 0; }
      else if (inEnv) inEnv = false;
      if (inGroup && /^shell:\s/.test(line)) { cur.kind = Kind.Noise; cur.tier = Tier.Dead; }
    }
    if (/^Traceback \(most recent call last\)/.test(line)) { pyTrace = true; pyFrameKind = 0; }
    else if (pyTrace) {
      if (FRAME_PY.test(line)) {
        pyFrameKind = LIB_FRAME.test(line) ? Kind.FrameLib : Kind.FrameApp;
        cur.kind = pyFrameKind; cur.tier = pyFrameKind === Kind.FrameApp ? Tier.AppFrame : Tier.Dead; cur.signal = 0;
      } else if (pyFrameKind && FRAME_PY_CONT.test(line)) {
        cur.kind = pyFrameKind; cur.tier = pyFrameKind === Kind.FrameApp ? Tier.AppFrame : Tier.Dead; cur.signal = 0;
      } else if (!/^\s/.test(line) && line !== '') { pyTrace = false; if (cur.tier > Tier.RootError) { cur.tier = Tier.RootError; cur.signal = 1; } }
      else pyFrameKind = 0;
    }
    // A frame's continuation line (Go/Rust/Ruby path line) inherits the kind of its function line.
    if ((cur.kind === Kind.FrameApp || cur.kind === Kind.FrameLib)) prevFrameKind = cur.kind;
    else if (prevFrameKind && (FRAME_GO_PATH.test(line) || FRAME_RUST_AT.test(line))) { cur.kind = prevFrameKind; cur.tier = prevFrameKind === Kind.FrameApp ? Tier.AppFrame : Tier.Dead; prevFrameKind = 0; }
    else prevFrameKind = 0;

    tier[i] = cur.tier; kind[i] = cur.kind; signal[i] = cur.signal; warn[i] = cur.warn;
  }
  return { tier, kind, signal, warn };
}

function classifyOne(line: string, next: string | undefined, out: Cursor): void {
  const text = line.length > 600 ? line.slice(0, 600) : line;
  const code0 = text.charCodeAt(0);
  const decide = (rule: string, tier: number, kind: number = Kind.Normal, signal = 0, warn = 0) => {
    out.rule = rule; out.tier = tier; out.kind = kind; out.signal = signal; out.warn = warn;
  };

  // GitHub Actions workflow commands and runner boilerplate.
  if (code0 === 35 /* # */ || code0 === 58 /* : */) {
    if (/^##\[error\]/.test(text) || /^::error(?:\s|::)/.test(text)) {
      decide('gha-error', /Process completed with exit code/.test(text) ? Tier.Summary : Tier.RootError, Kind.Normal, 1); return;
    }
    if (/^##\[warning\]|^::warning/.test(text)) { decide('gha-warning', Tier.Warning, Kind.Normal, 0, 1); return; }
  }
  if (GHA_NOISE.test(text) || (code0 === 35 && text.startsWith('##[group]') && !text.startsWith('##[group]Run '))) { decide('ci-noise', Tier.Dead, Kind.Noise); return; }

  // Stack frames: library frames are folded, application frames are protected.
  const frame = frameKindOf(text, next);
  if (frame) { decide(frame === Kind.FrameApp ? 'frame-app' : 'frame-lib', frame === Kind.FrameApp ? Tier.AppFrame : Tier.Dead, frame); return; }

  // Passing tests are recognised first so that a test *named* "handles errors" is never a failure signal.
  if (firstMatch(PASS_NOISE, text) >= 0) { decide('pass-noise', Tier.Dead, Kind.PassNoise); return; }
  if (PYTEST_DOTS.test(text)) { decide('pytest-dots', Tier.Dead, Kind.Pass); return; }
  const failWords = FAIL_WORDS.test(text);
  if (!failWords) {
    if (firstMatch(SUITE_PASS, text) >= 0) { decide('suite-pass', Tier.Dead, Kind.SuitePass); return; }
    if (firstMatch(PASS, text) >= 0) { decide('pass', Tier.Dead, Kind.Pass); return; }
    if (firstMatch(SKIP, text) >= 0) { decide('skip', Tier.Dead, Kind.Skip); return; }
  } else if (STRONG_PASS.test(text)) {
    decide('pass-with-failure-words', Tier.Dead, Kind.Pass); return;
  }

  if (PYTEST_PROGRESS.test(text)) {
    if (/[FE]/.test(text.replace(/\.(?:py|rb)\b/, ''))) decide('pytest-progress-fail', Tier.FailingTest, Kind.Normal, 1);
    else decide('pytest-progress', Tier.Rest);
    return;
  }
  const summary = summaryTier(text, out);
  if (summary) { out.rule = 'summary'; return; }
  if (!failWords && code0 !== 69 /* E */ && !/^\s*[-+>@|✕✗✘×✖●⨯❯→]|^\s*\d+\)|^_{3,}|^={3,}|^\s*(?:Expected|Received|Actual|Got|Diff|left|right)\b|^\s*expect\(/.test(text)) {
    if (isWarning(text)) decide('warning', Tier.Warning, Kind.Normal, 0, 1);
    else out.rule = 'plain';
    return;
  }
  if (ZERO_COUNT.test(text) && !/^E\s|Traceback|Exception|panic/.test(text)) {
    if (isWarning(text)) decide('warning', Tier.Warning, Kind.Normal, 0, 1);
    else out.rule = 'zero-count';
    return;
  }
  let hit = firstMatch(FAILING_TEST, text);
  if (hit >= 0) { decide(`failing-test:${hit}`, Tier.FailingTest, Kind.Normal, 1); return; }
  hit = firstMatch(ASSERTION, text);
  if (hit >= 0) { decide(`assertion:${hit}`, Tier.Assertion, Kind.Normal, /^\s*(?:[-+]\s|@@ |(?:---|\+\+\+)\s)/.test(text) ? 0 : 1); return; }
  hit = firstMatch(ROOT, text);
  if (hit >= 0) { decide(`root:${hit}`, Tier.RootError, Kind.Normal, 1); return; }
  if (CODE_FRAME.test(text)) { decide('code-frame', Tier.Assertion); return; }
  if (isWarning(text)) decide('warning', Tier.Warning, Kind.Normal, 0, 1);
  else out.rule = 'plain';
}

/** Classification of one line in isolation, with the rule that decided it (used by audits and unit tests). */
export function explainLine(line: string, next?: string): { tier: number; kind: number; signal: boolean; warn: boolean; rule: string } {
  const out: Cursor = { tier: Tier.Rest, kind: Kind.Normal, signal: 0, warn: 0, rule: 'plain' };
  if (line === '') return { tier: Tier.Dead, kind: Kind.Blank, signal: false, warn: false, rule: 'blank' };
  classifyOne(line, next, out);
  return { tier: out.tier, kind: out.kind, signal: out.signal === 1, warn: out.warn === 1, rule: out.rule };
}

// --- runner detection -------------------------------------------------------------------------------------------------
const RUNNERS: readonly (readonly [string, RegExp])[] = [
  ['github-actions', /^##\[(?:group|error|endgroup)\]|Post job cleanup\./m],
  ['pytest', /test session starts|short test summary info|^={3,} .*\b(?:passed|failed)\b.* in [\d.]+s|^[\w./-]+\.py [.FEsxX]+\s+\[/m],
  ['unittest', /^Ran \d+ tests? in [\d.]+s|^(?:FAIL|ERROR): test\w* \(/m],
  ['jest', /^\s*(?:PASS|FAIL)\s+\S+\.(?:test|spec)\.|^Test Suites:\s|^\s*●\s.*›/m],
  ['vitest', /^\s*Test Files\s+\d|\bvitest\b|^\s*(?:FAIL|❯)\s+\S+\.(?:test|spec)\./m],
  ['mocha', /^\s+\d+ (?:passing|failing)\b/m],
  ['tap', /^(?:not )?ok \d+ - |^TAP version|^# (?:tests|pass|fail) \d+/m],
  ['go-test', /^(?:=== RUN|--- (?:PASS|FAIL)|ok\s+\S+\s+[\d.]+s|FAIL\s+\S+\s+[\d.]+s)|^\{"Time":.*"Action":"(?:run|pass|fail|output)"/m],
  ['cargo-test', /^running \d+ tests?|^test result: (?:ok|FAILED)|^test \S+ \.\.\. (?:ok|FAILED)/m],
  ['junit-maven', /Tests run:.*Failures:|\[INFO\] -{5,}< |\[ERROR\] Failed to execute goal|Reactor Summary/m],
  ['gradle', /^> Task :|^BUILD (?:SUCCESSFUL|FAILED) in |^FAILURE: Build failed|Gradle Test Executor/m],
  ['dotnet', /^\s*(?:Passed|Failed)!\s+-\s+Failed:|Determining projects to restore|\berror (?:CS|MSB|NU)\d+|Total tests:|\[xUnit\.net/m],
  ['rspec', /^Finished in [\d.]+ |^\d+ examples?, \d+ failures?|^Failures:\s*$|# \.\/spec\//m],
  ['phpunit', /^PHPUnit \d|^OK \(\d+ tests?|^Tests: \d+, Assertions:|^FAILURES!/m],
  ['ctest', /^Test project |tests? passed, \d+ tests? failed|^\s*\d+\/\d+ Test\s+#\d+:/m],
  ['gtest', /^\[==========\]|^\[ RUN\s+\]|^\[\s+(?:OK|FAILED)\s+\]/m],
  ['make/cmake', /^make(?:\[\d+\])?: |^-- (?:Configuring|Build files)|^\[\s*\d+%\] (?:Building|Linking)|^ninja: |^\[\d+\/\d+\] /m],
  ['gcc/clang', /: (?:fatal )?error: |: warning: .*\[-W|In file included from /m],
  ['tsc', /\berror TS\d{4}:/m],
  ['eslint', /^\s*\d+:\d+\s+(?:error|warning)\s+.*\s+\S+\s*$|✖ \d+ problems?/m],
  ['webpack', /^ERROR in |webpack (?:compiled|\d+\.)|^asset \S+ [\d.]+ [KMG]?i?B/m],
  ['vite', /\bvite v\d|\d+ modules transformed/m],
  ['docker-build', /^#\d+ \[(?:\d+\/\d+|internal)\]|^Step \d+\/\d+ : |^#\d+ DONE |failed to solve/m],
  ['npm/yarn/pnpm', /^npm (?:ERR!|WARN)|^added \d+ packages|^\s*Progress: resolved \d+|^yarn install v|ELIFECYCLE/m],
  ['pip/uv', /^Collecting \S+|^Requirement already satisfied:|^Successfully installed |^Installed \d+ packages? in/m],
  ['rust-compiler', /^error(?:\[E\d+\])?: |^\s+Compiling \S+ v\d|^warning: unused/m],
  ['terraform', /^Terraform (?:v|will perform)|^Plan: \d+ to add/m]
];

export function detectRunners(sample: string): string[] {
  const found: string[] = [];
  for (const [name, re] of RUNNERS) if (re.test(sample)) found.push(name);
  return found;
}
