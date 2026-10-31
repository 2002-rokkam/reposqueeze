import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePack, hasUntrustedNotice, excerptAtLine, type ParsedPack } from './packcheck.js';
import { classifyHit, scanSecrets, type HitClassification, type SecretHit } from './secrets.js';
import type { Tokenizer } from './tokens.js';

export interface HeaderInfo {
  revision?: string;
  files?: number;
  candidates?: number;
  excluded?: number;
  incomplete?: boolean;
  mode?: string;
}

const digits = (value: string): number => Number(value.replace(/\D/g, ''));

/** Header of a `context` pack: "REPOSQUEEZE <rev> | <files> files (<n> parsed candidates) | langs" plus the status line. */
export function parseContextHeader(text: string): HeaderInfo {
  const head = text.slice(0, 4000);
  const info: HeaderInfo = {};
  const first = /^REPOSQUEEZE (\S+) \| ([\d.,\s\u00a0\u202f]+) files(?: \(([\d.,\s\u00a0\u202f]+) parsed candidates\))?/m.exec(head);
  if (first) {
    info.revision = first[1];
    info.files = digits(first[2]);
    if (first[3]) info.candidates = digits(first[3]);
  }
  const status = /(\d+) files excluded; scan incomplete=(true|false); index mode=(\w+)/.exec(head);
  if (status) {
    info.excluded = Number(status[1]);
    info.incomplete = status[2] === 'true';
    info.mode = status[3];
  }
  return info;
}

/** Header of a `map` output: "REPOSITORY MAP <rev>" then "<files> files; <chunks> candidate chunks; <n> excluded; incomplete=<b>; mode=<m>." */
export function parseMapHeader(text: string): HeaderInfo {
  const head = text.slice(0, 2000);
  const info: HeaderInfo = {};
  const first = /^REPOSITORY MAP (\S+)/m.exec(head);
  if (first) info.revision = first[1];
  const status = /^([\d.,\s\u00a0\u202f]+) files; [\d.,\s\u00a0\u202f]+ candidate chunks; (\d+) excluded; incomplete=(true|false); mode=(\w+)/m.exec(head);
  if (status) {
    info.files = digits(status[1]);
    info.excluded = Number(status[2]);
    info.incomplete = status[3] === 'true';
    info.mode = status[4];
  }
  return info;
}

export interface FrameVerification {
  frames: number;
  /** Frames whose cited path is absolute, contains "..", or is not in the repository listing. */
  badPaths: string[];
  /** Frames whose body differs from the cited lines of the current file. */
  notVerbatim: { path: string; start: number; end: number }[];
  receiptsChecked: number;
  receiptsMatching: number;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Checks that every cited path exists in the repository and that each excerpt is verbatim source. */
export async function verifyFrames(root: string, pack: ParsedPack, listing: ReadonlySet<string>): Promise<FrameVerification> {
  const out: FrameVerification = { frames: pack.excerpts.length, badPaths: [], notVerbatim: [], receiptsChecked: 0, receiptsMatching: 0 };
  const cache = new Map<string, string[] | null>();
  const linesOf = async (path: string): Promise<string[] | null> => {
    if (!cache.has(path)) {
      try {
        cache.set(path, (await readFile(join(root, path), 'utf8')).split('\n'));
      } catch {
        cache.set(path, null);
      }
    }
    return cache.get(path)!;
  };
  for (const excerpt of pack.excerpts) {
    const { path, start, end } = excerpt;
    if (path.startsWith('/') || path.split(/[\\/]/).includes('..') || !listing.has(path)) {
      out.badPaths.push(path.slice(0, 200));
      continue;
    }
    const lines = await linesOf(path);
    const body = excerpt.body.join('\n');
    const expected = lines?.slice(start - 1, end).join('\n');
    if (expected === undefined || expected !== body) out.notVerbatim.push({ path, start, end });
    out.receiptsChecked++;
    if (sha(`${path}:${start}:${end}:${body}`).startsWith(excerpt.id)) out.receiptsMatching++;
  }
  return out;
}

export interface ExpandVerification {
  parsed: boolean;
  verbatim: boolean;
  receiptMatches: boolean | null;
  untrustedNotice: boolean;
}

/** Verifies the output of `expand`: header, citation range and verbatim body. */
export async function verifyExpand(root: string, path: string, output: string): Promise<ExpandVerification> {
  const lines = output.replace(/\n$/, '').split('\n');
  const result: ExpandVerification = { parsed: false, verbatim: false, receiptMatches: null, untrustedNotice: hasUntrustedNotice(output, 400) };
  const head = /^SOURCE ("(?:[^"\\]|\\.)*") @ ?([0-9a-f]+)$/.exec(lines[0] ?? '');
  const range = /^(\d+)-(\d+) of (\d+) lines$/.exec(lines[2] ?? '');
  if (!head || !range) return result;
  result.parsed = true;
  let file: string;
  try {
    file = await readFile(join(root, path), 'utf8');
  } catch {
    return result;
  }
  result.receiptMatches = sha(file).startsWith(head[2]);
  const start = Number(range[1]);
  const end = Number(range[2]);
  let body = lines.slice(3);
  if (body.length && /^\[Omitted requested lines \d+-\d+; expand again\.\]$/.test(body[body.length - 1])) body = body.slice(0, -1);
  result.verbatim = body.join('\n') === file.split('\n').slice(start - 1, end).join('\n');
  return result;
}

export interface SecretFinding {
  rule: string;
  match: string;
  line: number;
  sourcePath?: string;
  classification: HitClassification;
}

/** Scans tool output with the gitleaks-style rule set and attributes each hit to the excerpt it came from. */
export function findSecrets(output: string): SecretFinding[] {
  const hits = scanSecrets(output);
  if (!hits.length) return [];
  const pack = parsePack(output);
  return hits.map((hit: SecretHit) => {
    const sourcePath = excerptAtLine(pack, hit.line)?.path;
    return { rule: hit.rule, match: hit.match, line: hit.line, sourcePath, classification: classifyHit(hit, sourcePath) };
  });
}

export interface TokenCheck {
  tokens: number;
  approximated: boolean;
  withinBudget: boolean;
}

/** Counts o200k_base tokens of stdout without the single trailing newline that console.log appends. */
export function checkBudget(tokenizer: Tokenizer, stdout: string, budget: number): TokenCheck {
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  const tokens = tokenizer.count(body);
  return { tokens, approximated: tokenizer.approximated, withinBudget: tokens <= budget };
}
