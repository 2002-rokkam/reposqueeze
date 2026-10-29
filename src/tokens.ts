import { getEncoding } from 'js-tiktoken';
const encoder = getEncoding('o200k_base');
export const TOKENIZER = 'o200k_base';
export function tokens(text: string): number { return encoder.encode(text, [], []).length; }
export function checkBudget(n: number): number {
  if (!Number.isInteger(n) || n < 256 || n > 32000) throw new Error('budget must be an integer from 256 to 32000');
  return n;
}
export function fit(text: string, budget: number, suffix = '\n[truncated]'): string {
  if (tokens(text) <= budget) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tokens(text.slice(0, mid) + suffix) <= budget) low = mid; else high = mid - 1;
  }
  return text.slice(0, low) + suffix;
}
