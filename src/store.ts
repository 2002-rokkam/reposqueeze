// Persistent cache for RepoSqueeze indexes.
//
// The cache is derived data: it can always be rebuilt from the repository. Every failure (read-only file
// system, corruption, full disk, concurrent writers, hostile files) therefore degrades to in-memory operation
// and must never throw into a caller or leave a partially written file behind.
//
// Location: REPOSQUEEZE_CACHE_DIR (absolute path), otherwise the platform cache directory. The value `repo`
// selects the legacy in-repository location `<root>/.reposqueeze-v2/`; `off` disables persistence.
// A repository's cache lives in a subdirectory named after the first 16 hex digits of sha256(realpath(root)).
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, gunzipSync, gzipSync } from 'node:zlib';
import * as parserModule from './parser.js';
import { TOKENIZER_VERSION } from './tokenize.js';

// Bump PARSER_VERSION whenever parseSource()/the chunkers produce different chunks, names, kinds, refs or
// optional fields (a PARSER_VERSION exported by parser.ts is folded in automatically).
export const PARSER_VERSION = 1;
// Bump whenever readText()/textFromBytes() (secret redaction, decoding) produces different text for the same bytes.
export const TEXT_PIPELINE_VERSION = 1;
export const CACHE_FORMAT_VERSION = 1;

export const MAX_CACHE_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_TEMP_AGE_MS = 60 * 60 * 1000;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export type CacheMode = 'platform' | 'custom' | 'repo' | 'off';
export interface CacheLocation { mode: CacheMode; dir?: string }

function platformCacheBase(): string | undefined {
  try {
    if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'reposqueeze');
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'reposqueeze');
    const xdg = process.env.XDG_CACHE_HOME;
    return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache'), 'reposqueeze');
  } catch {
    return undefined;
  }
}

/** Resolves where the cache of one repository lives. Reads the environment but never touches the file system. */
export function cacheLocation(realRoot: string): CacheLocation {
  if (!LITTLE_ENDIAN) return { mode: 'off' };
  const setting = process.env.REPOSQUEEZE_CACHE_DIR?.trim();
  if (setting === 'off' || setting === 'none' || setting === 'memory') return { mode: 'off' };
  if (setting === 'repo') return { mode: 'repo', dir: join(realRoot, '.reposqueeze-v2') };
  const key = createHash('sha256').update(realRoot).digest('hex').slice(0, 16);
  if (setting) return { mode: 'custom', dir: join(resolve(setting), key) };
  const base = platformCacheBase();
  return base ? { mode: 'platform', dir: join(base, key) } : { mode: 'off' };
}

const ownedByCurrentUser = (stats: Stats) => typeof process.getuid !== 'function' || stats.uid === process.getuid();
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    if (bytesWritten <= 0) throw new Error('short write');
    offset += bytesWritten;
  }
}

/** Safe file access inside one cache directory. All methods swallow failures and remember the last one. */
export class CacheStore {
  readonly location: CacheLocation;
  lastError?: string;
  constructor(realRoot: string) { this.location = cacheLocation(realRoot); }

  get dir(): string | undefined { return this.location.dir; }
  get enabled(): boolean { return !!this.location.dir; }

