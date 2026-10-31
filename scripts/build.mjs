import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
await mkdir('dist', { recursive: true });
await mkdir('assets', { recursive: true });
await mkdir('releases', { recursive: true });
const languages = ['javascript', 'typescript', 'tsx', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'c_sharp', 'ruby', 'php', 'kotlin', 'scala', 'bash', 'elixir', 'ocaml', 'objc', 'solidity', 'zig'];
await copyFile('node_modules/web-tree-sitter/tree-sitter.wasm', 'assets/tree-sitter.wasm');
for (const lang of languages) {
  await copyFile(`node_modules/tree-sitter-wasms/out/tree-sitter-${lang}.wasm`, `assets/tree-sitter-${lang}.wasm`);
}
await writeFile('assets/libc-shim.wasm', libcShim());

// tree-sitter-bash imports libc `isalpha`, which the web-tree-sitter runtime does not export, so its scanner throws
// "_ is not a function" on `${x#y}` style expansions. This 68-byte dynamic-linking side module exports `isalpha`
// (ASCII letters only); src/parser.ts loads it through the runtime's `dynamicLibraries` option.
function libcShim() {
  const uleb = value => { const out = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value); return out; };
  const section = (id, payload) => [id, ...uleb(payload.length), ...payload];
  const name = text => [...uleb(text.length), ...Buffer.from(text)];
  const dylink = section(0, [...name('dylink.0'), 1, ...uleb(4), 0, 0, 0, 0]); // memory size/alignment, table size/alignment
  const types = section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]); // (i32) -> i32
  const functions = section(3, [1, 0]);
  const exported = section(7, [1, ...name('isalpha'), 0x00, 0]);
  // ((c | 32) - 'a') < 26 as an unsigned comparison
  const body = [0, 0x20, 0, 0x41, 32, 0x72, 0x41, 0xe1, 0x00, 0x6b, 0x41, 26, 0x49, 0x0b];
  const code = section(10, [1, ...uleb(body.length), ...body]);
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...dylink, ...types, ...functions, ...exported, ...code]);
}
const inputs=new Set();
for (const entry of ['cli', 'extension']) {
  const result=await build({entryPoints: [`src/${entry}.ts`], outfile: `dist/${entry}.cjs`, bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true, metafile:true,
    banner: entry === 'cli' ? {js: '#!/usr/bin/env node'} : undefined,
    define: { 'import.meta.url': 'importMetaUrl' },
    inject: ['scripts/import-meta.js'] });
  for(const input of Object.keys(result.metafile.inputs))inputs.add(input);
}
await cp('third_party','assets/licenses',{recursive:true});
const packages=new Map();
for(const input of inputs) {
  if(!input.includes('node_modules/'))continue;
  let dir=dirname(resolve(input));
  while(dir!==dirname(dir)) {
    try {const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));if(pkg.name){packages.set(dir,pkg);break;}}catch{}
    dir=dirname(dir);
  }
}
let notices='# Bundled JavaScript dependencies\n\nGenerated from the esbuild input graph. Grammar notices are in assets/licenses.\n';
for(const [dir,pkg] of packages) {
  notices+=`\n## ${pkg.name}@${pkg.version} (${pkg.license ?? 'see upstream license'})\n\n`;
  for(const file of await readdir(dir))if(/^(license|copying|notice)(\.|$)/i.test(file)) {
    notices+=`\n${await readFile(join(dir,file),'utf8')}\n`;
  }
}
await writeFile('assets/licenses/BUNDLED-DEPENDENCIES.txt',notices);
