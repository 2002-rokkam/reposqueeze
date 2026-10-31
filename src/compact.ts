import { checkBudget, TOKENIZER, fit } from './tokens.js';
import { countInputTokens, countTokens } from './logs/safe-tokens.js';
import { capLine, cleanLine, detectPrefix, detectWorkspacePrefix, goTestEventToText, shortenPrefix, squashRuns } from './logs/normalize.js';
import { Tier, classifyLines, detectRunners } from './logs/patterns.js';
import { buildSegments, type Seg } from './logs/fold.js';
import { chooseSegments } from './logs/select.js';

export interface CompactLogOptions {
  /** `dedupe` (default) shows each warning template a couple of times; `keep` ranks warnings like summary lines. */
  warnings?: 'dedupe' | 'keep';
}

export interface LogStats {
  inputTokens: number;
  outputTokens: number;
  tokenizer: string;
  lossy: boolean;
  inputLines: number;
  inputBytes: number;
  /** Original lines replaced by a fold marker that is present in the output. */
  foldedLines: number;
  /** Fold markers that name a template: similar-line runs and "repeats of lines shown earlier". */
  templates: number;
  /** Original lines covered by an omission marker. */
  omittedLines: number;
  /** Failure-pattern lines in the input, how many are represented in the output (verbatim or inside a counted fold) and how many verbatim. */
  failureSignalsTotal: number;
  failureSignalsKept: number;
  failureSignalsVerbatim: number;
  runners: string[];
  /** Set when inputTokens is scaled from a sample (inputs over 384 KiB, or text with pathological character runs). */
  inputTokensEstimated?: boolean;
}

const MAX_BYTES = 2 * 1024 * 1024;
const SHORT_BUDGET = 600;
// Parse-time cap, then display caps by importance: ordinary lines are shortest, root errors and failing tests longest.
const SIGNAL_CAP = 2000;
const displayCap = (tier: number, signal: number) => (tier <= Tier.FailingTest ? 800 : signal ? 480 : 240);

interface ParsedLog {
  rawLines: string[];
  body: string[];
  /** Section (job/step) per line, or null when the log has no job/step columns. */
  section: Int32Array | null;
  sections: { job: string; step: string }[];
  redraws: number;
  truncated: number;
  squashed: number;
  /** `go test -json` event lines rewritten as plain go test text. */
  converted: number;
  stripped: number;
  prefixLabel: string;
  firstStamp: string;
  lastStamp: string;
  /** CI checkout directory that was shortened to "./" in the output, and the number of lines it was shortened in. */
  workspace: string | null;
  shortened: number;
}