  private note(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  /** Verifies that the cache directory is a real directory owned by this user; optionally creates it (0700). */
  private async prepare(create: boolean): Promise<boolean> {
    const dir = this.location.dir;
    if (!dir) return false;
    const verify = async (): Promise<boolean> => {
      const stats = await lstat(dir);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`refusing symlinked or non-directory cache path: ${dir}`);
      if (!ownedByCurrentUser(stats)) throw new Error(`refusing cache directory owned by another user: ${dir}`);
      if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) throw new Error(`refusing group/world-writable cache directory: ${dir}`);
      return true;
    };
    try {
      return await verify();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.note(error); return false; }
      if (!create) return false;
    }
    try {
      await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
      try { await mkdir(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return await verify();
    } catch (error) {
      this.note(error);
      return false;
    }
  }

  /** Reads a whole cache file, refusing symlinks, foreign owners and files above maxBytes. */
  async read(name: string, maxBytes = MAX_CACHE_FILE_BYTES): Promise<Buffer | undefined> {
    const dir = this.location.dir;
    if (!dir || !(await this.prepare(false))) return undefined;
    let handle: FileHandle | undefined;
    try {
      handle = await open(join(dir, name), fsConstants.O_RDONLY | NO_FOLLOW);
      const stats = await handle.stat();
      if (!stats.isFile() || !ownedByCurrentUser(stats)) throw new Error(`refusing unsafe cache file ${name}`);
      if (stats.size > maxBytes) throw new Error(`cache file ${name} exceeds ${maxBytes} bytes`);
      const buffer = Buffer.allocUnsafe(stats.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) throw new Error(`cache file ${name} was truncated while reading`);
        offset += bytesRead;
      }
      return buffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.note(error);
      return undefined;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Atomically replaces a cache file (temporary file + rename). Returns false when nothing was written. */
  async write(name: string, parts: readonly Uint8Array[]): Promise<boolean> {
    const dir = this.location.dir;
    if (!dir) return false;
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    if (size > MAX_CACHE_FILE_BYTES) { this.note(new Error(`cache file ${name} would exceed ${MAX_CACHE_FILE_BYTES} bytes`)); return false; }
    let temporary: string | undefined;
    try {
      if (!(await this.prepare(true))) return false;
      await this.removeStaleTemporaries();
      temporary = join(dir, `${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW, 0o600);
      try {
        for (const part of parts) await writeAll(handle, part);
      } finally {
        await handle.close();
      }
      await rename(temporary, join(dir, name));
      temporary = undefined;
      return true;
    } catch (error) {
      this.note(error);
      return false;
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async remove(name: string): Promise<void> {
    const dir = this.location.dir;
    if (!dir || !(await this.prepare(false))) return;
    await rm(join(dir, name), { force: true }).catch(error => this.note(error));
  }

  /** Temporary files of crashed writers are removed after an hour; best effort, never throws. */
  private async removeStaleTemporaries(): Promise<void> {
    const dir = this.location.dir;
    if (!dir) return;
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
        const path = join(dir, entry.name);
        const stats = await lstat(path);
        if (Date.now() - stats.mtimeMs > MAX_TEMP_AGE_MS) await rm(path, { force: true });
      }
    } catch { /* best effort */ }
  }
}

export interface CacheSummary {
  path?: string;
  mode: CacheMode;
  exists: boolean;
  totalBytes: number;
  entries: { name: string; bytes: number }[];
  error?: string;
}

async function realRootOf(root: string): Promise<string> {
  try { return await realpath(resolve(root)); } catch { return resolve(root); }
}

/** Size and entries of the cache of `root`, for a `cache` CLI command or diagnostics. */
export async function summarizeCache(root: string): Promise<CacheSummary> {
  const store = new CacheStore(await realRootOf(root));
  const summary: CacheSummary = { path: store.dir, mode: store.location.mode, exists: false, totalBytes: 0, entries: [] };
  if (!store.dir) return summary;
  try {
    const stats = await lstat(store.dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) { summary.error = 'not a real directory'; return summary; }
    summary.exists = true;
    for (const entry of await readdir(store.dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = (await lstat(join(store.dir, entry.name))).size;
      summary.entries.push({ name: entry.name, bytes });
      summary.totalBytes += bytes;
    }
    summary.entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') summary.error = error instanceof Error ? error.message : String(error);
  }
  return summary;
}

/** Deletes the cache of `root` (never anything outside its own cache directory). */
export async function clearCache(root: string): Promise<{ path?: string; removed: boolean; bytes: number; error?: string }> {
  const summary = await summarizeCache(root);
  if (!summary.path || !summary.exists || summary.error) return { path: summary.path, removed: false, bytes: 0, error: summary.error };
  try {
    await rm(summary.path, { recursive: true, force: true });
    return { path: summary.path, removed: true, bytes: summary.totalBytes };
  } catch (error) {
    return { path: summary.path, removed: false, bytes: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

let fingerprint: string | undefined;
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.scala', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.m', '.lua', '.sh', '.zig', '.ex', '.exs', '.md', '.json', '.yaml', '.yml', '.toml', '.sql', '.html', '.css', '.vue', '.svelte', '.txt', '.ipynb', '.proto', '.tf'];

/** Identifies the chunking behaviour that produced cached rows: version constants, language table and installed grammars. */
export async function parserFingerprint(): Promise<string> {
  if (fingerprint) return fingerprint;
  const namespace = parserModule as unknown as Record<string, unknown>;
  const languageFor = namespace.languageFor as ((path: string) => string) | undefined;
  const hash = createHash('sha256');
  hash.update(`${PARSER_VERSION}|${String(namespace.PARSER_VERSION ?? '')}`);
  for (const extension of PROBE_EXTENSIONS) hash.update(`|${extension}=${languageFor?.(`probe${extension}`) ?? ''}`);
  try {
    const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
    for (const name of (await readdir(assets)).filter(entry => /^tree-sitter.*\.wasm$/.test(entry)).sort()) {
      hash.update(`|${name}:${(await lstat(join(assets, name))).size}`);
    }
  } catch { hash.update('|no-assets'); }
  return (fingerprint = hash.digest('hex').slice(0, 16));
}

/** The version triple every persisted index header must carry and match to be reused. */
export async function cacheVersions(): Promise<{ format: number; parser: string; tokenizer: number; text: number }> {
  return { format: CACHE_FORMAT_VERSION, parser: await parserFingerprint(), tokenizer: TOKENIZER_VERSION, text: TEXT_PIPELINE_VERSION };
}

export class CacheCorruptError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Binary container: 32-byte preamble, then a body holding a section directory, a small JSON header and 8-byte aligned
// typed-array sections. The body may be gzip-compressed; a CRC-32 over the stored body detects corruption.
//   preamble: magic[8] | format u32 | flags u32 | storedBytes u32 | crc32 u32 | reserved[8]
//   body:     headerBytes u32 | sectionCount u32 | (name[16] | offset u32 | bytes u32)* | header JSON | pad | sections...
// ---------------------------------------------------------------------------------------------------------------
const PREAMBLE_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 24;
const FLAG_GZIP = 1;
const pad8 = (n: number) => (8 - (n % 8)) % 8;

export interface ContainerSection { name: string; data: ArrayBufferView }
type TypedArrayConstructor<T> = { new (buffer: ArrayBufferLike, byteOffset: number, length: number): T; BYTES_PER_ELEMENT: number };

export function encodeContainer(magic: string, header: unknown, sections: readonly ContainerSection[], options: { compress?: boolean } = {}): Uint8Array[] {
  if (magic.length !== 8) throw new Error('magic must be 8 characters');
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const directory = Buffer.alloc(8 + sections.length * DIRECTORY_ENTRY_BYTES);
  let offset = directory.length + json.length + pad8(json.length);
  directory.writeUInt32LE(json.length, 0);
  directory.writeUInt32LE(sections.length, 4);
  const bodyParts: Uint8Array[] = [directory, json, Buffer.alloc(pad8(json.length))];
  sections.forEach((section, index) => {
    const bytes = new Uint8Array(section.data.buffer, section.data.byteOffset, section.data.byteLength);
    if (section.name.length === 0 || section.name.length > 16) throw new Error(`invalid section name ${section.name}`);
    directory.write(section.name, 8 + index * DIRECTORY_ENTRY_BYTES, 16, 'latin1');
    directory.writeUInt32LE(offset, 8 + index * DIRECTORY_ENTRY_BYTES + 16);
    directory.writeUInt32LE(bytes.length, 8 + index * DIRECTORY_ENTRY_BYTES + 20);
    bodyParts.push(bytes, Buffer.alloc(pad8(bytes.length)));
    offset += bytes.length + pad8(bytes.length);
  });
  let stored: Uint8Array[] = bodyParts;
  if (options.compress) stored = [gzipSync(Buffer.concat(bodyParts), { level: 1 })];
  const storedBytes = stored.reduce((sum, part) => sum + part.length, 0);
  if (storedBytes > MAX_CACHE_FILE_BYTES) throw new Error('cache body too large');
  let crc = 0;
  for (const part of stored) crc = crc32(part, crc);
  const preamble = Buffer.alloc(PREAMBLE_BYTES);
  preamble.write(magic, 0, 8, 'latin1');
  preamble.writeUInt32LE(CACHE_FORMAT_VERSION, 8);
  preamble.writeUInt32LE(options.compress ? FLAG_GZIP : 0, 12);
  preamble.writeUInt32LE(storedBytes, 16);
  preamble.writeUInt32LE(crc >>> 0, 20);
  return [preamble, ...stored];
}

export interface DecodedContainer {
  header: unknown;
  has(name: string): boolean;
  bytes(name: string): Uint8Array;
  array<T>(name: string, kind: TypedArrayConstructor<T>): T;
}

export function decodeContainer(file: Buffer, magic: string, maxBodyBytes = MAX_CACHE_FILE_BYTES): DecodedContainer {
  if (file.length < PREAMBLE_BYTES || file.toString('latin1', 0, 8) !== magic) throw new CacheCorruptError('bad magic');
  if (file.readUInt32LE(8) !== CACHE_FORMAT_VERSION) throw new CacheCorruptError('unsupported container version');
  const flags = file.readUInt32LE(12), storedBytes = file.readUInt32LE(16), expectedCrc = file.readUInt32LE(20);
  if (flags & ~FLAG_GZIP) throw new CacheCorruptError('unknown flags');
  if (storedBytes !== file.length - PREAMBLE_BYTES) throw new CacheCorruptError('length mismatch');
  const stored = file.subarray(PREAMBLE_BYTES);
  if ((crc32(stored) >>> 0) !== expectedCrc) throw new CacheCorruptError('checksum mismatch');
  let body: Buffer;
  try {
    // A hostile file must not be able to inflate into gigabytes: real bodies compress far less than 32:1.
    const limit = Math.min(maxBodyBytes, Math.max(64 * 1024 * 1024, stored.length * 32));
    body = flags & FLAG_GZIP ? gunzipSync(stored, { maxOutputLength: limit }) : stored;
  } catch {
    throw new CacheCorruptError('cannot decompress');
  }
  // Typed-array views need aligned memory; a fresh read normally is, a slice of a pooled buffer might not be.
  if (body.byteOffset % 8 !== 0) body = Buffer.from(body);
  if (body.length < 8) throw new CacheCorruptError('truncated body');
  const headerBytes = body.readUInt32LE(0), sectionCount = body.readUInt32LE(4);
  const directoryEnd = 8 + sectionCount * DIRECTORY_ENTRY_BYTES;
  if (sectionCount > 4096 || directoryEnd + headerBytes > body.length) throw new CacheCorruptError('bad directory');
  const sections = new Map<string, [number, number]>();
  for (let i = 0; i < sectionCount; i++) {
    const at = 8 + i * DIRECTORY_ENTRY_BYTES;
    const name = body.toString('latin1', at, at + 16).replace(/\0+$/, '');
    const offset = body.readUInt32LE(at + 16), bytes = body.readUInt32LE(at + 20);
    if (!name || offset % 8 !== 0 || offset < directoryEnd + headerBytes || offset + bytes > body.length || sections.has(name)) throw new CacheCorruptError(`bad section ${name}`);
    sections.set(name, [offset, bytes]);
  }
  let header: unknown;
  try {
    header = JSON.parse(body.toString('utf8', directoryEnd, directoryEnd + headerBytes));
  } catch {
    throw new CacheCorruptError('bad header');
  }
  const locate = (name: string) => {
    const found = sections.get(name);
    if (!found) throw new CacheCorruptError(`missing section ${name}`);
    return found;
  };
  return {
    header,
    has: name => sections.has(name),
    bytes: name => { const [offset, bytes] = locate(name); return new Uint8Array(body.buffer, body.byteOffset + offset, bytes); },
    array: <T>(name: string, kind: TypedArrayConstructor<T>): T => {
      const [offset, bytes] = locate(name);
      if (bytes % kind.BYTES_PER_ELEMENT !== 0) throw new CacheCorruptError(`section ${name} has a partial element`);
      return new kind(body.buffer, body.byteOffset + offset, bytes / kind.BYTES_PER_ELEMENT);
    }
  };
}
