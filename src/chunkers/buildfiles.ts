/** Dockerfile, Makefile, CMake and shell scripts: stages, targets, functions and commands as spans. */
import { type Scan, type TreeNode, Cursor, Finder, RefSet, Source, lastSegment, tidy } from './common.js';

const isSpace = (c: number): boolean => c === 32 || c === 9;

// ---- Dockerfile --------------------------------------------------------------------------------

const DOCKER_KEYWORDS = new Set(['FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL']);
const DOCKER_HEREDOC = /<<-?\s*["']?([A-Za-z_]\w*)["']?/;

interface Instruction {
  keyword: string;
  args: string;
  start: number;
  end: number;
}

function dockerInstructions(src: Source): Instruction[] {
  const out: Instruction[] = [];
  let escape = '\\';
  for (let n = 1; n <= src.count && n <= 20; n++) {
    const m = /^#\s*escape\s*=\s*(\S)/i.exec(src.line(n));
    if (m) escape = m[1];
    else if (!/^#\s*\w+\s*=/.test(src.line(n))) break;
  }
  let current: Instruction | undefined;
  let heredoc: string | undefined;
  for (let n = 1; n <= src.count; n++) {
    const line = src.lines[n - 1];
    if (heredoc) {
      if (current) current.end = n;
      if (line.trim() === heredoc) {
        heredoc = undefined;
        if (current) out.push(current);
        current = undefined;
      }
      continue;
    }
    const t = line.length > 4000 ? line.slice(0, 4000).trimStart() : line.trimStart();
    if (!t || t[0] === '#') continue;
    if (!current) {
      const m = /^([A-Za-z]+)\b\s*(.*)$/.exec(t);
      if (!m || !DOCKER_KEYWORDS.has(m[1].toUpperCase())) continue;
      current = { keyword: m[1].toUpperCase(), args: m[2], start: n, end: n };
    } else {
      current.args += ` ${t}`;
      current.end = n;
    }
    const continued = current.args.trimEnd().endsWith(escape);
    if (continued) current.args = current.args.trimEnd().slice(0, -escape.length).trimEnd();
    if (current.args.length > 4000) current.args = current.args.slice(0, 4000);
    if (continued) continue;
    const doc = DOCKER_HEREDOC.exec(t);
    if (doc && !t.includes('<<<') && ['RUN', 'COPY', 'ADD'].includes(current.keyword)) {
      heredoc = doc[1];
      continue;
    }
    out.push(current);
    current = undefined;
  }
  if (current) out.push(current);
  return out;
}

export function scanDockerfile(src: Source): Scan {
  const roots: TreeNode[] = [];
  let stage: (TreeNode & { children: TreeNode[] }) | undefined;
  for (const ins of dockerInstructions(src)) {
    if (ins.keyword === 'FROM') {
      if (stage) stage.end = Math.max(stage.start, ins.start - 1);
      const m = /^(?:--\S+\s+)*(\S+)(?:\s+as\s+(\S+))?/i.exec(ins.args);
      const image = m?.[1] ?? 'scratch';
      const name = m?.[2] ?? image;
      stage = { start: ins.start, end: ins.end, name, kind: 'docker_stage', scopeName: name, children: [] };
      roots.push(stage);
      continue;
    }
    const leaf: TreeNode = { start: ins.start, end: ins.end, name: tidy(`${ins.keyword} ${ins.args}`, 80), kind: 'docker_instruction', scopeName: ins.keyword };
    (stage ? stage.children : roots).push(leaf);
  }
  if (stage) stage.end = src.count;
  return { roots, plan: { comment: n => src.line(n).trimStart().startsWith('#'), refs: (s, e) => dockerRefs(src, s, e) } };
}

function dockerRefs(src: Source, start: number, end: number): string[] {
  const refs = new RefSet();
  for (let n = start; n <= end && !refs.full; n++) {
    const line = src.lines[n - 1];
    if (line.length > 2000) continue;
    const m = /^\s*(FROM|COPY|ADD|ENV|ARG|WORKDIR|ENTRYPOINT|CMD)\b\s*(.*)$/i.exec(line);
    if (!m) continue;
    const keyword = m[1].toUpperCase();
    const rest = m[2];
    if (keyword === 'FROM') {
      const f = /^(?:--\S+\s+)*(\S+)(?:\s+as\s+(\S+))?/i.exec(rest);
      if (f) {
        refs.add(f[1].replace(/[@:][^/]*$/, ''));
        refs.add(f[2]);
      }
    } else if (keyword === 'COPY' || keyword === 'ADD') {
      const tokens = rest.split(/\s+/).filter(Boolean);
      for (const token of tokens) if (token.startsWith('--from=')) refs.add(token.slice(7));
      const paths = tokens.filter(token => !token.startsWith('--'));
      for (const p of paths.slice(0, -1)) if (!p.startsWith('$') && p !== '.') refs.add(p);
    } else if (keyword === 'ENV' || keyword === 'ARG') {
      for (const v of rest.matchAll(/(?:^|\s)([A-Za-z_]\w*)(?==|\s)/g)) refs.add(v[1]);
    } else {
      for (const p of rest.matchAll(/["'\s](\.{0,2}\/[\w./-]+|[\w.-]+\.sh)/g)) refs.add(p[1]);
    }
  }
  return refs.list;
}

// ---- Makefile ----------------------------------------------------------------------------------

/** Offset of the first `:` outside `$(...)`/`${...}` and whether an `=` comes before it. */
function makeSplit(line: string): { colon: number; assignment: boolean } | undefined {
  let depth = 0;
  const len = Math.min(line.length, 600);
  for (let i = 0; i < len; i++) {
    const c = line.charCodeAt(i);
    if (c === 36 && (line.charCodeAt(i + 1) === 40 || line.charCodeAt(i + 1) === 123)) {
      depth++;
      i++;
    } else if (depth > 0 && (c === 41 || c === 125)) depth--;
    else if (depth === 0) {
      if (c === 61) return { colon: -1, assignment: true };
      if (c === 35) return undefined;
      if (c === 58) {
        const next = line.charCodeAt(i + 1);
        if (next === 61 || (next === 58 && line.charCodeAt(i + 2) === 61) || (next === 58 && line.charCodeAt(i + 2) === 58 && line.charCodeAt(i + 3) === 61)) return { colon: i, assignment: true };
        return { colon: i, assignment: false };
      }
    }
  }
  return undefined;
}

export function scanMakefile(src: Source): Scan {
  const roots: TreeNode[] = [];
  let rule: TreeNode | undefined;
  let continued = false;
  let leaf: TreeNode | undefined;
  let define: TreeNode | undefined;
  let last = 0;

  const closeRule = (): void => {
    if (rule) rule.end = Math.max(rule.start, last);
    rule = undefined;
  };

  for (let n = 1; n <= src.count; n++) {
    const raw = src.lines[n - 1];
    if (define) {
      if (/^\s*endef\b/.test(raw)) {
        define.end = n;
        roots.push(define);
        define = undefined;
      }
      continue;
    }
    if (continued) {
      const target = rule ?? leaf;
      if (target) target.end = n;
      if (rule) last = n;
      continued = raw.trimEnd().endsWith('\\');
      continue;
    }
    if (!raw.trim()) continue;
    if (raw.charCodeAt(0) === 9 && rule) {
      last = n;
      rule.end = n;
      continued = raw.trimEnd().endsWith('\\');
      continue;
    }
    const t = raw.trimStart();
    if (t[0] === '#') continue;
    closeRule();
    leaf = undefined;
    const def = /^(?:export\s+|override\s+)*define\s+([^\s=:]+)/.exec(t);
    if (def) {
      define = { start: n, end: n, name: def[1], kind: 'make_define', scopeName: def[1] };
      continue;
    }
    if (/^(?:ifeq|ifneq|ifdef|ifndef|else|endif)\b/.test(t)) continue;
    const include = /^[-s]?include\s+(.*)$/.exec(t);
    if (include) {
      leaf = { start: n, end: n, name: tidy(`include ${include[1]}`, 80), kind: 'make_include', scopeName: 'include' };
      roots.push(leaf);
      continued = raw.trimEnd().endsWith('\\');
      continue;
    }
    const split = makeSplit(t);
    if (!split) continue;
    if (split.assignment) {
      const variable = t.replace(/^(?:export\s+|override\s+|private\s+)*/, '').split(/\s*(?:[:+?!]*=)/)[0].trim();
      leaf = { start: n, end: n, name: tidy(variable, 60), kind: 'make_variable', scopeName: variable };
      roots.push(leaf);
      continued = raw.trimEnd().endsWith('\\');
      continue;
    }
    const targets = t.slice(0, split.colon).trim().split(/\s+/).slice(0, 4).join(' ');
    rule = { start: n, end: n, name: tidy(targets, 80) || 'rule', kind: 'make_target', scopeName: targets.split(' ')[0] };
    roots.push(rule);
    last = n;
    continued = raw.trimEnd().endsWith('\\');
  }
  closeRule();
  if (define) {
    define.end = src.count;
    roots.push(define);
  }
  return {
    roots,
    plan: {
      minLines: 2,
      comment: n => src.line(n).trimStart().startsWith('#'),
      refs: (start, end) => {
        const refs = new RefSet();
        for (let n = start; n <= end && !refs.full; n++) {
          const line = src.lines[n - 1];
          if (line.length > 1000 || line.charCodeAt(0) === 9 || line.trimStart().startsWith('#')) continue;
          const split = makeSplit(line);
          if (!split || split.assignment) continue;
          for (const dep of line.slice(split.colon + 1).split(/\s+/)) if (dep && !/[$%=|;]/.test(dep) && !dep.startsWith('#')) refs.add(dep);
        }
        return refs.list;
      },
    },
  };
}

// ---- CMake -------------------------------------------------------------------------------------

const CMAKE_BLOCKS = new Map<string, { closer: string; kind: string }>([
  ['function', { closer: 'endfunction', kind: 'cmake_function' }],
  ['macro', { closer: 'endmacro', kind: 'cmake_macro' }],
  ['if', { closer: 'endif', kind: 'cmake_block' }],
  ['foreach', { closer: 'endforeach', kind: 'cmake_block' }],
  ['while', { closer: 'endwhile', kind: 'cmake_block' }],
  ['block', { closer: 'endblock', kind: 'cmake_block' }],
]);
const CMAKE_CLOSERS = new Set([...CMAKE_BLOCKS.values()].map(b => b.closer));

export function scanCmake(src: Source): Scan {
  const t = src.text;
  const n = t.length;
  const cursor = new Cursor(src);
  const finder = new Finder(t);
  const roots: TreeNode[] = [];
  const stack: { node: TreeNode; closer: string; children: TreeNode[] }[] = [];
  const attach = (node: TreeNode): void => {
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
  };
  let i = t.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 35) {
      // `#[[ ... ]]` / `#[==[ ... ]==]` bracket comments, otherwise a line comment
      const m = /^#\[(=*)\[/.exec(t.slice(i, i + 40));
      if (m) {
        const e = finder.find(`]${m[1]}]`, i + m[0].length);
        i = e < 0 ? n : e + m[1].length + 2;
      } else {
        const e = finder.find('\n', i);
        i = e < 0 ? n : e;
      }
    } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      let j = i + 1;
      while (j < n && /[\w]/.test(t[j])) j++;
      let k = j;
      while (k < n && isSpace(t.charCodeAt(k))) k++;
      if (t.charCodeAt(k) !== 40) {
        i = j;
        continue;
      }
      const name = t.slice(i, j).toLowerCase();
      const end = cmakeCommandEnd(t, k, finder);
      const startLine = cursor.to(i);
      const endLine = cursor.to(Math.max(i, end - 1));
      const args = tidy(t.slice(k + 1, Math.min(end - 1, k + 300)), 100);
      if (CMAKE_CLOSERS.has(name)) {
        const at = stack.map(f => f.closer).lastIndexOf(name);
        if (at >= 0) {
          while (stack.length - 1 > at) stack.pop();
          const frame = stack.pop()!;
          frame.node.end = endLine;
          attach(frame.node);
        }
      } else if (CMAKE_BLOCKS.has(name)) {
        const block = CMAKE_BLOCKS.get(name)!;
        const label = block.kind === 'cmake_block' ? `${name}(${args})` : args.split(/\s+/)[0] || name;
        const node: TreeNode = { start: startLine, end: endLine, name: tidy(label, 100), kind: block.kind, scopeName: tidy(label, 60), children: [] };
        stack.push({ node, closer: block.closer, children: node.children! });
      } else if (name !== 'else' && name !== 'elseif') {
        const first = args.split(/\s+/)[0] ?? '';
        attach({ start: startLine, end: endLine, name: tidy(`${name} ${first}`, 100), kind: 'cmake_command', scopeName: name });
      }
      i = end;
    } else {
      i++;
    }
  }
  while (stack.length) {
    const frame = stack.pop()!;
    frame.node.end = src.count;
    attach(frame.node);
  }
  return {
    roots,
    plan: {
      minLines: 2,
      comment: ln => src.line(ln).trimStart().startsWith('#'),
      refs: (start, end) => {
        const refs = new RefSet();
        for (let ln = start; ln <= end && !refs.full; ln++) {
          const line = src.lines[ln - 1];
          if (line.length > 1000 || line.trimStart().startsWith('#')) continue;
          for (const m of line.matchAll(/\b(?:add_library|add_executable|add_subdirectory|find_package|include|target_link_libraries|target_include_directories|add_dependencies)\s*\(\s*([\w.${}/:-]+)/gi)) refs.add(m[1]);
          for (const m of line.matchAll(/\$\{([A-Za-z_][\w]*)\}/g)) refs.add(m[1]);
        }
        return refs.list;
      },
    },
  };
}

/** Offset just past the `)` closing the command whose `(` is at `open`. */
function cmakeCommandEnd(t: string, open: number, finder: Finder): number {
  const n = t.length;
  let depth = 0;
  let i = open;
  const limit = Math.min(n, open + 200_000);
  while (i < limit) {
    const c = t.charCodeAt(i);
    if (c === 40) depth++;
    else if (c === 41) {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === 34) {
      i++;
      while (i < limit && t.charCodeAt(i) !== 34) i += t.charCodeAt(i) === 92 ? 2 : 1;
    } else if (c === 35) {
      const m = /^#\[(=*)\[/.exec(t.slice(i, i + 40));
      if (m) {
        const e = finder.find(`]${m[1]}]`, i + m[0].length);
        i = e < 0 ? limit : e + m[1].length + 1;
      } else {
        const e = finder.find('\n', i);
        i = e < 0 ? limit : e;
      }
    } else if (c === 91) {
      const m = /^\[(=*)\[/.exec(t.slice(i, i + 40));
      if (m) {
        const e = finder.find(`]${m[1]}]`, i + m[0].length);
        i = e < 0 ? limit : e + m[1].length + 1;
      }
    }
    i++;
  }
  return Math.min(n, i);
}

// ---- shell -------------------------------------------------------------------------------------

const FUNCTION_HEADER = /^[ \t]*(?:function[ \t]+([A-Za-z_][\w:.@-]*)|([A-Za-z_][\w:.@-]*)[ \t]*\(\))[ \t]*(?:\(\))?[ \t]*/;
const CASE_START = /^[ \t]*case[ \t]+(.+?)[ \t]+in\b/;
const ESAC = /^[ \t]*(?:;;[ \t]*)?esac\b|;;[ \t]*esac\b/;

interface ShellFrame {
  node: TreeNode;
  children: TreeNode[];
  kind: 'function' | 'case';
  depth: number;
}

/** A quoted string that stays open this long is treated as a lexing mistake and dropped. */
const MAX_CONTEXT_LINES = 300;
const MAX_CONTEXT = 40;

/** Index of the `}` closing the `${...}` that starts at `from` (or the last index of the line). */
function skipExpansion(line: string, from: number): number {
  let depth = 1;
  let i = from + 2;
  for (; i < line.length && depth > 0; i++) {
    const c = line.charCodeAt(i);
    if (c === 123) depth++;
    else if (c === 125) depth--;
  }
  return i - 1;
}

export function scanShell(src: Source): Scan {
  const roots: TreeNode[] = [];
  const stack: ShellFrame[] = [];
  let pending: { name: string; start: number; waited: number } | undefined;
  /** Open quoting contexts: 39 ('), 34 ("), 96 (`) or 40 for $( ... ); `depths` counts parentheses inside the latter. */
  const ctx: number[] = [];
  const depths: number[] = [];
  let contextLines = 0;
  let heredoc: { word: string; strip: boolean } | undefined;
  let last = 0;

  const attach = (node: TreeNode): void => {
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
  };
  const functionFrame = (): ShellFrame | undefined => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].kind === 'function') return stack[k];
    return undefined;
  };

  for (let n = 1; n <= src.count; n++) {
    const line = src.lines[n - 1];
    if (heredoc) {
      const body = heredoc.strip ? line.replace(/^\t+/, '') : line;
      if (body.trimEnd() === heredoc.word) heredoc = undefined;
      continue;
    }
    let p = 0;
    if (!ctx.length) {
      const head = line.length > 300 ? line.slice(0, 300) : line;
      if (!pending) {
        const f = FUNCTION_HEADER.exec(head);
        if (f && /^(?:\{|#|$)/.test(head.slice(f[0].length))) {
          pending = { name: f[1] ?? f[2], start: n, waited: 0 };
          p = f[0].length;
        }
      }
      if (!pending) {
        const c = CASE_START.exec(head);
        if (c) {
          const node: TreeNode = { start: n, end: n, name: tidy(`case ${c[1]}`, 80), kind: 'sh_case', scopeName: tidy(`case ${c[1]}`, 60), children: [] };
          stack.push({ node, children: node.children!, kind: 'case', depth: 0 });
        } else if (ESAC.test(head)) {
          const at = stack.map(s => s.kind).lastIndexOf('case');
          if (at >= 0) {
            while (stack.length - 1 > at) stack.pop();
            const frame = stack.pop()!;
            frame.node.end = n;
            attach(frame.node);
          }
        }
      }
    }
    if (pending && !line.trim()) {
      continue;
    }
    // Scan the line for quotes, substitutions, comments, heredocs and standalone braces.
    if (ctx.length && ++contextLines > MAX_CONTEXT_LINES) {
      ctx.length = 0;
      depths.length = 0;
    }
    for (let i = p; i < line.length; i++) {
      const c = line.charCodeAt(i);
      const top = ctx.length ? ctx[ctx.length - 1] : 0;
      if (top === 39) {
        if (c === 39) ctx.pop();
        continue;
      }
      if (c === 92) {
        i++;
        continue;
      }
      const next = line.charCodeAt(i + 1);
      if (top === 34) {
        if (c === 34) ctx.pop();
        else if (c === 36 && next === 40 && ctx.length < MAX_CONTEXT) {
          ctx.push(40);
          depths.push(0);
          i++;
        } else if (c === 96 && ctx.length < MAX_CONTEXT) ctx.push(96);
        else if (c === 36 && next === 123) i = skipExpansion(line, i);
        continue;
      }
      if (top === 96) {
        if (c === 96) ctx.pop();
        else if ((c === 34 || c === 39) && ctx.length < MAX_CONTEXT) ctx.push(c);
        continue;
      }
      // Code: either the top level or the inside of $( ... ).
      if (c === 34 || c === 39 || c === 96) {
        if (ctx.length < MAX_CONTEXT) ctx.push(c);
        continue;
      }
      if (c === 36 && next === 40 && ctx.length < MAX_CONTEXT) {
        ctx.push(40);
        depths.push(0);
        i++;
        continue;
      }
      if (c === 36 && next === 123) {
        i = skipExpansion(line, i);
        continue;
      }
      if (top === 40) {
        if (c === 40) depths[depths.length - 1]++;
        else if (c === 41) {
          if (depths[depths.length - 1] > 0) depths[depths.length - 1]--;
          else {
            ctx.pop();
            depths.pop();
          }
        }
        continue;
      }
      const before = i === 0 ? 32 : line.charCodeAt(i - 1);
      const separated = i === 0 || isSpace(before) || before === 59 || before === 40 || before === 41 || before === 123 || before === 125 || before === 38 || before === 124;
      if (c === 35 && separated) break;
      if (c === 60 && next === 60 && line.charCodeAt(i + 2) !== 60) {
        const m = /^<<(-?)[ \t]*(["']?)([A-Za-z_]\w*)\2/.exec(line.slice(i, i + 80));
        if (m) {
          heredoc = { word: m[3], strip: m[1] === '-' };
          i += m[0].length - 1;
        }
      } else if (c === 123 && (i === 0 || isSpace(before) || before === 59 || before === 40 || before === 38 || before === 124 || before === 41) && (i + 1 >= line.length || isSpace(line.charCodeAt(i + 1)))) {
        if (pending) {
          const node: TreeNode = { start: pending.start, end: n, name: pending.name, kind: 'sh_function', scopeName: pending.name, children: [] };
          stack.push({ node, children: node.children!, kind: 'function', depth: 1 });
          pending = undefined;
        } else {
          const fn = functionFrame();
          if (fn) fn.depth++;
        }
      } else if (c === 125 && (i === 0 || isSpace(before) || before === 59 || before === 38 || before === 124) && (i + 1 >= line.length || /[\s;)&|><]/.test(line[i + 1]))) {
        const fn = functionFrame();
        if (fn && --fn.depth === 0) {
          const at = stack.indexOf(fn);
          while (stack.length - 1 > at) stack.pop();
          stack.pop();
          fn.node.end = n;
          attach(fn.node);
        }
      }
    }
    if (!ctx.length) contextLines = 0;
    if (pending && n - pending.start > 3) pending = undefined;
    last = n;
  }
  while (stack.length) {
    const frame = stack.pop()!;
    frame.node.end = Math.max(frame.node.start, last);
    attach(frame.node);
  }
  return {
    roots,
    plan: {
      comment: n => /^\s*#(?!!)/.test(src.line(n)),
      refs: (start, end) => {
        const refs = new RefSet();
        for (let n = start; n <= end && !refs.full; n++) {
          const line = src.lines[n - 1];
          if (line.length > 1000 || /^\s*#/.test(line)) continue;
          const source = /^\s*(?:source|\.)\s+["']?([^\s"';]+)/.exec(line);
          if (source) {
            refs.add(source[1]);
            refs.add(lastSegment(source[1]));
          }
          const call = /^\s*(?:if\s+)?(?:!\s+)?([A-Za-z_][\w:.@-]*)\s*(?:\(\))?\s*(?:[\s;|&]|$)/.exec(line);
          if (call && call[1].length > 2) refs.add(call[1]);
        }
        return refs.list;
      },
    },
  };
}
