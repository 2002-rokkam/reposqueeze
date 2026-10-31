# Recomputes retrieval metrics counting ONLY code that is actually printed in a pack (excludes the "Also relevant (not shown)" pointer lines).
# Run from a bench results directory that contains rows.jsonl and packs/<variant>/<instance>.txt.gz.
import json,gzip,re,sys
rows=[json.loads(l) for l in open('rows.jsonl')]
def parse(text, include_pointers):
    segs=[]  # (path, start, end)
    pointer=False
    for line in text.split('\n'):
        if line.startswith('Also relevant (not shown)'): pointer=True; continue
        if pointer:
            m=re.match(r'^(\S.*?):(\d+)-(\d+)  ',line)
            if m and include_pointers: segs.append((m.group(1),int(m.group(2)),int(m.group(3))))
            continue
        m=re.match(r'^--- (.+?):([\d,\-]+) #[0-9a-f]+',line) or re.match(r'^--- "(.+?)":([\d,\-]+) id=[0-9a-f]+ ---',line)
        if m:
            for r in m.group(2).split(','):
                a=r.split('-'); s=int(a[0]); e=int(a[-1]); segs.append((m.group(1),s,e))
    return segs
def metrics(row,segs):
    gold=row['goldRanges']
    if not gold: return None
    files=set(p for p,_,_ in segs)
    hit=any(g in files for g in gold)
    rec=sum(g in files for g in gold)/len(gold)
    tot=0;cov=0
    for g,rs in gold.items():
        for a,b in rs:
            for l in range(a,b+1):
                tot+=1
                if any(p==g and s<=l<=e for p,s,e in segs): cov+=1
    return hit,rec,(cov/tot if tot else 0)
out={}
for variant in ['baseline','current']:
    for mode in (['all','strict'] if variant=='current' else ['all']):
        acc=[];
        for r in rows:
            if r['variant']!=variant or r['status']!='ok' and r['status']!='fail': pass
            if r['variant']!=variant: continue
            try: text=gzip.open(f"packs/{variant}/{r['instance_id']}.txt.gz",'rt').read()
            except Exception: text=''
            m=metrics(r,parse(text, mode=='all'))
            if m: acc.append(m)
        n=len(acc); out[(variant,mode)]=(n,sum(a[0] for a in acc)/n,sum(a[1] for a in acc)/n,sum(a[2] for a in acc)/n)
for k,v in out.items(): print(k,'n=%d fileHit=%.3f fileRecall=%.3f lineRecall=%.3f'%v)

import random, math
per={}
for variant,mode in [('baseline','all'),('current','strict')]:
    d={}
    for r in rows:
        if r['variant']!=variant: continue
        try: text=gzip.open(f"packs/{variant}/{r['instance_id']}.txt.gz",'rt').read()
        except Exception: text=''
        m=metrics(r,parse(text, mode=='all'))
        if m: d[r['instance_id']]=m
    per[variant]=d
ids=sorted(set(per['baseline'])&set(per['current']))
random.seed(1729)
for idx,name in [(0,'fileHit'),(1,'fileRecall'),(2,'lineRecall')]:
    diffs=[float(per['current'][i][idx])-float(per['baseline'][i][idx]) for i in ids]
    boots=sorted(sum(random.choice(diffs) for _ in diffs)/len(diffs) for _ in range(10000))
    print(name,'diff=%.3f CI[%.3f,%.3f]'%(sum(diffs)/len(diffs),boots[250],boots[9749]))
b=sum(1 for i in ids if per['baseline'][i][0] and not per['current'][i][0]); c=sum(1 for i in ids if per['current'][i][0] and not per['baseline'][i][0])
n=b+c; p=min(1,2*sum(math.comb(n,k) for k in range(0,min(b,c)+1))/2**n) if n else 1
print('McNemar fileHit onlyBaseline=%d onlyCurrent=%d p=%.4f'%(b,c,p))
