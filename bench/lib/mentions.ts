/**
 * Bias indicator: does the issue text literally name a gold file?
 *
 * Retrievers get an easy win when the issue quotes a path or file name, so every report
 * states how often that happens and splits the metrics by it.
 */

export interface Mentions {
  /** A path suffix with at least two segments (`models/query.py`) occurs in the text. */
  path: boolean;
  /** The file name with extension (`query.py`) occurs as a whole token. */
  basename: boolean;
  /** Weaker: the extension-less file stem (`ArithmeticPostAggregator`) occurs as a whole word. */
  stem: boolean;
  /** Headline indicator: path || basename. */
  any: boolean;
}

/** File names too generic to count as a literal mention on their own. */
const GENERIC_BASENAMES = new Set([
  '__init__.py', '__main__.py', 'setup.py', 'conftest.py', 'index.js', 'index.ts', 'index.tsx', 'index.jsx', 'index.mjs',
  'main.go', 'main.rs', 'main.py', 'mod.rs', 'lib.rs', 'utils.py', 'util.py', 'readme.md', 'package.json', 'cargo.toml',
]);
const GENERIC_STEMS = new Set([
  'index', 'main', 'utils', 'util', 'base', 'core', 'common', 'helpers', 'config', 'settings', 'types', 'models', 'client',
  'server', 'api', 'app', 'init', 'mod', 'lib', 'test', 'tests', 'version', 'errors', 'error', 'cli', 'context', 'router',
]);

const isPathChar = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_.\-]/.test(char);
const isWordChar = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_]/.test(char);

/**
 * True when `needle` occurs in `text` delimited by non-token characters. `leftBlocks` lists
 * characters that must not precede the match; `/` is allowed so absolute paths still match.
 */
function containsToken(text: string, needle: string, leftBlocks: (c: string | undefined) => boolean, rightBlocks: (c: string | undefined) => boolean): boolean {
  if (!needle) return false;
  let from = 0;
  while (from <= text.length - needle.length) {
    const index = text.indexOf(needle, from);
    if (index < 0) return false;
    if (!leftBlocks(text[index - 1]) && !rightBlocks(text[index + needle.length])) return true;
    from = index + 1;
  }
  return false;
}

export function goldMentions(statement: string, goldPaths: string[]): Mentions {
  const text = statement.includes('\\') ? statement.replace(/\\/g, '/') : statement;
  const result: Mentions = { path: false, basename: false, stem: false, any: false };
  for (const goldPath of goldPaths) {
    const parts = goldPath.split('/').filter(Boolean);
    const basename = parts[parts.length - 1] ?? '';
    if (!basename) continue;
    if (parts.length >= 2 && !result.path) {
      const suffix = parts.slice(-2).join('/');
      if (containsToken(text, suffix, isPathChar, isWordChar)) result.path = true;
    }
    if (!result.basename && basename.length >= 3 && !GENERIC_BASENAMES.has(basename.toLowerCase())) {
      if (containsToken(text, basename, isPathChar, isWordChar)) result.basename = true;
    }
    const stem = basename.replace(/\.[^.]*$/, '');
    if (!result.stem && stem.length >= 5 && !GENERIC_STEMS.has(stem.toLowerCase())) {
      if (containsToken(text, stem, isWordChar, isWordChar)) result.stem = true;
    }
  }
  result.any = result.path || result.basename;
  return result;
}
