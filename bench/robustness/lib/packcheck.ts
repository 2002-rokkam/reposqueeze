/**
 * Structural parser for the text packs produced by `context`.
 *
 * Excerpts are framed as
 *   --- "<json path>":<start>-<end> id=<16 hex> ---
 *   <verbatim source>
 *   --- END SOURCE ---
 * Everything outside such frames is tool-authored text (header, notices, tail). Repository content
 * that appears there escaped its frame, which is what the prompt-injection checks look for.
 */

export interface ParsedExcerpt {
  path: string;
  start: number;
  end: number;
  id: string;
  body: string[];
  /** One-based line of the opening frame marker within the pack text. */
  headerLine: number;
  /** True when the closing marker was found. */
  closed: boolean;
}

export interface OutsideLine {
  line: number;
  text: string;
}

export interface ParsedPack {
  /** Lines before the first excerpt. */
  header: string[];
  excerpts: ParsedExcerpt[];
  /** Non-blank lines located between/after frames (not part of any excerpt body). */
  outside: OutsideLine[];
  endMarkers: number;
}

const FRAME_OPEN = /^--- ("(?:[^"\\]|\\.)*"):(\d+)-(\d+) id=([0-9a-f]{16}) ---$/;
const FRAME_CLOSE = '--- END SOURCE ---';

export function parsePack(text: string): ParsedPack {
  const lines = text.split('\n');
  const parsed: ParsedPack = { header: [], excerpts: [], outside: [], endMarkers: 0 };
  let current: ParsedExcerpt | null = null;
  lines.forEach((line, index) => {
    if (current) {
      if (line === FRAME_CLOSE) {
        current.closed = true;
        parsed.endMarkers++;
        current = null;
      } else {
        current.body.push(line);
      }
      return;
    }
    const open = FRAME_OPEN.exec(line);
    if (open) {
      let path: string;
      try {
        path = JSON.parse(open[1]) as string;
      } catch {
        path = open[1];
      }
      current = { path, start: Number(open[2]), end: Number(open[3]), id: open[4], body: [], headerLine: index + 1, closed: false };
      parsed.excerpts.push(current);
      return;
    }
    if (line === FRAME_CLOSE) {
      parsed.endMarkers++;
      parsed.outside.push({ line: index + 1, text: line });
      return;
    }
    if (!parsed.excerpts.length) parsed.header.push(line);
    else if (line.trim()) parsed.outside.push({ line: index + 1, text: line });
  });
  return parsed;
}

/** The excerpt whose frame contains one-based pack line `line`, if any. */
export function excerptAtLine(pack: ParsedPack, line: number): ParsedExcerpt | undefined {
  return pack.excerpts.find(excerpt => line > excerpt.headerLine && line <= excerpt.headerLine + excerpt.body.length);
}

/** Lines of tool-authored text (header, between frames, tail) that contain `marker`. */
export function markerOutsideFrames(text: string, marker: RegExp | string): OutsideLine[] {
  const parsed = parsePack(text);
  const test = (value: string) => (typeof marker === 'string' ? value.includes(marker) : marker.test(value));
  const headerHits = parsed.header.map((value, i) => ({ line: i + 1, text: value })).filter(row => test(row.text));
  return [...headerHits, ...parsed.outside.filter(row => test(row.text))];
}

export const UNTRUSTED_NOTICE = /untrusted[^\n]{0,80}(?:not|never)[^\n]{0,40}instruction/i;

/** True when the first `window` characters carry an untrusted-data notice. */
export function hasUntrustedNotice(text: string, window = 1200): boolean {
  return UNTRUSTED_NOTICE.test(text.slice(0, window));
}

/** Number of unmatched frame markers: more END markers than frames, or frames never closed. */
export function frameImbalance(text: string): number {
  const parsed = parsePack(text);
  const opened = parsed.excerpts.length;
  const closedProperly = parsed.excerpts.filter(excerpt => excerpt.closed).length;
  return Math.abs(parsed.endMarkers - closedProperly) + (opened - closedProperly);
}
