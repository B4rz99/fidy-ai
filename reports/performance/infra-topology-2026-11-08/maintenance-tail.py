"""Bounded all-status tail retaining only declared Work metadata and numeric counters."""
import json,os,pathlib,re,select,signal,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent;REPO=ROOT.parents[2]
settings=json.loads((ROOT/'runtime-settings.json').read_text())
if len(settings)!=1:raise RuntimeError('Ambiguous Core')
allowed=set(re.findall(r'^\s+"([a-zA-Z0-9_.-]+)",?$',(REPO/'apps/server/src/shell/observability/contract.ts').read_text(),re.M))
allowed.update(re.findall(r'^\s+\|\s+"([a-zA-Z0-9_.-]+)"', (REPO/'apps/server/cloudflare/maintenance/contract.ts').read_text(),re.M))
child=subprocess.Popen(['node',str(REPO/'node_modules/wrangler/bin/wrangler.js'),'tail',settings[0]['name'],'--format=json'],cwd=REPO,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True,env={**os.environ,'WRANGLER_SEND_METRICS':'false','CI':'true'})
records=[];deadline=time.monotonic()+95;buffer='';decoder=json.JSONDecoder();overflow=False

def work_metadata(value,depth=0):
 if depth>8:return []
 found=[]
 if isinstance(value,dict):
  if value.get('operation')in allowed and value.get('outcome')in ['succeeded','rejected','failed','interrupted']:
   row={'operation':value['operation'],'outcome':value['outcome']}
   for key in ['durationMs','elapsedMs']:
    v=value.get(key)
    if type(v)in[int,float]and 0<=v<=1000000000:row[key]=v
   found.append(row)
  for k in ['message','operation','logs','data']:
   if k in value:found+=work_metadata(value[k],depth+1)
 elif isinstance(value,list):
  for v in value[:100]:found+=work_metadata(v,depth+1)
 elif isinstance(value,str)and len(value)<=50000:
  op=re.search(r'[\"\']?operation[\"\']?\s*:\s*[\"\']([a-zA-Z0-9_.-]{1,100})[\"\']',value)
  outcome=re.search(r'[\"\']?outcome[\"\']?\s*:\s*[\"\'](succeeded|rejected|failed|interrupted)[\"\']',value)
  if op and outcome and op.group(1)in allowed:found.append({'operation':op.group(1),'outcome':outcome.group(1)})
  for match in re.finditer(r'fidy\.work operation=([a-zA-Z0-9_.-]{1,100}) outcome=(succeeded|rejected|failed|interrupted)',value):
   if match.group(1)in allowed:found.append({'operation':match.group(1),'outcome':match.group(2)})
 return found
try:
 while time.monotonic()<deadline and len(records)<100:
  if not select.select([child.stdout],[],[],min(1,max(0,deadline-time.monotonic())))[0]:continue
  chunk=os.read(child.stdout.fileno(),65536)
  if not chunk:break
  buffer+=chunk.decode('utf8',errors='replace')
  if len(buffer)>1048576:overflow=True;break
  while True:
   start=buffer.find('{')
   if start<0:buffer='';break
   buffer=buffer[start:]
   try:frame,used=decoder.raw_decode(buffer)
   except json.JSONDecodeError:break
   buffer=buffer[used:];event=frame.get('event')or{}
   kind='scheduled'if'cron'in event or'scheduledTime'in event else'fetch'if'request'in event else'queue'if'queue'in event else'alarm'if'alarm'in event else'other'
   outcome=frame.get('outcome');outcome=outcome if outcome in ['ok','exception','exceededCpu','exceededMemory','canceled','unknown']else'other'
   row={'eventKind':kind,'outcome':outcome,'exceptionCount':len(frame.get('exceptions',[])),'work':work_metadata(frame.get('logs',[]))}
   for key in ['cpuTime','wallTime']:
    v=frame.get(key)
    if type(v)in[int,float]and 0<=v<=1000000000:row[key]=v
   records.append(row);print(json.dumps(row),flush=True)
finally:
 if child.poll()is None:
  os.killpg(child.pid,signal.SIGINT)
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
 (ROOT/'maintenance-tail-results.json').write_text(json.dumps({'scope':'95-second all-status tail, only declared Work operation/outcome and numeric fields retained; no payloads, headers, raw messages, exception text or request coordinates','records':records,'overflow':overflow,'childExited':child.poll()is not None},indent=2)+'\n')
 print(json.dumps({'finished':True,'records':len(records),'childExited':child.poll()is not None}),flush=True)
