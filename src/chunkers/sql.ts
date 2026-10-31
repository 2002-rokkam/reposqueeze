/**
 * SQL scripts: one span per statement, named after the object it creates, alters, queries or modifies.
 *
 * Handles `--`, `#` (line start) and block comments, single/double/backtick quoting, PostgreSQL dollar
 * quoting, MySQL `DELIMITER`, T-SQL `GO`, Oracle `/` and BEGIN/END bodies of stored routines. Comments
 * directly above a statement belong to it; `-- name: X` (sqlc) and `--changeset a:b` (Liquibase) label it.
 */
import { type Scan, type TreeNode, RefSet, Source, tidy } from './common.js';

const MAX_NODES = 300_000;
const IDENT = '(?:[`"\\[]?[\\w$#@]+[`"\\]]?)(?:\\.[`"\\[]?[\\w$#@]+[`"\\]]?)*';
const OBJECT = '(TABLE|MATERIALIZED\\s+VIEW|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE|SCHEMA|DATABASE|SEQUENCE|EXTENSION|DOMAIN|POLICY|ROLE|USER|EVENT|PACKAGE(?:\\s+BODY)?|SYNONYM|RULE|COLLATION|AGGREGATE|OPERATOR|FOREIGN\\s+TABLE|TABLESPACE|PUBLICATION|SUBSCRIPTION|STATISTICS|CAST|LANGUAGE)';
const MODIFIERS = '(?:OR\\s+REPLACE\\s+|(?:GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED|UNIQUE|CLUSTERED|NONCLUSTERED|FULLTEXT|SPATIAL|VIRTUAL|EXTERNAL|RECURSIVE|CONCURRENTLY|TRUSTED|EDITIONABLE|NONEDITIONABLE|DEFINER\\s*=\\s*\\S+|ALGORITHM\\s*=\\s*\\w+|SQL\\s+SECURITY\\s+\\w+)\\s+)*';
const DDL = new RegExp(`^(CREATE|ALTER|DROP)\\s+${MODIFIERS}${OBJECT}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(?:ONLY\\s+)?(?:CONCURRENTLY\\s+)?(${IDENT})(?:\\s+ON\\s+(?:ONLY\\s+)?(${IDENT}))?`, 'i');
const PROCEDURAL = /^\s*(?:CREATE\s[^;]{0,300}?\b(?:FUNCTION|PROCEDURE|TRIGGER|PACKAGE|EVENT)\b|DECLARE\b|BEGIN\b(?!\s*(?:TRAN|WORK|;|$)))/i;
const SKIPPED_FROM = new Set(['select', 'lateral', 'unnest', 'values', 'generate_series', 'only', 'dual']);

function unquote(ident: string): string {
  return ident.replace(/[`"[\]]/g, '');
}

interface Described {
  name: string;
  verb: string;
}

function describe(text: string): Described {
  const s = text.slice(0, 700).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim();
  let m = DDL.exec(s);
  if (m) {
    const object = m[2].toLowerCase().replace(/\s+/g, ' ');
    const first = unquote(m[3]);
    const name = first.toUpperCase() === 'ON' ? unquote(m[4] ?? first) : first;
    return { name, verb: `${m[1].toLowerCase()} ${object}` };
  }
  const first = /^(\w+)/.exec(s)?.[1]?.toLowerCase() ?? '';
  const take = (re: RegExp, verb: string): Described | undefined => {
    m = re.exec(s);
    return m ? { name: unquote(m[1]), verb } : undefined;
  };
  switch (first) {
    case 'insert':
    case 'replace':
      return take(new RegExp(`^(?:INSERT|REPLACE)\\s+(?:(?:OR\\s+\\w+|IGNORE|LOW_PRIORITY|DELAYED|HIGH_PRIORITY)\\s+)*INTO\\s+(${IDENT})`, 'i'), 'insert') ?? { name: first, verb: first };
    case 'update':
      return take(new RegExp(`^UPDATE\\s+(?:(?:ONLY|LOW_PRIORITY|IGNORE)\\s+)*(${IDENT})`, 'i'), 'update') ?? { name: first, verb: first };
    case 'delete':
      return take(new RegExp(`^DELETE\\s+(?:(?:LOW_PRIORITY|QUICK|IGNORE)\\s+)*FROM\\s+(?:ONLY\\s+)?(${IDENT})`, 'i'), 'delete') ?? { name: first, verb: first };
    case 'truncate':
      return take(new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(${IDENT})`, 'i'), 'truncate') ?? { name: first, verb: first };
    case 'merge':
      return take(new RegExp(`^MERGE\\s+INTO\\s+(${IDENT})`, 'i'), 'merge') ?? { name: first, verb: first };
    case 'with':
      return take(new RegExp(`^WITH\\s+(?:RECURSIVE\\s+)?(${IDENT})`, 'i'), 'with') ?? { name: first, verb: first };
    case 'select': {
      m = new RegExp(`\\bFROM\\s+(?!\\()(${IDENT})`, 'i').exec(s);
      const table = m ? unquote(m[1]) : '';
      return { name: table && !SKIPPED_FROM.has(table.toLowerCase()) ? table : 'select', verb: 'select' };
    }
    case 'comment':
      return take(new RegExp(`^COMMENT\\s+ON\\s+\\w+(?:\\s+\\w+)?\\s+(${IDENT})`, 'i'), 'comment') ?? { name: first, verb: first };
    case 'grant':
    case 'revoke':
      return take(new RegExp(`\\bON\\s+(?:(?:TABLE|SCHEMA|DATABASE|SEQUENCE|FUNCTION|ALL\\s+TABLES\\s+IN\\s+SCHEMA)\\s+)?(${IDENT})`, 'i'), first) ?? { name: first, verb: first };
    case 'exec':
    case 'execute':
    case 'call':
      return take(new RegExp(`^(?:EXEC(?:UTE)?|CALL)\\s+(${IDENT})`, 'i'), first) ?? { name: first, verb: first };
    default: {
      const words = s.split(/\s+/).slice(0, 2).join(' ').replace(/[;(]+.*$/, '').toLowerCase();
      return { name: words || 'statement', verb: first || 'statement' };
    }
  }
}

