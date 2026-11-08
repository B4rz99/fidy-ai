"""R2-only disposable placement experiment. No D1, application data or production bindings."""
import base64,datetime,hashlib,json,os,pathlib,secrets,select,signal,statistics,subprocess,time
from preflight import api,ROOT,REPO
prefix='fidy-r2-probe-'+secrets.token_hex(4);token=secrets.token_urlsafe(32)
out=ROOT/prefix;out.mkdir(mode=0o700)
state={'prefix':prefix,'scope':'Isolated fresh R2 generation lookup and health transport only; not application or verified cold-start evidence','resources':[],'cleanup':[],'samples':[],'status':'preflight','requestCeiling':240,'requests':0}
account=None;h2=None;origins={};secretfile=out/'secrets.json'
def save():(out/'inventory.json').write_text(json.dumps(state,indent=2)+'\n')
def cli(args,config=None,role='identity'):
 argv=['node',str(REPO/'node_modules/wrangler/bin/wrangler.js'),*args]+(['--config',str(config)]if config else [])
 child=subprocess.Popen(argv,cwd=REPO,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True,env={**os.environ,'CI':'true','WRANGLER_SEND_METRICS':'false'})
 try:stdout,stderr=child.communicate(timeout=120)
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.communicate(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.communicate()
  raise RuntimeError('Bounded CLI deadline')from None
 (out/(role+'.log')).write_text((stdout+stderr).replace(token,'<REDACTED>'))
 if child.returncode:raise RuntimeError('Wrangler '+role+' failed')
 return stdout

def request(variant,path,method='GET',round=None,negative=False):
 if state['requests']>=state['requestCeiling']:raise RuntimeError('Request ceiling exhausted')
 state['requests']+=1;save()
 h2.stdin.write(json.dumps({'origin':origins[variant],'method':method,'path':path,'headers':{'x-probe-token':'wrong'if negative else token}})+'\n');h2.stdin.flush()
 if not select.select([h2.stdout],[],[],35)[0]:raise RuntimeError('Request deadline; no retry')
 wire=json.loads(h2.stdout.readline())
 if wire.get('failed')or wire.get('protocol')!='h2':raise RuntimeError('Uncertain transport; no retry')
 expected=404 if negative else 204 if method!='GET'else 200
 row={'variant':variant,'path':path,'round':round,'status':wire['status'],'elapsedMs':wire['elapsedMs'],'reused':wire['reused'],'edge':str(wire['headers'].get('cf-ray','')).split('-')[-1],'placement':wire['headers'].get('cf-placement'),'authorityMs':float(wire['headers']['x-probe-authority-ms'])if'x-probe-authority-ms'in wire['headers']else None}
 state['samples'].append(row);save()
 if row['status']!=expected:raise RuntimeError('Unexpected probe response '+str(row['status']))
 body=base64.b64decode(wire['body'])
 if path=='/read'and not negative and json.loads(body)!={'generation':'initial'}:raise RuntimeError('Generation mismatch')
 return row
save()
try:
 proof=json.loads((ROOT/'r2-native-results.json').read_text())
 if not proof['passed']or proof['digest']!=hashlib.sha256((ROOT/'r2-worker.js').read_bytes()).hexdigest():raise RuntimeError('Native proof missing or stale')
 cli(['whoami']);accounts=api('accounts')['result']
 if len(accounts)!=1:raise RuntimeError('Ambiguous account')
 account=accounts[0]['id'];subdomain=api('accounts/'+account+'/workers/subdomain')['result']['subdomain']
 auth=(pathlib.Path.home()/'Library/Preferences/.wrangler/config/default.toml').read_text()
 import re
 expiry=re.search(r'^expiration_time\s*=\s*"([^\"]+)"',auth,re.M)
 if expiry and(datetime.datetime.fromisoformat(expiry.group(1).replace('Z','+00:00'))-datetime.datetime.now(datetime.timezone.utc)).total_seconds()<1200:raise RuntimeError('Existing authorization lifetime insufficient')
 bucket=prefix+'-fence';state['resources'].append({'kind':'r2','name':bucket});save()
 api('accounts/'+account+'/r2/buckets',{'name':bucket,'locationHint':'enam'})
 secretfile.write_text(json.dumps({'PROBE_TOKEN':token}));secretfile.chmod(0o600)
 for variant in ['default','regional','smart']:
  name=prefix+'-'+variant
  existing=api('accounts/'+account+'/workers/scripts/'+name+'/settings',optional=True)
  if existing.get('status')!=404:raise RuntimeError('Worker name not verified absent')
  config={'name':name,'account_id':account,'main':str(ROOT/'r2-worker.js'),'compatibility_date':'2026-09-08','workers_dev':True,'preview_urls':False,'vars':{'PROBE_EXPIRES':str(int(time.time()*1000)+7200000)},'r2_buckets':[{'binding':'FENCE','bucket_name':bucket}],'observability':{'enabled':False}}
  if variant=='regional':config['placement']={'region':'aws:us-east-1'}
  if variant=='smart':config['placement']={'mode':'smart'}
  cfg=out/(variant+'.json');cfg.write_text(json.dumps(config));state['resources'].append({'kind':'worker','name':name});save()
  cli(['deploy','--secrets-file',str(secretfile)],cfg,variant)
  settings=api('accounts/'+account+'/workers/scripts/'+name+'/settings')['result']
  bindings=settings.get('bindings',[])
  if any(b.get('type')in ['d1','durable_object_namespace','service']for b in bindings):raise RuntimeError('Unexpected binding')
  state.setdefault('settings',{})[variant]={'placement':settings.get('placement'),'types':sorted(b['type']for b in bindings)};save()
  origins[variant]='https://'+name+'.'+subdomain+'.workers.dev'
  print(json.dumps({'phase':'deployed','variant':variant}),flush=True)
 secretfile.unlink(missing_ok=True)
 h2=subprocess.Popen(['node',str(ROOT/'h2-client.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
 request('default','/health',negative=True);request('default','/seed','POST')
 state['status']='measuring';save()
 for round in range(31):
  order=['default','regional','smart']if round%2==0else['smart','regional','default']
  for variant in order:
   for path in(['/health','/read']if round%2==0else['/read','/health']):
    time.sleep(.08);request(variant,path,round=round)
  if round%10==0:print(json.dumps({'phase':'round','round':round}),flush=True)
 summary=[]
 for variant in ['default','regional','smart']:
  rows=[r for r in state['samples']if r['variant']==variant and r['round']is not None and r['round']>0]
  reads=[r for r in rows if r['path']=='/read'];health=[r for r in rows if r['path']=='/health']
  def med(xs):return float(f'{statistics.median(xs):.3f}')
  summary.append({'variant':variant,'n':len(reads),'healthMedianMs':med([r['elapsedMs']for r in health]),'readMedianMs':med([r['elapsedMs']for r in reads]),'readP95Ms':sorted(r['elapsedMs']for r in reads)[28],'authorityMedianMs':med([r['authorityMs']for r in reads]),'edges':sorted(set(r['edge']for r in reads)),'placementHeaders':sorted(set(str(r['placement'])for r in reads))})
 state['summary']=summary;state['status']='complete';save();print(json.dumps({'summary':summary}),flush=True)
except BaseException as error:
 state['status']='stopped';state['failureType']=type(error).__name__;state['reason']=str(error)if isinstance(error,RuntimeError)else'See private artifact';save();print(json.dumps({'phase':'stopped','reason':state['reason']}),flush=True)
finally:
 secretfile.unlink(missing_ok=True)
 if h2 and'default'in origins:
  try:request('default','/cleanup','DELETE');state['bytesDeleted']=True
  except BaseException:state['bytesDeleted']=False
 if h2:
  h2.stdin.close()
  try:h2.wait(timeout=5)
  except subprocess.TimeoutExpired:h2.terminate();h2.wait(timeout=5)
 for resource in reversed(state['resources']):
  try:
   if not resource['name'].startswith(prefix+'-'):raise RuntimeError('Ownership mismatch')
   if resource['kind']=='worker':path='accounts/'+account+'/workers/scripts/'+resource['name']
   else:
    if not state.get('bytesDeleted'):
     cfg=out/'default.json'
     cli(['r2','object','delete',resource['name']+'/recovery/generation','--remote'],cfg,'fallback-cleanup')
    path='accounts/'+account+'/r2/buckets/'+resource['name']
   response=api(path,method='DELETE',optional=True)
   if response.get('available')is False and response.get('status')!=404:raise RuntimeError('Deletion refused')
   state['cleanup'].append({'kind':resource['kind'],'deleted':True})
  except BaseException as error:state['cleanup'].append({'kind':resource['kind'],'deleted':False,'failureType':type(error).__name__})
  save()
 if account:
  try:
   workers=api('accounts/'+account+'/workers/scripts')['result'];buckets=api('accounts/'+account+'/r2/buckets')['result']
   if isinstance(buckets,dict):
    if buckets.get('truncated'):raise RuntimeError('Truncated bucket inventory')
    buckets=buckets['buckets']
   state['independentlyAbsent']=not any(prefix in r.get('id','')for r in workers)and not any(prefix in r.get('name','')for r in buckets)
  except BaseException:state['independentlyAbsent']=False
 state['cleaned']=len(state['cleanup'])==len(state['resources'])and all(r['deleted']for r in state['cleanup'])and state.get('independentlyAbsent',False)
 save();print(json.dumps({'phase':state['status'],'cleaned':state['cleaned'],'requests':state['requests']}),flush=True)
