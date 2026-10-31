// Pure text helpers that turn comment, docstring and declaration source into plain structure fields.

export const SIGNATURE_LIMIT = 240;
export const DOC_LIMIT = 400;

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cuts to `limit` characters, marking the cut with an ellipsis that still fits inside the limit. */
export function clipText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

const BLOCK_OPEN = /^(?:\/\*+!?|\(\*+|<!--|=begin\b)/;
const BLOCK_CLOSE = /(?:\*+\/|\*+\)|-->|\n=end\b.*)\s*$/;

/** Removes the delimiters of one comment: a block comment (C or OCaml style) or consecutive `//`, `///`, `#`, `--` lines. */
export function stripComment(raw: string): string {
  const text = raw.trim();
  if (BLOCK_OPEN.test(text)) {
    return text
      .replace(BLOCK_OPEN, '')
      .replace(BLOCK_CLOSE, '')
      .split('\n')
      .map(line => line.replace(/^\s*\*+(?!\/)\s?/, ''))
      .join('\n');
  }
  return text.split('\n').map(line => line.replace(/^\s*(?:\/\/[/!]?|#+|--+|;+|%+)\s?/, '')).join('\n');
}

/** Python docstring literal -> its content (prefixes, quotes and common indentation removed). */
export function stripDocstring(raw: string): string {
  const body = raw.trim().replace(/^[rRuUbBfF]{0,2}("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '');
  const lines = body.split('\n');
  const indents = lines.slice(1).filter(line => line.trim()).map(line => line.length - line.trimStart().length);
  const indent = indents.length ? Math.min(...indents) : 0;
  return [lines[0], ...lines.slice(1).map(line => line.slice(indent))].join('\n');
}

/** `@doc """text"""` / `@moduledoc "text"` -> `text`; other module attributes (`@spec`, `@impl`) are not documentation. */
export function stripElixirDoc(raw: string): string | undefined {
  const match = /^@(?:module|type)?doc\s+(?:~[sS])?("""|'''|"|')([\s\S]*?)\1\s*$/.exec(raw.trim());
  if (!match) return undefined;
  return stripDocstring(`${match[1]}${match[2]}${match[1]}`);
}

/** Joins documentation fragments into the single-line `doc` field. */
export function docText(fragments: readonly string[]): string | undefined {
  const text = collapse(fragments.join(' '));
  return text ? clipText(text, DOC_LIMIT) : undefined;
}

export function signatureText(raw: string): string | undefined {
  const text = collapse(raw);
  return text ? clipText(text, SIGNATURE_LIMIT) : undefined;
}
