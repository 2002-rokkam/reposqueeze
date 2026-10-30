import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, posix } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ignore, { type Ignore } from 'ignore';
import { hash, languageFor, parseSource } from './parser.js';
import { loadScaleIndex, makeSketch, saveScaleIndex, selectCandidates, type FileSketch } from './scale.js';
import type { Snapshot, SourceFile } from './types.js';

const exec = promisify(execFile);
const MAX_FILES=100_000,MAX_BYTES=2*1024*1024*1024,MAX_FILE_BYTES=2*1024*1024;
const excluded = /(^|\/)(?:\.git|\.hg|\.svn|node_modules|vendor|\.venv|venv|__pycache__|\.next|\.cache|\.reposqueeze|\.reposqueeze-v2|\.bench-repos|\.vscode-test|dist|build|coverage|target)(\/|$)/;
const secrets = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|keystore))$/i;
const binary = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|wasm|mp[34]|woff2?|ttf|exe|dll|so|dylib|sqlite|db|lock|map|vsix)$/i;
const secretContent = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{20,}["']/i;
export function allowedPath(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.split(/[\\/]/).includes('..') && !path.includes('\0') && !path.includes('\\') && !/[\r\n\x00-\x1f]/.test(path) && !excluded.test(path) && !secrets.test(path) && !binary.test(path) && !/(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path);
}

interface CandidateMeta {path:string;size:number;mtimeMs:number}
export class Repository {
  readonly root: string;
  private cache = new Map<string, SourceFile>();
  constructor(root: string) { this.root = resolve(root); }

  async snapshot(query=''): Promise<Snapshot> {
    const start = performance.now();
    const root = await realpath(this.root);
    const warnings: string[] = [];
    const ignoreRules = new Map<string, Ignore>();
    const custom = ignore();
    try { custom.add(await readFile(resolve(root, '.reposqueeze-v2ignore'), 'utf8')); } catch {}
    const ignored = async (path: string) => {
      if (custom.ignores(path)) return true;
      const dirs = [''];
      const parts = path.replace(/\/$/,'').split('/');
      for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join('/'));
      for (const dir of dirs) {
        if (!ignoreRules.has(dir)) {
          const rule = ignore();
          try { rule.add(await readFile(resolve(root, dir, '.gitignore'), 'utf8')); } catch {}
          ignoreRules.set(dir, rule);
        }
        if (ignoreRules.get(dir)!.ignores(dir ? path.slice(dir.length + 1) : path)) return true;
      }
      return false;
    };
    let paths:string[]=[],truncated=false,git=true;
    try {
      const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], {cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 30000});
      paths = [...new Set(stdout.split('\0').filter(Boolean))].sort();
    } catch {
      git=false;
      const walk = async (dir: string, depth = 0): Promise<void> => {
        if (depth > 60 || paths.length >= MAX_FILES) { truncated = true; return; }
        const entries = (await readdir(resolve(root, dir), {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const path = posix.join(dir, entry.name);
          if (!allowedPath(path) || entry.isSymbolicLink() || await ignored(path + (entry.isDirectory() ? '/' : ''))) continue;
          if (entry.isDirectory()) await walk(path, depth + 1); else if (entry.isFile()) paths.push(path);
          if (paths.length >= MAX_FILES) { truncated = true; break; }
        }
      };
      await walk('');
      warnings.push('Non-Git enumeration; nested .gitignore and .reposqueeze-v2ignore applied.');
    }
    if(paths.length>MAX_FILES){paths=paths.slice(0,MAX_FILES);truncated=true;}
    let skipped=0,totalBytes=0;
    const metadata:CandidateMeta[]=[];
    for(let offset=0;offset<paths.length;offset+=64){
      const batch=paths.slice(offset,offset+64);
      const stats=await Promise.all(batch.map(async path=>{
        if(!allowedPath(path)||await ignored(path))return null;
        try{const stat=await lstat(resolve(root,path));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE_BYTES)return null;return {path,size:stat.size,mtimeMs:Math.trunc(stat.mtimeMs)};}
        catch{return null;}
      }));
      for(const meta of stats){if(!meta){skipped++;continue;}if(totalBytes+meta.size>MAX_BYTES){truncated=true;continue;}totalBytes+=meta.size;metadata.push(meta);}
    }
    const thresholdValue=Number(process.env.REPOSQUEEZE_LARGE_THRESHOLD||5000);
    const threshold=Number.isInteger(thresholdValue)&&thresholdValue>=10?thresholdValue:5000;
    if(metadata.length<=threshold)return this.fullSnapshot(root,metadata,start,warnings,skipped,truncated,totalBytes);
    return this.cascadeSnapshot(root,metadata,query,start,warnings,skipped,truncated,totalBytes,git);
  }

  private async safeText(root:string,meta:CandidateMeta) {
    const abs=resolve(root,meta.path);
    const actual=await realpath(abs);
    if(actual!==abs||relative(root,actual).startsWith('..'+sep))throw new Error('outside repository');
    const buffer=await readFile(abs);
    if(buffer.includes(0))throw new Error('binary');
    const text=buffer.toString('utf8');
    if(secretContent.test(text))throw new Error('secret-like content');
    return text;
  }
  private async parsedFile(root:string,meta:CandidateMeta):Promise<SourceFile> {
    const text=await this.safeText(root,meta),digest=hash(text),cached=this.cache.get(meta.path);
    return cached?.hash===digest?cached:{path:meta.path,text,hash:digest,language:languageFor(meta.path),...await parseSource(meta.path,text)};
  }
  private async fullSnapshot(root:string,metadata:CandidateMeta[],start:number,warnings:string[],skipped:number,truncated:boolean,totalBytes:number):Promise<Snapshot> {
    const files:SourceFile[]=[];
    for(const meta of metadata)try{files.push(await this.parsedFile(root,meta));}catch{skipped++;}
    this.cache=new Map(files.map(file=>[file.path,file]));
    if(truncated)warnings.push('Repository exceeds safety limits (100,000 files / 2 GiB indexed text / 2 MiB per file / depth 60); index is incomplete.');
    const fallback=files.filter(file=>file.language!=='text'&&!file.parsed).length;
    if(fallback)warnings.push(`${fallback} source files have parse errors or unavailable grammars; line-window search remains active.`);
    return {root,files,chunks:files.flatMap(file=>file.chunks),revision:hash(files.map(file=>`${file.path}:${file.hash}`).join('\n')).slice(0,16),warnings,skipped,truncated,elapsedMs:performance.now()-start,totalFiles:files.length,totalBytes,totalTokens:undefined,candidateFiles:files.length,indexMode:'full',inventory:files.map(file=>({path:file.path,language:file.language,lines:file.text.split('\n').length}))};
  }
  private async cascadeSnapshot(root:string,metadata:CandidateMeta[],query:string,start:number,warnings:string[],skipped:number,truncated:boolean,totalBytes:number,git:boolean):Promise<Snapshot> {
    const previous=await loadScaleIndex(root),force=process.env.REPOSQUEEZE_REFRESH_INDEX==='1';
    const sketches:FileSketch[]=[];let reused=0,refreshed=0;
    for(let offset=0;offset<metadata.length;offset+=24){
      const batch=metadata.slice(offset,offset+24);
      const built=await Promise.all(batch.map(async meta=>{
        const old=previous.get(meta.path);
        if(!force&&old&&old.size===meta.size&&old.mtimeMs===meta.mtimeMs){reused++;return old;}
        try{const text=await this.safeText(root,meta);refreshed++;return makeSketch(meta.path,text,meta.size,meta.mtimeMs);}catch{skipped++;return null;}
      }));
      for(const sketch of built)if(sketch)sketches.push(sketch);
    }
    if(refreshed||sketches.length!==previous.size)await saveScaleIndex(root,sketches);
    const selected=selectCandidates(sketches,query),metaByPath=new Map(metadata.map(meta=>[meta.path,meta]));
    const files:SourceFile[]=[];
    for(const sketch of selected){const meta=metaByPath.get(sketch.path);if(!meta)continue;try{files.push(await this.parsedFile(root,meta));}catch{skipped++;}}
    this.cache=new Map(files.map(file=>[file.path,file]));
    warnings.push(`Large-repository cascade: ${files.length.toLocaleString()} candidates parsed from ${sketches.length.toLocaleString()} eligible files; ${reused.toLocaleString()} file sketches reused and ${refreshed.toLocaleString()} refreshed.`);
    warnings.push('File sketches contain hashes, counts and term fingerprints only; returned evidence is re-read verbatim from current source. Set REPOSQUEEZE_REFRESH_INDEX=1 after timestamp-preserving external edits.');
    if(!git)warnings.push('Use a Git working tree for the strongest change detection and ignore behavior at this scale.');
    if(truncated)warnings.push('Repository exceeds safety limits (100,000 files / 2 GiB indexed text / 2 MiB per file / depth 60); index is incomplete.');
    const fallback=files.filter(file=>file.language!=='text'&&!file.parsed).length;
    if(fallback)warnings.push(`${fallback} candidate files have parse errors or unavailable grammars; line-window search remains active.`);
    return {root,files,chunks:files.flatMap(file=>file.chunks),revision:hash(sketches.map(file=>`${file.path}:${file.digest}`).join('\n')).slice(0,16),warnings,skipped,truncated,elapsedMs:performance.now()-start,totalFiles:sketches.length,totalBytes,totalTokens:sketches.reduce((sum,file)=>sum+file.tokenCount,0),candidateFiles:files.length,indexMode:'cascade',inventory:sketches.map(file=>({path:file.path,language:file.language,lines:file.lines}))};
  }
}
