import { encode, decode } from '@toon-format/toon';
import { parse, isSafeNumber } from 'lossless-json';
import { isDeepStrictEqual } from 'node:util';
import { tokens, TOKENIZER } from './tokens.js';

export function compactJson(input: string) {
  if (Buffer.byteLength(input) > 2*1024*1024) throw new Error('JSON exceeds 2 MiB');
  // Decline conversion rather than silently round large integers or precise decimals.
  const data = parse(input,undefined,{parseNumber: value => {
    if (!isSafeNumber(value) || Object.is(Number(value),-0)) throw new Error('Numeric precision requires original JSON; conversion declined');
    return Number(value);
  }});
  const candidates = [{format:'json',text:input},{format:'json-minified',text:JSON.stringify(data)}];
  // Strictly verify the candidate codec before it can be selected.
  try {
    const toon = encode(data);
    if (isDeepStrictEqual(decode(toon),data)) candidates.push({format:'toon',text:'TOON (lossless JSON representation):\n'+toon});
  } catch { /* JSON remains the fallback for codec limitations. */ }
  const selected = candidates.map(c=>({...c,count:tokens(c.text)})).sort((a,b)=>a.count-b.count)[0];
  return {text:selected.text,format:selected.format,stats:{inputTokens:tokens(input),outputTokens:selected.count,tokenizer:TOKENIZER,roundTripVerified:true}};
}
