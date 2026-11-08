"""Offline analysis only; includes incomplete ledgers without promoting them to completed cohorts."""
import collections,json,math,pathlib,statistics,re
R=pathlib.Path(__file__).resolve().parent
results=[]
for file in sorted(R.glob('fidy-core-probe-*/inventory.json')):
 s=json.loads(file.read_text());samples=[r for r in s['samples']if r.get('trial')is not None and r.get('comparisonHash')];groups=collections.defaultdict(list)
 variants=set(r['variant']for r in samples);paths=set(r['path']for r in samples)
 completeTrials=[trial for trial in sorted(set(r['trial']for r in samples))if len({(r['path'],r['variant'])for r in samples if r['trial']==trial})==len(variants)*len(paths)]
 for r in samples:
  for key,metric in [('canonicalMs','canonical-total'),('providerSqlMs','recovery-sql')]:
   m=re.search(re.escape(metric)+r';dur=([0-9.]+)',r.get('timings')or'');r[key]=float(m.group(1))if m else 0
  if r['trial']>0 and r['trial']in completeTrials:groups[(r['path'],r['variant'])].append(r)
 rows=[]
 for (path,variant),group in sorted(groups.items()):
  row={'path':path,'variant':variant,'n':len(group),'all200':all(r['status']==200 for r in group),'edge':sorted(set(r['edge']for r in group)),'placements':sorted(set(str(r['placement'])for r in group))}
  for key in ['elapsedMs','handlerMs','canonicalMs','providerSqlMs','storageWaitMs','recoveryWaitMs','coordinatorWaitMs']:
   values=sorted(r.get(key,r['cost'].get(key,0))for r in group);row[key]={'median':round(statistics.median(values),2),'empiricalP95':round(values[math.ceil(.95*len(values))-1],2)}
  row['dbLocations']=list({json.dumps(v,sort_keys=True):v for r in group for v in r.get('locations',[])}.values());rows.append(row)
 parity={path:len(set(r['comparisonHash']for r in samples if r['path']==path))==1 for path in set(r['path']for r in samples)}
 result={'prefix':s['prefix'],'status':s['status'],'cleaned':s.get('cleaned',False),'reason':s.get('reason'),'source':s['source'],'completeResponseParity':bool(parity)and all(parity.values()),'completeTrials':completeTrials,'unpairedSuccessfulSamples':sum(r['trial']not in completeTrials for r in samples),'sampleCountIncludingFirst':len(samples),'fixtureTransactions':s['fixtureTransactions'],'fixtureRenewals':s.get('fixtureRenewals',[]),'rows':rows}
 binding=[r for r in s['samples']if r.get('bindingTrial',0)>0]
 result['binding']={variant:{'n':len([r for r in binding if r['variant']==variant]),'medianMs':round(statistics.median(r['elapsedMs']for r in binding if r['variant']==variant),2)}for variant in set(r['variant']for r in binding)}
 results.append(result)
(R/'hosted-analysis.json').write_text(json.dumps(results,indent=2)+'\n')
for s in results:print(json.dumps({k:s[k]for k in ['prefix','status','cleaned','completeResponseParity','sampleCountIncludingFirst']}))
