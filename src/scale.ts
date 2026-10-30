import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { hash, languageFor, terms } from './parser.js';
import { tokens } from './tokens.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const VERSION = 1;
const MAX_TERM_HASHES = 8192;
const INDEX_NAME = 'file-sketch-v1.json.gz';

export interface FileSketch {
  path: string;
  size: number;
  mtimeMs: number;
  digest: string;
  language: string;
  lines: number;
  tokenCount: number;
  termHashes: string;
}
interface StoredIndex {version:number; files:FileSketch[]}

// A stable 32-bit hash keeps the persistent file-level index compact. Collisions
// can add a candidate but cannot alter returned source or omit an exact match.
export function termHash(value:string) {
  let h=2166136261;
  for(let i=0;i<value.length;i++) {h^=value.charCodeAt(i);h=Math.imul(h,16777619);}
  return h>>>0;
}
function encodeHashes(values:number[]) {
  const buffer=Buffer.allocUnsafe(values.length*4);
  values.forEach((value,index)=>buffer.writeUInt32LE(value,index*4));
  return buffer.toString('base64');
}
function decodeHashes(encoded:string) {
  const buffer=Buffer.from(encoded,'base64');
  const out=new Uint32Array(Math.floor(buffer.length/4));
  for(let i=0;i<out.length;i++)out[i]=buffer.readUInt32LE(i*4);
  return out;
}
function contains(sorted:Uint32Array,value:number) {
  let low=0,high=sorted.length-1;
  while(low<=high){const mid=(low+high)>>>1,current=sorted[mid];if(current===value)return true;if(current<value)low=mid+1;else high=mid-1;}
  return false;
}
export function makeSketch(path:string,text:string,size:number,mtimeMs:number):FileSketch {
  const unique=new Set<number>();
  for(const term of [...terms(path),...terms(text)])unique.add(termHash(term));
  // Extremely large generated files are represented by a deterministic sample.
  // Ordinary source files stay well below this ceiling and therefore have no
  // file-level false negatives.
  const hashes=[...unique].sort((a,b)=>a-b);
  const sampled=hashes.length<=MAX_TERM_HASHES?hashes:hashes.filter((_,i)=>i%Math.ceil(hashes.length/MAX_TERM_HASHES)===0).slice(0,MAX_TERM_HASHES);
  return {path,size,mtimeMs,digest:hash(text),language:languageFor(path),lines:text.split('\n').length,tokenCount:tokens(`--- ${path} ---\n${text}`),termHashes:encodeHashes(sampled)};
}

export async function loadScaleIndex(root:string):Promise<Map<string,FileSketch>> {
  try {
    const raw=await decompress(await readFile(join(root,'.reposqueeze-v2',INDEX_NAME)));
    const parsed=JSON.parse(raw.toString('utf8')) as StoredIndex;
    if(parsed.version!==VERSION||!Array.isArray(parsed.files))return new Map();
    return new Map(parsed.files.map(file=>[file.path,file]));
  } catch {return new Map();}
}
export async function saveScaleIndex(root:string,files:FileSketch[]) {
  const dir=join(root,'.reposqueeze-v2');
  try {const stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('.reposqueeze-v2 must be a real directory');}
  catch(error:any) {if(error?.code==='ENOENT')await mkdir(dir,{mode:0o700});else throw error;}
  const target=join(dir,INDEX_NAME),temporary=`${target}.${process.pid}.tmp`;
  const body=await compress(JSON.stringify({version:VERSION,files} satisfies StoredIndex),{level:6});
  try {await writeFile(temporary,body,{mode:0o600});await rename(temporary,target);} finally {await rm(temporary,{force:true}).catch(()=>{});}
}

const foundation=/(^|\/)(?:readme(?:\.[^/]*)?|package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle|makefile|dockerfile|compose\.ya?ml|tsconfig\.json|[^/]*config[^/]*)$/i;
export function selectCandidates(files:FileSketch[],query:string) {
  const unique=[...new Set(terms(query).filter(term=>!/^\d+$/.test(term)))].slice(0,64);
  const hashes=unique.map(termHash);
  const decoded=files.map(file=>decodeHashes(file.termHashes));
  const dfs=hashes.map(value=>decoded.reduce((count,list)=>count+Number(contains(list,value)),0));
  const lower=query.toLowerCase();
  const rows=files.map((file,index)=>{
    const pathTerms=new Set(terms(file.path));
    let score=foundation.test(file.path)?0.35:0;
    hashes.forEach((value,i)=>{if(contains(decoded[index],value))score+=Math.log(1+(files.length-dfs[i]+0.5)/(dfs[i]+0.5));});
    for(const term of unique)if(pathTerms.has(term))score+=2.5;
    if(lower.includes(file.path.toLowerCase()))score+=1000;
    return {file,score};
  });
  const requested=Number(process.env.REPOSQUEEZE_MAX_CANDIDATES||0);
  const limit=Number.isInteger(requested)&&requested>=100&&requested<=5000?requested:Math.min(1800,Math.max(600,Math.ceil(Math.sqrt(files.length)*8)));
  const positive=rows.filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.file.path.localeCompare(b.file.path));
  if(positive.length<Math.min(200,files.length)) {
    const used=new Set(positive.map(row=>row.file.path));
    for(const row of rows.sort((a,b)=>a.file.path.localeCompare(b.file.path)))if(!used.has(row.file.path)){positive.push(row);used.add(row.file.path);if(positive.length>=Math.min(200,files.length))break;}
  }
  return positive.slice(0,limit).map(row=>row.file);
}