/** Split into lines, resolve terminal control sequences and strip a dominant timestamp / job-step prefix. */
function parseLog(input: string): ParsedLog {
  let rawLines = input.split(input.includes('\n') || !input.includes('\r') ? '\n' : '\r');
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines = rawLines.slice(0, -1);
  const n = rawLines.length;
  const cleaned: string[] = new Array(n);
  let redraws = 0;
  for (let i = 0; i < n; i++) {
    if (rawLines[i] === '') { cleaned[i] = ''; continue; }
    const c = cleanLine(rawLines[i]);
    redraws += c.redraws;
    cleaned[i] = c.text;
  }

  const plan = detectPrefix(cleaned);
  const body: string[] = new Array(n);
  const section = plan ? new Int32Array(n).fill(-1) : null;
  const sections: { job: string; step: string }[] = [];
  const sectionIds = new Map<string, number>();
  let stripped = 0, truncated = 0, squashed = 0, converted = 0, current = -1, firstStamp = '', lastStamp = '';
  for (let i = 0; i < n; i++) {
    let text = cleaned[i];
    if (plan && text !== '') {
      const { body: rest, prefix } = plan.strip(text);
      if (prefix) {
        stripped++;
        text = rest.trimEnd();
        if (prefix.stamp) { if (!firstStamp) firstStamp = prefix.stamp; lastStamp = prefix.stamp; }
        if (prefix.job !== undefined) {
          const key = `${prefix.job}\t${prefix.step}`;
          let id = sectionIds.get(key);
          if (id === undefined) { id = sections.length; sectionIds.set(key, id); sections.push({ job: prefix.job, step: prefix.step ?? '' }); }
          current = id;
        }
      }
    }
    if (text.charCodeAt(0) === 123) {
      const plain = goTestEventToText(text);
      if (plain !== null) { text = plain; converted++; }
    }
    if (text.length >= 120) {
      const squeezed = squashRuns(text);
      if (squeezed !== text) squashed++;
      text = squeezed;
      if (text.length > SIGNAL_CAP) { text = capLine(text, SIGNAL_CAP); truncated++; }
    }
    body[i] = text;
    if (section) section[i] = current;
  }
  const workspace = detectWorkspacePrefix(body);
  let shortened = 0;
  if (workspace) {
    for (let i = 0; i < n; i++) {
      const short = shortenPrefix(body[i], workspace);
      if (short !== body[i]) { body[i] = short; shortened++; }
    }
  }
  return { rawLines, body, section, sections, redraws, truncated, squashed, converted, stripped, prefixLabel: plan?.label ?? '', firstStamp, lastStamp, workspace, shortened };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

export function compactLog(input: string, budget = 2000, options: CompactLogOptions = {}) {
  checkBudget(budget);
  const inputBytes = Buffer.byteLength(input);
  if (inputBytes > MAX_BYTES) throw new Error('log exceeds 2 MiB; select a smaller range');

  const parsed = parseLog(input);
  const { body, section, sections } = parsed;
  const n = body.length;
  const inputCount = countInputTokens(input, parsed.rawLines);

  const cls = classifyLines(body);
  let capped = 0;
  for (let i = 0; i < n; i++) {
    if (options.warnings === 'keep' && cls.warn[i] && cls.tier[i] > Tier.Summary) cls.tier[i] = Tier.Summary;
    const cap = displayCap(cls.tier[i], cls.signal[i]);
    if (body[i].length > cap) { body[i] = capLine(body[i], cap); capped++; }
  }
  parsed.truncated += capped;
  const folded = buildSegments(body, cls);
  const { segs } = folded;

  let signalsTotal = 0;
  for (let i = 0; i < n; i++) signalsTotal += cls.signal[i];
  const head = body.slice(0, 1500), tail = n > 3000 ? body.slice(n - 1500) : body.slice(1500);
  const runners = detectRunners([...head, ...tail].join('\n'));

  const short = budget < SHORT_BUDGET;
  const tokenCache = new Map<string, number>();
  const costOf = (text: string) => {
    let cost = tokenCache.get(text);
    if (cost === undefined) { cost = countTokens(text).tokens + 1; tokenCache.set(text, cost); }
    return cost;
  };

  const omitMarker = (from: number, to: number, selected: Uint8Array): string => {
    const a = segs[from].a, b = segs[to].b;
    let signals = 0, repeats = 0, warns = 0;
    for (let s = from; s <= to; s++) {
      const dupOf = segs[s].dupOf;
      if (dupOf !== undefined && selected[dupOf]) repeats += segs[s].signals; else signals += segs[s].signals;
      warns += segs[s].warns;
    }
    const notes: string[] = [];
    if (signals) notes.push(`${signals} FAILURE-PATTERN LINE${signals === 1 ? '' : 'S'}`);
    if (repeats) notes.push(`${plural(repeats, 'repeat')} of failure lines shown elsewhere`);
    if (warns && !short) notes.push(plural(warns, 'warning'));
    if (!short && b - a + 1 >= 12) {
      const counts = new Map<number, number>();
      for (let i = a; i <= b; i++) { const id = folded.fid[i]; if (id >= 0) counts.set(id, (counts.get(id) ?? 0) + 1); }
      let best = -1, bestCount = 0;
      for (const [id, count] of counts) if (count > bestCount) { best = id; bestCount = count; }
      if (best >= 0 && bestCount >= 6 && bestCount * 3 >= b - a + 1) notes.push(`mostly ${bestCount}x "${clip(folded.describe(best), 56)}"`);
    }
    return `[... L${a + 1}-L${b + 1} (${plural(b - a + 1, 'line')}) omitted${notes.length ? `; ${notes.join('; ')}` : ''}]`;
  };

  const render = (selected: Uint8Array, header: string): string => {
    const out: string[] = [header];
    let lastSection = -2, prev = -1;
    for (let s = 0; s <= segs.length; s++) {
      if (s < segs.length && !selected[s]) continue;
      if (s - prev > 1) out.push(omitMarker(prev + 1, s - 1, selected));
      if (s === segs.length) break;
      const id = section ? section[segs[s].a] : -1;
      if (id >= 0 && id !== lastSection) {
        out.push(`[job: ${sections[id].job}${sections[id].step ? ` | step: ${sections[id].step}` : ''}]`);
        lastSection = id;
      }
      out.push(segs[s].text);
      prev = s;
    }
    return out.join('\n');
  };

  const describeOutput = (selected: Uint8Array) => summarize(selected, segs, parsed, n, inputBytes, inputCount, signalsTotal, runners, short);

  const transformed = parsed.converted > 0 || parsed.stripped > 0 || parsed.shortened > 0 || parsed.truncated > 0 || parsed.squashed > 0 || parsed.redraws > 0 || segs.some(s => s.type !== 'line');
  let selected: Uint8Array = new Uint8Array(segs.length).fill(1);
  let report = describeOutput(selected);
  let text = transformed ? render(selected, report.header) : body.join('\n') + (input.endsWith('\n') && n > 0 && !(n === 1 && body[0] === '' && input === '') ? '\n' : '');
  let outputTokens = countTokens(text).tokens;

  if (outputTokens > budget) {
    const reserve = Math.max(costOf(report.header), short ? 40 : 64) + Math.min(sections.length, 4) * 13 + 4;
    const choose = (tokenBudget: number) => chooseSegments(
      { segs, kind: cls.kind, fid: folded.fid, costOf, edgeHead: section ? 0 : 3 }, tokenBudget, short ? 20 : 30, signalsTotal > 0 ? Math.round(budget / 4) : budget);
    // Per-line cost estimates and marker sizes are approximate: re-run the fill with the measured slack and keep the best fit.
    let tokenBudget = budget - reserve;
    let best: { selected: Uint8Array; report: typeof report; text: string; tokens: number } | null = null;
    let last = choose(tokenBudget);
    for (let round = 0; round < 4; round++) {
      const candidate = describeOutput(last.selected);
      const rendered = render(last.selected, candidate.header);
      const count = countTokens(rendered).tokens;
      if (count <= budget && (!best || count > best.tokens)) best = { selected: last.selected, report: candidate, text: rendered, tokens: count };
      if (count <= budget && budget - count <= 24) break;
      tokenBudget += budget - count - (count > budget ? 6 : 8);
      if (tokenBudget < 16) break;
      last = choose(tokenBudget);
    }
    if (best) {
      ({ selected, report, text } = best);
      outputTokens = best.tokens;
    } else {
      // Exact verification: drop the least important segments until the real token count fits.
      selected = last.selected;
      report = describeOutput(selected);
      text = render(selected, report.header);
      outputTokens = countTokens(text).tokens;
      for (let round = 0; outputTokens > budget && last.order.length > 0 && round < 40; round++) {
        let excess = outputTokens - budget + 6;
        while (excess > 0 && last.order.length > 0) { const s = last.order.pop()!; selected[s] = 0; excess -= costOf(segs[s].text); }
        report = describeOutput(selected);
        text = render(selected, report.header);
        outputTokens = countTokens(text).tokens;
      }
    }
    if (outputTokens > budget) {
      text = fit(text, budget, '\n[TRUNCATED: further lines cut to fit the budget. Inspect the raw log.]');
      outputTokens = countTokens(text).tokens;
    }
  }

  const estimate = inputCount.estimated ? { inputTokensEstimated: true } : {};
  // Nothing gained: return the original text rather than a transformed copy that is not smaller.
  if (outputTokens >= inputCount.tokens && inputCount.tokens <= budget) {
    return {
      text: input,
      stats: {
        ...report.stats, lossy: false, foldedLines: 0, templates: 0, omittedLines: 0, failureSignalsKept: signalsTotal, failureSignalsVerbatim: signalsTotal,
        inputTokens: inputCount.tokens, outputTokens: inputCount.tokens, tokenizer: TOKENIZER, ...estimate
      } as LogStats
    };
  }
  const stats: LogStats = { ...report.stats, inputTokens: inputCount.tokens, outputTokens, tokenizer: TOKENIZER, ...estimate };
  return { text, stats };
}

type OutputStats = Omit<LogStats, 'inputTokens' | 'outputTokens' | 'tokenizer' | 'inputTokensEstimated'>;

/** Header line and statistics describing exactly what the selected segments contain. */
function summarize(
  selected: Uint8Array, segs: readonly Seg[], parsed: ParsedLog, n: number, inputBytes: number,
  inputCount: { tokens: number; estimated: boolean }, signalsTotal: number, runners: string[], short: boolean
): { header: string; stats: OutputStats } {
  let kept = 0, verbatim = 0, foldedLines = 0, omittedLines = 0, templates = 0, omittedSignals = 0, exactOnly = true;
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (!selected[s]) {
      omittedLines += seg.b - seg.a + 1;
      if (seg.dupOf !== undefined && selected[seg.dupOf]) kept += seg.signals; else omittedSignals += seg.signals;
      continue;
    }
    kept += seg.signals;
    if (seg.type === 'line') { verbatim += seg.signals; continue; }
    foldedLines += seg.b - seg.a + 1;
    if (seg.type === 'run' || seg.type === 'hidden') templates++;
    if (!seg.exact) exactOnly = false;
  }
  const lossy = omittedLines > 0 || !exactOnly || parsed.converted > 0 || parsed.stripped > 0 || parsed.shortened > 0 || parsed.truncated > 0 || parsed.squashed > 0 || parsed.redraws > 0;
  const size = inputBytes >= 10240 ? `${Math.round(inputBytes / 1024)} KB` : `${inputBytes} B`;
  const parts = [lossy ? 'LOSSY' : 'LOSSLESS', `${plural(n, 'line')}, ${size}, ${inputCount.estimated ? '~' : ''}${inputCount.tokens} tokens in`];
  if (!short && runners.length) parts.push(`runners: ${runners.slice(0, 3).join(', ')}`);
  const dropped: string[] = [];
  if (parsed.stripped) dropped.push(`${parsed.prefixLabel}${parsed.firstStamp ? ` ${parsed.firstStamp.slice(0, 19)}..${parsed.lastStamp.slice(parsed.lastStamp.startsWith(parsed.firstStamp.slice(0, 10)) ? 11 : 0, 19)}` : ''}`);
  if (parsed.shortened && parsed.workspace) dropped.push(`${parsed.workspace} shown as ${parsed.workspace.includes('\\') ? '.\\' : './'}`);
  if (parsed.converted) dropped.push(`${plural(parsed.converted, 'go test -json event')} shown as text`);
  if (parsed.redraws) dropped.push(plural(parsed.redraws, 'progress redraw'));
  if (parsed.truncated) dropped.push(`${plural(parsed.truncated, 'over-long line')} shortened`);
  if (parsed.squashed) dropped.push(`${plural(parsed.squashed, 'long character run')} squashed`);
  if (dropped.length) parts.push(short ? 'prefixes/progress stripped' : `stripped: ${dropped.join('; ')}`);
  if (foldedLines || omittedLines) {
    parts.push(`folded ${foldedLines} lines${templates ? ` (${plural(templates, 'template')})` : ''}${omittedLines ? `, omitted ${omittedLines} lines` : ''}`);
  }
  if (signalsTotal === 0) parts.push('no failure-pattern lines found (not proof of success)');
  else if (omittedSignals === 0) parts.push(`failure-pattern lines kept ${kept}/${signalsTotal}`);
  else parts.push(`FAILURE-PATTERN LINES OMITTED: kept ${kept}/${signalsTotal} (see markers)`);
  if (foldedLines || omittedLines) parts.push('[... La-Lb] = original line range');
  return {
    header: `[RepoSqueeze log: ${parts.join(' | ')}]`,
    stats: {
      lossy, inputLines: n, inputBytes, foldedLines, templates, omittedLines, failureSignalsTotal: signalsTotal,
      failureSignalsKept: kept, failureSignalsVerbatim: verbatim, runners
    }
  };
}

