"""Independent analysis of the completed matched R2 cohort, preserving the original runner ledger."""
import json,pathlib,statistics
ROOT=pathlib.Path(__file__).resolve().parent
outputs=[]
for path in ROOT.glob('fidy-r2-probe-*/inventory.json'):
 state=json.loads(path.read_text());rows=[r for r in state['samples']if r['round']is not None]
 if len(rows)!=186 or not state.get('cleaned')or any(r['status']!=200 for r in rows):raise RuntimeError('Incomplete matched R2 cohort or cleanup')
 summary=[]
 for variant in ['default','regional','smart']:
  selected=[r for r in rows if r['variant']==variant and r['round']>0]
  reads=[r for r in selected if r['path']=='/read'];health=[r for r in selected if r['path']=='/health']
  if len(reads)!=30 or len(health)!=30:raise RuntimeError('Unmatched variant')
  med=lambda xs:float(f'{statistics.median(xs):.3f}')
  summary.append({'variant':variant,'n':30,'healthMedianMs':med([r['elapsedMs']for r in health]),'readMedianMs':med([r['elapsedMs']for r in reads]),'readP95Ms':sorted(r['elapsedMs']for r in reads)[28],'authorityMedianMs':med([r['authorityMs']for r in reads]),'edges':sorted(set(r['edge']for r in reads)),'placementHeaders':sorted(set(str(r['placement'])for r in reads))})
 result={'scope':state['scope'],'prefix':state['prefix'],'matchedMeasuredReads':90,'matchedHealthRequests':90,'firstObservedPairs':3,'cleaned':state['cleaned'],'runnerStatus':state['status'],'runnerFailureType':state.get('failureType'),'note':'All 31 measurement rounds finished; post-measurement summary failed because loop variable round shadowed Python round(). Original inventory preserved; offline analysis independently validates complete cohort and cleanup. Smart Placement configured does not prove relocation occurred.','settings':state['settings'],'summary':summary}
 (path.parent/'analysis.json').write_text(json.dumps(result,indent=2)+'\n');outputs.append(result)
(ROOT/'r2-placement-results.json').write_text(json.dumps(outputs,indent=2)+'\n');print(json.dumps(outputs,indent=2))
