import { createHash } from 'node:crypto';

/** Deterministic 32-bit seed derived from arbitrary string parts. */
export function seedFrom(...parts: (string | number)[]): number {
  const digest = createHash('sha256').update(parts.map(String).join('\u0000')).digest();
  return digest.readUInt32LE(0);
}

/** mulberry32: tiny, fast, well-distributed 32-bit PRNG. Never use Math.random in the suite. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  static from(...parts: (string | number)[]): Rng {
    return new Rng(seedFrom(...parts));
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Integer in [0, n). Throws on non-positive or non-integer n. */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new RangeError(`int(n) needs a positive integer, got ${n}`);
    return Math.floor(this.next() * n);
  }

  /** Integer in [lo, hi] inclusive. */
  between(lo: number, hi: number): number {
    if (hi < lo) throw new RangeError('between(lo, hi) needs hi >= lo');
    return lo + this.int(hi - lo + 1);
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new RangeError('pick() from an empty list');
    return items[this.int(items.length)];
  }

  /** Fisher-Yates on a copy; the input is never mutated. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Up to k distinct items in a random order. */
  sample<T>(items: readonly T[], k: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, k));
  }

  /** Random string over the given alphabet, for canaries and filler. */
  string(length: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'): string {
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[this.int(alphabet.length)];
    return out;
  }

  /** Independent stream derived from this one, so adding draws elsewhere cannot shift results. */
  fork(label: string): Rng {
    return Rng.from(this.int(0x7fffffff), label);
  }
}
