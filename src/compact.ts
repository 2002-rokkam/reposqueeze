import { checkBudget, tokens, fit, TOKENIZER } from './tokens.js';

export function compactLog(input: string, budget = 2000) {
  checkBudget(budget);
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error('log exceeds 2 MiB; select a smaller range');
  const clean = input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const lines = clean.split('\n');
  const folded: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    folded.push(lines[i]);
    if (j-i > 1) folded.push(`[Previous line repeated ${j-i} times total]`);
    i = j-1;
  }
  let text = folded.join('\n');
  let lossy = false;
  if (tokens(text) > budget) {
    lossy = true;
    const important = new Set<number>();
    const markers = /error|fail|exception|traceback|panic|fatal|warning|assert|expected|actual|not ok|^\s*at\s|^E\s|^\+|^\-|passed|tests?\b.*\d|exit|summary/i;
    for (let i = 0; i < folded.length; i++) if (markers.test(folded[i])) for (let j=Math.max(0,i-2);j<=Math.min(folded.length-1,i+2);j++) important.add(j);
    for (let i=0;i<Math.min(4,folded.length);i++) important.add(i);
    for (let i=Math.max(0,folded.length-8);i<folded.length;i++) important.add(i);
    const output: string[] = ['[LOSSY LOG: omitted lines; inspect raw output before concluding success or diagnosing missing details.]'];
    let previous = -1;
    for (const i of [...important].sort((a,b)=>a-b)) {
      if (i > previous + 1) output.push(`[${i-previous-1} lines omitted]`);
      output.push(`${i+1}: ${folded[i]}`); previous=i;
    }
    text = fit(output.join('\n'), budget, '\n[TRUNCATED: additional diagnostics may be omitted. Inspect raw log.]');
  }
  if (tokens(text) >= tokens(input)) { text = tokens(input) <= budget ? input : text; }
  return {text, stats:{inputTokens:tokens(input),outputTokens:tokens(text),tokenizer:TOKENIZER,lossy}};
}
