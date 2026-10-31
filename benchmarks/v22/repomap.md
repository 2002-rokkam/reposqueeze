Gold-file coverage at 1500 tokens, 21 dev instances from 6 repositories

| variant | gold recall (95% CI) | any-gold hit | code-gold recall | described gold | Δ recall vs baseline (95% CI) | McNemar hit (only-A/only-B, p) | tokens | files shown | tok/file | defs/1k tok | build ms (median) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline-alphabetical | 9.5% [0.0%, 23.8%] | 9.5% | 9.5% | 9.5% | – | – | 1500 | 93.2 | 16.1 | 50.4 | 153.7 |
| pagerank-unfocused | 85.7% [71.4%, 100.0%] | 85.7% | 85.7% | 61.9% | 76.2 pp [57.1%, 90.5%] | 16/0, p=0.0000 | 1497 | 84.3 | 17.7 | 45.8 | 149.3 |
| pagerank-focused-terms | 85.7% [71.4%, 100.0%] | 85.7% | 85.7% | 76.2% | 76.2 pp [57.1%, 90.5%] | 16/0, p=0.0000 | 1496 | 83.3 | 18.0 | 46.5 | 128.4 |

Chance level for a random selection of as many files as variant "pagerank-unfocused" shows: 31.5% (mean of shown/total).
