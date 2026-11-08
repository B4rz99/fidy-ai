"""Bounded error tail; persist only fixed event classes and numeric fields, never raw events."""
import json,os,pathlib,select,signal,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent;REPO=ROOT.parents[2]
settings=json.loads((ROOT/'runtime-settings.json').read_text())
if len(settings)!=1:raise RuntimeError('Ambiguous Core')
child=subprocess.Popen(['node',str(REPO/'node_modules/wrangler/bin/wrangler.js'),'tail',settings[0]['name'],'--format=json','--status=error'],cwd=REPO,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True,env={**os.environ,'WRANGLER_SEND_METRICS':'false','CI':'true'})
records=[];deadline=time.monotonic()+95;buffer='';decoder=json.JSONDecoder();overflow=False
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
   buffer=buffer[used:]
   event=frame.get('event')or{}
   kind='scheduled'if 'cron'in event or'scheduledTime'in event else'fetch'if'request'in event else'queue'if'queue'in event else'alarm'if'alarm'in event else'other'
   outcome=frame.get('outcome');outcome=outcome if outcome in ['ok','exception','exceededCpu','exceededMemory','canceled','unknown','scriptThrewException']else'other'
   row={'eventKind':kind,'outcome':outcome,'exceptionCount':len(frame.get('exceptions',[]))}
   for key in ['cpuTime','wallTime']:
    value=frame.get(key)
    if type(value)in[int,float]and 0<=value<=1000000000:row[key]=value
   records.append(row)
   print(json.dumps(row),flush=True)
finally:
 if child.poll()is None:
  os.killpg(child.pid,signal.SIGINT)
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
 state={'scope':'95-second live Core error-only tail; only fixed trigger classes, outcome enums and numeric counters retained; no payloads, headers, logs, exception messages or request coordinates retained','records':records,'overflow':overflow,'childExited':child.poll()is not None}
 (ROOT/'error-tail-results.json').write_text(json.dumps(state,indent=2)+'\n')
 print(json.dumps({'finished':True,'records':len(records),'childExited':state['childExited']}),flush=True)
