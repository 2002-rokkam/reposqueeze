/** Locale-independent string comparison: orderings must be identical on every machine. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
