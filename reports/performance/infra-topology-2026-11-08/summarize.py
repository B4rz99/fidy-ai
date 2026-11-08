"""Project bounded measurement metadata; never copy response bodies or credentials."""
import base64,json,pathlib,statistics
ROOT=pathlib.Path(__file__).resolve().parent

def samples(filename):
 data=json.loads((ROOT/filename).read_text());out=[]
 def visit(value):
  if isinstance(value,dict):
   for attachment in value.get('attachments',[]):
    if attachment.get('name')=='assessment-samples':
     frame=json.loads(base64.b64decode(attachment['body']))
     out.extend(frame['samples'])
   for nested in value.values():visit(nested)
  elif isinstance(value,list):
   for nested in value:visit(nested)
 visit(data);return out

def browser_summary(filename):
 rows=samples(filename);out=[]
 for journey in dict.fromkeys(r['journey']for r in rows):
  group=[r for r in rows if r['journey']==journey]
  out.append({'journey':journey,'n':len(group),'samplesMs':[round(r['elapsedMs'],2)for r in group],'medianMs':round(statistics.median(r['elapsedMs']for r in group),2),'outcomes':[r['outcome']for r in group],'requests':[{'path':q['path'],'durationMs':round(q['durationMs'],2),'startOffsetMs':round(q['startOffsetMs'],2),'serverTimings':q['serverTimings'],'recoveryBatches':q['recoveryBatches']}for q in group[0]['requests']]})
 return out

state={'applicationSource':'e76d83bd8','limits':['Small local application fixture, three observations per read; no reliable production p95 or full workload-envelope result.','Existing fresh-read harness measures body completion and ready controls. Dashboard uses a visibility-triggered refresh, not a navigation click. No all-nine-view navigation acceptance claim.','All synthetic topology results are local workerd with 1000 fixture rows, not deployed architecture speedups.','Burst test has 20 concurrent calls, not the agreed 20 Users averaging one request/second.','Public HTTP/2 probes reached BOG, but trace reports country US. This does not validate a representative Colombian end-user connection.','D1 hosted benchmark refused production_reserve; no hosted resources provisioned or production configuration changed.'],'browserNormal':browser_summary('browser-normal-baseline.json'),'browserPoor':browser_summary('browser-poor-baseline.json')}
for name,key in [('native-results.json','native'),('conventional-results.json','conventional'),('transport-results.json','transport')]:
 value=json.loads((ROOT/name).read_text());state[key]={k:v for k,v in value.items()if k in ['scope','checks','passed','summary','contentionSummary','origin']}
for name,key in [('browser-startup-normal.json','startupNormal'),('browser-startup-poor.json','startupPoor')]:
 if(ROOT/name).exists():state[key]=browser_summary(name)
(ROOT/'summary.json').write_text(json.dumps(state,indent=2)+'\n')
print(json.dumps({k:v for k,v in state.items()if k in ['browserNormal','browserPoor']},indent=2)[:0])
print('Fresh-read medians (local):')
for normal,poor in zip(state['browserNormal'],state['browserPoor']):print(normal['journey'].split(':')[0],normal['medianMs'],poor['medianMs'])
print('Native prototype passed:',state['native']['passed'])
