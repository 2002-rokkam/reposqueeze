import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
await mkdir('dist', { recursive: true });
await mkdir('assets', { recursive: true });
await mkdir('releases', { recursive: true });
const languages = ['javascript', 'typescript', 'tsx', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'c_sharp', 'ruby'];
await copyFile('node_modules/web-tree-sitter/tree-sitter.wasm', 'assets/tree-sitter.wasm');
for (const lang of languages) {
  await copyFile(`node_modules/tree-sitter-wasms/out/tree-sitter-${lang}.wasm`, `assets/tree-sitter-${lang}.wasm`);
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
