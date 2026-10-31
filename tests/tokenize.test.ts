import test from 'node:test';
import assert from 'node:assert/strict';
import { stem } from '../src/stem.js';
import { terms, TOKENIZER_VERSION } from '../src/tokenize.js';

// Reference pairs from Porter's paper and vocabulary plus a few code-search words.
const PORTER: Record<string, string> = {
  caresses: 'caress', ponies: 'poni', ties: 'ti', caress: 'caress', cats: 'cat', feed: 'feed', agreed: 'agre', plastered: 'plaster',
  bled: 'bled', motoring: 'motor', sing: 'sing', conflated: 'conflat', troubled: 'troubl', sized: 'size', hopping: 'hop',
  tanned: 'tan', falling: 'fall', hissing: 'hiss', fizzed: 'fizz', failing: 'fail', filing: 'file', happy: 'happi', sky: 'sky',
  relational: 'relat', conditional: 'condit', rational: 'ration', valenci: 'valenc', hesitanci: 'hesit', digitizer: 'digit',
  conformabli: 'conform', radicalli: 'radic', differentli: 'differ', vileli: 'vile', analogousli: 'analog', vietnamization: 'vietnam',
  predication: 'predic', operator: 'oper', feudalism: 'feudal', decisiveness: 'decis', hopefulness: 'hope', callousness: 'callous',
  formaliti: 'formal', sensitiviti: 'sensit', sensibiliti: 'sensibl', triplicate: 'triplic', formative: 'form', formalize: 'formal',
  electriciti: 'electr', electrical: 'electr', hopeful: 'hope', goodness: 'good', revival: 'reviv', allowance: 'allow',
  inference: 'infer', airliner: 'airlin', gyroscopic: 'gyroscop', adjustable: 'adjust', defensible: 'defens', irritant: 'irrit',
  replacement: 'replac', adjustment: 'adjust', dependent: 'depend', adoption: 'adopt', communism: 'commun', activate: 'activ',
  angulariti: 'angular', homologous: 'homolog', effective: 'effect', bowdlerize: 'bowdler', probate: 'probat', rate: 'rate',
  cease: 'ceas', controll: 'control', roll: 'roll',
  budgets: 'budget', packing: 'pack', parsing: 'pars', parse: 'pars', handlers: 'handler', configured: 'configur', configuration: 'configur',
};

test('Porter stemmer reproduces the reference vocabulary', () => {
  for (const [word, expected] of Object.entries(PORTER)) assert.equal(stem(word), expected, word);
});

test('stemmer leaves non-words alone and never throws on odd input', () => {
  for (const word of ['', 'a', 'is', 'utf8', 'café', 'CamelCase', '123', 'x'.repeat(10_000)]) assert.doesNotThrow(() => stem(word));
  assert.equal(stem('utf8'), 'utf8');
  assert.equal(stem('café'), 'café');
});

test('tokenizer v2 splits identifiers, keeps the joined identifier and stems words', { skip: TOKENIZER_VERSION !== 2 }, () => {
  assert.deepEqual(terms('getHTTPServerResponse'), ['get', 'http', 'server', 'respons', 'gethttpserverresponse']);
  assert.deepEqual(terms('retry_backoff_ms'), ['retri', 'backoff', 'ms', 'retrybackoffms']);
  assert.deepEqual(terms('utf8Decode'), ['utf8', 'decod', 'utf8decode']);
  assert.deepEqual(terms('MAX_RETRIES'), ['max', 'retri', 'maxretries']);
  assert.deepEqual(terms('budgets'), terms('budget'));
  assert.deepEqual(terms('Packing packed packs'), ['pack', 'pack', 'pack']);
});

test('tokenizer drops stop words, one-letter words and hash-like blobs', { skip: TOKENIZER_VERSION !== 2 }, () => {
  assert.deepEqual(terms('the Cat and THE dog'), ['cat', 'dog']);
  assert.deepEqual(terms('d41d8cd98f00b204e9800998ecf8427e commit'), ['commit']);
  assert.deepEqual(terms('x'.repeat(200)), []);
  assert.deepEqual(terms('   \n\t'), []);
});

test('tokenizer keeps Unicode letters and is linear on pathological input', () => {
  assert.ok(terms('café naïve 测试').length >= 3);
  const started = performance.now();
  terms('aB'.repeat(500_000));
  terms('_'.repeat(1_000_000));
  terms(('word ' + 'A'.repeat(50) + ' ').repeat(40_000));
  assert.ok(performance.now() - started < 5000);
});

test('token counting is linear for unbroken runs and never undercounts', async () => {
  const { tokens, fit } = await import('../src/tokens.js');
  const run = 'AbCd0123'.repeat(25_000);
  tokens('warm up the encoder');
  const started = performance.now();
  const count = tokens(run);
  assert.ok(performance.now() - started < 8000, 'a 200,000-character run is counted quickly');
  assert.ok(count >= tokens(run.slice(0, 1000)) * 150);
  assert.ok(tokens(fit(run, 300)) <= 300);
  assert.equal(tokens('plain short text'), tokens('plain short text'));
});