const SQL_REF = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES|TABLE|VIEW|ON)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(${IDENT})`, 'gi');
const SQL_WORDS = new Set(['select', 'set', 'values', 'null', 'where', 'and', 'or', 'not', 'if', 'exists', 'on', 'only', 'delete', 'update', 'insert', 'cascade', 'restrict', 'default', 'check', 'primary', 'foreign', 'unique', 'key', 'index']);

function sqlRefs(src: Source, start: number, end: number): string[] {
  const refs = new RefSet();
  for (let n = start; n <= end && !refs.full; n++) {
    const line = src.lines[n - 1];
    if (line.length > 1000 || /^\s*(?:--|#)/.test(line)) continue;
    for (const m of line.matchAll(SQL_REF)) {
      const name = unquote(m[1]);
      if (name.length > 1 && !SQL_WORDS.has(name.toLowerCase())) refs.add(name);
    }
  }
  return refs.list;
}

export function scanSql(src: Source): Scan {
  const t = src.text;
  const n = t.length;
  const backslash = /`|ENGINE\s*=|DELIMITER|\/\*!/i.test(t.slice(0, 20_000));
  const nodes: TreeNode[] = [];
  let delimiter = ';';
  let start = -1;
  let startLine = 0;
  let leadLine = 0;
  let depth = 0;
  let procedural: boolean | undefined;
  let lead: { startLine: number; endLine: number } | undefined;
  let label: string | undefined;
  let copyData = false;
  let lastEnd = 0;
  let line = 1;
  let nextBreak = t.indexOf('\n');
  let i = t.charCodeAt(0) === 0xfeff ? 1 : 0;

  /** Is only whitespace between the previous line break and `pos`? */
  const startsLine = (pos: number): boolean => {
    for (let p = pos - 1; p >= 0; p--) {
      const c = t.charCodeAt(p);
      if (c === 10) return true;
      if (c !== 32 && c !== 9 && c !== 13) return false;
    }
    return true;
  };

  const restOfLineBlank = (pos: number): boolean => {
    for (let p = pos; p < n && t.charCodeAt(p) !== 10; p++) {
      const c = t.charCodeAt(p);
      if (c !== 32 && c !== 9 && c !== 13) return false;
    }
    return true;
  };

  /** Moves the line counter to `pos` (only ever forward; the next break is cached for long lines). */
  const advance = (pos: number): void => {
    while (nextBreak >= 0 && nextBreak < pos) {
      line++;
      nextBreak = t.indexOf('\n', nextBreak + 1);
    }
  };

  const begin = (pos: number): void => {
    advance(pos);
    start = pos;
    startLine = line;
    leadLine = lead && lead.endLine >= line - 1 ? lead.startLine : line;
    lead = undefined;
    depth = 0;
    procedural = undefined;
    copyData = false;
  };

  const finish = (endPos: number, endLineOverride?: number): void => {
    if (start < 0) return;
    advance(Math.max(start, endPos - 1));
    const end = Math.max(startLine, endLineOverride ?? line);
    if (nodes.length < MAX_NODES) {
      const head = t.slice(start, Math.min(endPos, start + 700));
      const { name, verb } = describe(head);
      nodes.push({ start: leadLine, end, name: label ?? name, kind: 'sql_statement', scopeName: verb, anchor: label !== undefined || /^(?:create|alter|drop)\b/.test(verb) });
      copyData = /^\s*COPY\b[\s\S]*\bFROM\s+STDIN\b/i.test(head);
    }
    start = -1;
    label = undefined;
    lastEnd = end;
  };

  const noteComment = (from: number, end: number): void => {
    if (start >= 0) return;
    advance(from);
    const startAt = line;
    advance(Math.max(from, end - 1));
    const endAt = line;
    if (startAt === lastEnd) return;
    if (lead && lead.endLine + 1 >= startAt) lead.endLine = endAt;
    else lead = { startLine: startAt, endLine: endAt };
    const text = t.slice(from, Math.min(end, from + 200));
    const sqlc = /^--\s*name:\s*(\w+)/.exec(text);
    const change = /^--\s*changeset\s+(\S+)/i.exec(text);
    if (sqlc) label = sqlc[1];
    else if (change) label = `changeset ${change[1]}`;
  };

  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 10) {
      i++;
    } else if (c === 32 || c === 9 || c === 13) {
      i++;
    } else if (c === 45 && t.charCodeAt(i + 1) === 45) {
      let end = t.indexOf('\n', i);
      if (end < 0) end = n;
      noteComment(i, end);
      i = end;
    } else if (c === 35 && startsLine(i) && start < 0) {
      advance(i);
      let end = t.indexOf('\n', i);
      if (end < 0) end = n;
      noteComment(i, end);
      i = end;
    } else if (c === 47 && t.charCodeAt(i + 1) === 42) {
      const e = t.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      if (start < 0 && t.charCodeAt(i + 2) !== 33) noteComment(i, end);
      i = end;
    } else if (delimiter !== ';' && t.startsWith(delimiter, i)) {
      finish(i + delimiter.length);
      i += delimiter.length;
    } else if (c === 39 || c === 34 || c === 96) {
      if (start < 0) begin(i);
      const escapes = c === 39 && (backslash || (i > 0 && (t.charCodeAt(i - 1) | 32) === 101));
      let j = i + 1;
      while (j < n) {
        const d = t.charCodeAt(j);
        if (d === c) {
          if (t.charCodeAt(j + 1) === c) j += 2;
          else break;
        } else if (d === 92 && escapes) {
          j += 2;
        } else {
          j++;
        }
      }
      i = Math.min(n, j + 1);
    } else if (c === 36) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(t.slice(i, i + 80));
      if (m) {
        if (start < 0) begin(i);
        const e = t.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
      } else {
        if (start < 0) begin(i);
        i++;
      }
    } else if (c === 59 && delimiter === ';') {
      if (start >= 0 && depth <= 0) finish(i + 1);
      i++;
      if (copyData) {
        // `COPY ... FROM stdin;` is followed by raw data rows up to a line holding `\.`
        copyData = false;
        const e = t.indexOf('\n\\.', i);
        const stop = e < 0 ? n : e + 3;
        advance(stop);
        const last = nodes[nodes.length - 1];
        if (last) last.end = Math.max(last.end, line);
        i = stop;
      }
    } else if (c === 47 && startsLine(i) && restOfLineBlank(i + 1)) {
      // Oracle / SQL*Plus: a lone slash runs the statement above it.
      if (start >= 0) {
        advance(i);
        finish(i, line - 1);
      }
      i++;
    } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      let j = i + 1;
      while (j < n) {
        const d = t.charCodeAt(j);
        if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95 || d === 36 || d === 35) j++;
        else break;
      }
      const word = t.slice(i, j).toUpperCase();
      if (word === 'GO' && startsLine(i) && /^\s*\d*\s*(?:--.*)?$/.test(t.slice(j, Math.min(n, j + 40)).split('\n')[0])) {
        if (start >= 0) {
          advance(i);
          finish(i, line - 1);
        }
        i = j;
        continue;
      }
      if (word === 'DELIMITER' && start < 0 && startsLine(i)) {
        const eol = t.indexOf('\n', j);
        const arg = t.slice(j, eol < 0 ? n : eol).trim();
        if (arg) delimiter = arg;
        i = eol < 0 ? n : eol;
        continue;
      }
      if (start < 0) begin(i);
      if (word === 'BEGIN' || word === 'END' || word === 'CASE') {
        procedural ??= PROCEDURAL.test(t.slice(start, start + 400));
        if (procedural && delimiter === ';') {
          if (word === 'END') {
            const next = /^\s*(\w+)/.exec(t.slice(j, j + 20))?.[1]?.toUpperCase();
            if (!(next && ['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR'].includes(next))) depth--;
          } else {
            depth++;
          }
        }
      }
      i = j;
    } else {
      if (start < 0) begin(i);
      i++;
    }
  }
  if (start >= 0) finish(n);
  return { roots: nodes, plan: { refs: (s, e) => sqlRefs(src, s, e), minLines: 2, breakRun: (previous, next, lines) => lines >= 6 && previous.name !== next.name } };
}
