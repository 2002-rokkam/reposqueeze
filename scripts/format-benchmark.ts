import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { decode } from '@toon-format/toon';
import { compactJson } from '../src/structured.js';
import { compactLog } from '../src/compact.js';

const cases: [string,unknown][]=[
  ['uniform-table',Array.from({length:100},(_,i)=>({id:i,name:`item-${i}`,active:i%3===0,score:i/2}))],
  ['nested-config',{services:{api:{port:8080,headers:{accept:'application/json'},features:['cache','auth']},worker:{replicas:3,queue:{retry:4}}},enabled:true}],
  ['heterogeneous',[{name:'alpha',tags:['one','two']},null,42,'a,b\n"雪"',{nested:{a:[]}}]],
  ['small', {ok:true}],
  ['empty',[]],
  ['unicode',Array.from({length:40},(_,i)=>({id:i,text:'雪 नमस्ते hello',value:null}))]
];
const structured=[];
for(const [name,data] of cases)for(const pretty of [false,true]) {
  const input=JSON.stringify(data,null,pretty?2:undefined),result=compactJson(input);
  const roundtrip=result.format==='toon'?decode(result.text.slice('TOON (lossless JSON representation):\n'.length)):JSON.parse(result.text);
  assert.deepEqual(roundtrip,data);assert(result.stats.outputTokens<=result.stats.inputTokens);
  structured.push({name,pretty,format:result.format,...result.stats});
}
const logs=[
  ['repeated',Array(120).fill('worker heartbeat: healthy').join('\n')+'\nERROR final request failed: ECONNRESET'],
  ['mixed',Array.from({length:400},(_,i)=>i===216?'FAIL test validates authentication':`PASS case ${i}: checked ${i*7} values`).join('\n')],
  ['short','PASS all checks\n']
].map(([name,input])=>({name,...compactLog(input,512)}));
await writeFile('benchmarks/formats.json',JSON.stringify({protocol:'Six fresh synthetic JSON shapes, each minified and pretty; semantic round-trip equality checked. Three synthetic logs; log truncation is explicitly lossy and is not an accuracy benchmark.',structured,logs},null,2)+'\n');
console.log('12 JSON round trips and non-expansion checks passed; three log cases recorded.');
