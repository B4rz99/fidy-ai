"""Current-Core matched topology experiment; disposable resources and synthetic data only."""
import base64,datetime,hashlib,json,os,pathlib,secrets,select,signal,statistics,subprocess,sys,time
R=pathlib.Path(__file__).resolve().parent;REPO=R.parents[2]
sys.path.insert(0,str(R.parent/'infra-topology-2026-11-08'));from preflight import api
PREFIX='fidy-core-probe-'+secrets.token_hex(4);TOKEN=secrets.token_urlsafe(32);OUT=R/PREFIX;OUT.mkdir(mode=0o700)
USER='24000000-0000-4000-8000-000000000481';MODES=['d1','regional','registry'];ROUNDS=21
state={'prefix':PREFIX,'status':'preflight','resources':[],'cleanup':[],'samples':[],'spent':{'rowsRead':0,'rowsWritten':0},'ceiling':{'rowsRead':500000,'rowsWritten':23000},'source':json.loads((R/'manifest.json').read_text())['source'],'fixtureTransactions':20,'rounds':ROUNDS}
state['d1Spent']={'rowsRead':0,'rowsWritten':0};state['d1Ceiling']={'rowsRead':300000,'rowsWritten':11000}
account=None;h2=None;origins={};secret=OUT/'secret.json'
def save():(OUT/'inventory.json').write_text(json.dumps(state,indent=2)+'\n')
def stop(*_):raise KeyboardInterrupt()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
def cli(args,config=None,role='identity'):
 cmd=['node',str(REPO/'node_modules/wrangler/bin/wrangler.js'),*args]+(['--config',str(config)]if config else [])
 child=subprocess.Popen(cmd,cwd=REPO,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True,env={**os.environ,'CI':'true','WRANGLER_SEND_METRICS':'false'})
 try:stdout,stderr=child.communicate(timeout=120)
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.communicate(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.communicate()
  raise RuntimeError('Bounded CLI deadline')from None
 (OUT/(role+'.log')).write_text((stdout+stderr).replace(TOKEN,'<REDACTED>'))
 if child.returncode:raise RuntimeError('Wrangler '+role+' failed')
 return stdout

def request(mode,path,commands=None,method='GET',body=None,trial=None,operator=False,negative=False):
 cap={k:min(100000 if k=='rowsRead'else 5000,state['ceiling'][k]-state['spent'][k])for k in state['spent']}
 if min(cap.values())<0:raise RuntimeError('Experiment exhausted')
 storage='d1'if mode in ['smart','regional','gateway']else mode
 if mode in ['d1','smart','regional','gateway','replica','primary']:
  cap={k:min(cap[k],state['d1Ceiling'][k]-state['d1Spent'][k])for k in cap}
 headers={'x-fidy-bench':TOKEN,'x-probe-storage':storage,'x-probe-seed-user':USER,'x-probe-ceiling':json.dumps(cap),'origin':'https://app.fidyapp.com','cookie':'__Host-fidy_session='+((USER+'.')if mode in ['sqlite','registry']else'')+('z'*43 if negative else'a'*43),'fidy-session-binding':'30000000-0000-4000-8000-000000000001','x-oauth-source':'c'*64,'content-type':'application/json','cache-control':'no-store'}
 h2.stdin.write(json.dumps({'origin':origins[mode if mode in ['smart','regional','gateway']else'default'],'method':'POST'if commands is not None else method,'path':path,'body':json.dumps(commands)if commands is not None else body,'headers':headers})+'\n');h2.stdin.flush()
 if not select.select([h2.stdout],[],[],35)[0]:raise RuntimeError('Uncertain request deadline; no retry')
 wire=json.loads(h2.stdout.readline())
 if wire.get('failed')or wire.get('protocol')!='h2':raise RuntimeError('Uncertain transport; no retry')
 cost=json.loads(wire['headers'].get('x-bench-cost','null'));data=base64.b64decode(wire['body'])
 row={'variant':mode,'path':path,'trial':trial,'status':wire['status'],'elapsedMs':wire['elapsedMs'],'handlerMs':float(wire['headers'].get('x-bench-handler-ms','0')),'sqlDurationMs':float(wire['headers'].get('x-probe-sql-ms','0')),'sqlStatements':int(wire['headers'].get('x-probe-sql-statements','0')),'reused':wire['reused'],'cost':cost,'timings':wire['headers'].get('server-timing'),'placement':wire['headers'].get('cf-placement'),'locations':json.loads(wire['headers'].get('x-probe-locations','[]')),'edge':str(wire['headers'].get('cf-ray','')).split('-')[-1]};state['samples'].append(row)
 if not operator:
  if not cost or any(type(cost.get(k))is not int or cost[k]<0 for k in cap):save();raise RuntimeError('Unaccounted request; no retry')
  for k in cap:
   state['spent'][k]+=cost[k]
   if mode in ['d1','smart','regional','gateway','replica','primary']:state['d1Spent'][k]+=cost[k]
  save()
  if cost.get('failed')or cost.get('unaccounted')or any(cost[k]>cap[k]for k in cap):raise RuntimeError('Native execution accounting refused; no retry')
 expected=204 if operator else 401 if negative else 200
 if wire['status']!=expected:save();raise RuntimeError('Unexpected response '+str(wire['status'])+' '+path)
 return row,data
save()
try:
 proof=json.loads((R/'native-samples.json').read_text())
 if len(proof['samples'])!=204 or not proof.get('completeResponseParity')or'completeResponses'not in(R/'native-topologies-enforced.log').read_text():raise RuntimeError('Current native parity incomplete')
 placement_proof=json.loads((R/'placement-native-samples.json').read_text())
 if len(placement_proof['samples'])!=255 or not placement_proof.get('completeResponseParity'):raise RuntimeError('Placement native parity incomplete')
 files=[R/'worker-placement.js',R/'core/probe-worker.js',R/'core/guard.js',R/'core/cost-plan.js',*[pathlib.Path(p)for p in json.loads((R/'files.json').read_text())]]
 state['digests']={str(f):hashlib.sha256(f.read_bytes()).hexdigest()for f in files};save()
 cli(['whoami']);accounts=api('accounts')['result']
 if len(accounts)!=1:raise RuntimeError('Ambiguous account')
 account=accounts[0]['id'];today=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
 query='query($account: string!, $date: Date!) { viewer { accounts(filter:{accountTag:$account}) { d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$date,date_leq:$date}) {sum {rowsRead rowsWritten}} } } }'
 rows=api('graphql',{'query':query,'variables':{'account':account,'date':today}})['data']['viewer']['accounts'][0]['d1AnalyticsAdaptiveGroups']
 if len(rows)>=10000:raise RuntimeError('Truncated usage')
 observation={'accountId':account,'utcDate':today,'observedAtEpochMs':int(time.time()*1000),**{k:sum(r['sum'][k]for r in rows)for k in state['spent']}}
 budget=subprocess.run(['bun',str(REPO/'scripts/infra-performance/d1-budget.ts')],input=json.dumps({'accountId':account,'observation':observation,'estimate':state['d1Ceiling']}),text=True,capture_output=True,cwd=REPO)
 state['budget']={'decision':json.loads(budget.stdout),'usage':{k:observation[k]for k in state['spent']}};save()
 if budget.returncode:raise RuntimeError('Actual platform allowance unavailable')
 subdomain=api('accounts/'+account+'/workers/subdomain')['result']['subdomain']
 name=PREFIX+'-db';state['resources'].append({'kind':'d1','name':name});save();db=api('accounts/'+account+'/d1/database',{'name':name,'primary_location_hint':'enam','read_replication':{'mode':'auto'}})['result'];dbid=db.get('uuid')or db.get('id');state['resources'][-1]['id']=dbid;save()
 if not dbid:raise RuntimeError('Missing database ID')
 dbsettings=api('accounts/'+account+'/d1/database/'+dbid)['result'];state['databaseReplication']=dbsettings.get('read_replication');save()
 if state['databaseReplication']!={'mode':'auto'}:raise RuntimeError('Replication not enabled')
 bucket=PREFIX+'-fence';state['resources'].append({'kind':'r2','name':bucket});save();api('accounts/'+account+'/r2/buckets',{'name':bucket,'locationHint':'enam'})
 vars=json.loads(((R/'fixture-vars.json')).read_text())
 for key,value in vars.items():
  if('KEY'in key or'SECRET'in key)and value and not any(word in value.lower()for word in ['fixture','test','dummy','local','synthetic']):raise RuntimeError('Non-fixture provider credential refused')
 vars.update({'BENCH_LOCAL_CALIBRATION':'false','BENCH_USERS':USER,'ERASURE_REQUIRED':'true','HOSTED_AI_MODEL':'gpt-6-luna','PROBE_EXPIRES':str(int(time.time()*1000)+7200000)})
 classes={'LOCAL_USER':'LocalUser','REGISTRY_USER':'RegistryUser','RECOVERY_AUTHORITY':'RecoveryAuthority','USER_TRANSACTION_COORDINATOR':'UserTransactionCoordinator'}
 secret.write_text(json.dumps({'BENCH_TOKEN':TOKEN}));secret.chmod(0o600)
 for variant in ['default','regional','gateway']:
  name=PREFIX+'-'+variant;bindings=[{'name':k,'class_name':v,**({'script_name':PREFIX+'-default'}if variant=='regional'else{})}for k,v in classes.items()]
  config={'name':name,'account_id':account,'main':str(R/'worker-placement.js'),'compatibility_date':'2026-09-08','compatibility_flags':['nodejs_compat'],'workers_dev':True,'preview_urls':False,'vars':vars,'d1_databases':[{'binding':'DB','database_name':PREFIX+'-db','database_id':dbid}],'r2_buckets':[{'binding':'ERASURE_BUCKET','bucket_name':bucket}],'durable_objects':{'bindings':bindings},'observability':{'enabled':False}}
  if variant=='default':config['exports']={v:{'type':'durable-object','storage':'sqlite'}for v in classes.values()}
  elif variant=='regional':config['placement']={'region':'aws:us-east-1'}
  else:
   config={k:v for k,v in config.items()if k not in ['d1_databases','r2_buckets','durable_objects']}
   config['main']=str(R/'gateway-worker.js');config['services']=[{'binding':'CORE','service':PREFIX+'-default'}]
  cfg=OUT/(variant+'.json');cfg.write_text(json.dumps(config))
  if api('accounts/'+account+'/workers/scripts/'+name+'/settings',optional=True).get('status')!=404:raise RuntimeError('Worker name not absent')
  state['resources'].append({'kind':'worker','name':name});save();cli(['deploy','--secrets-file',str(secret)],cfg,variant)
  origins[variant]='https://'+name+'.'+subdomain+'.workers.dev';print(json.dumps({'phase':'deployed','variant':variant}),flush=True)
 secret.unlink(missing_ok=True)
 h2=subprocess.Popen(['node',str(R.parent/'infra-topology-2026-11-08/h2-client.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
 request('d1','/__probe/health');request('regional','/__probe/health')
 snapshot=json.loads((R/'schema-snapshot.json').read_text())['commands'];fixture=json.loads((R/'seed.json').read_text());delta=int(time.time()*1000)-fixture['now'];commands=fixture['seed'][0]['commands']
 for c in commands:
  c['params']=[v+delta if type(v)is int and v>1000000000000 else v for v in c['params']]
 for mode in ['d1','sqlite','registry']:
  for i in range(0,len(snapshot),30):request(mode,'/__probe/sql',commands=snapshot[i:i+30])
 for mode in ['d1','sqlite','registry']:request(mode,'/__probe/sql',commands=commands)
 request('d1','/__probe/recovery',method='PUT',body='initial',operator=True)
 routes=['/web/session/binding','/web/session/binding?context=application','/web/session/binding?context=transactions','/user','/categories','/transactions','/budget-status?timeZone=America%2FBogota','/recurring-plans?month=2026-11&view=compact','/dashboard/view','/dashboard/catalog','/ingestion/review-workspace','/pats','/subscription/status','/subscription/offers','/web/consent','/web/oauth/connections','/web/subscription/payment-enrollments/availability']
 state['status']='measuring';save()
 last_renewal=time.monotonic()
 state['fixtureRenewals']=[]
 for trial in range(ROUNDS):
  if time.monotonic()-last_renewal>240:
   now=int(time.time()*1000)
   renewal={'sql':'UPDATE web_sessions SET created_at_ms=?,fresh_until_ms=?,idle_expires_at_ms=?,hard_expires_at_ms=? WHERE id=?','params':[now,now+600000,now+3600000,now+7776000000,'30000000-0000-4000-8000-000000000001']}
   for mode in ['d1','sqlite','registry']:request(mode,'/__probe/sql',commands=[renewal])
   state['fixtureRenewals'].append({'beforeTrial':trial,'outsideMeasuredRequests':True,'syntheticAuthorityOnly':True});last_renewal=time.monotonic();save()
  order=MODES if trial%2==0 else list(reversed(MODES));offset=trial*5%len(routes);paths=routes[offset:]+routes[:offset]
  if trial%2:paths.reverse()
  for path in paths:
   for mode in order:
    time.sleep(.03);row,data=request(mode,path,trial=trial);value=json.loads(data)
    if path=='/dashboard/view':value['data']['context']['calculatedAt']='<request-time>'
    row['comparisonHash']=hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest();save()
  print(json.dumps({'phase':'round','trial':trial,'spent':state['spent']}),flush=True)
 for path in routes:
  if len({r['comparisonHash']for r in state['samples']if r['path']==path and r.get('comparisonHash')})!=1:raise RuntimeError('Complete response mismatch')
 state['sessionReadParity']=True
 for i in range(31):
  for path in ['/web/session/binding','/web/subscription/payment-enrollments/availability']:
   hashes=[]
   for mode in (['d1','primary','replica']if i%2==0 else ['replica','primary','d1']):
    row,data=request(mode,path);row['sessionTrial']=i;hashes.append(hashlib.sha256(data).hexdigest());save()
   if len(set(hashes))!=1:state['sessionReadParity']=False;raise RuntimeError('Session response mismatch')
 state['bindingParity']=True
 for i in range(31):
  hashes=[]
  for mode in (['d1','gateway']if i%2==0 else ['gateway','d1']):
   row,data=request(mode,'/categories');row['bindingTrial']=i;hashes.append(hashlib.sha256(data).hexdigest());save()
  if len(set(hashes))!=1:state['bindingParity']=False;raise RuntimeError('Binding response mismatch')
 for mode in MODES:request(mode,'/categories',negative=True)
 state['status']='complete';save()
except BaseException as error:
 state['status']='stopped';state['failureType']=type(error).__name__;state['reason']=str(error)if isinstance(error,RuntimeError)else'See private artifact';save();print(json.dumps({'phase':'stopped','reason':state['reason']}),flush=True)
finally:
 secret.unlink(missing_ok=True)
 try:cli(['whoami'],role='cleanup-identity')
 except BaseException:pass
 if h2:
  try:request('d1','/__probe/cleanup',method='DELETE',operator=True);state['contentsDeleted']=True
  except BaseException:state['contentsDeleted']=False
  h2.stdin.close()
  try:h2.wait(timeout=5)
  except subprocess.TimeoutExpired:h2.terminate();h2.wait(timeout=5)
 for resource in reversed(state['resources']):
  try:
   if not resource['name'].startswith(PREFIX+'-'):raise RuntimeError('Ownership mismatch')
   if resource['kind']=='worker':path='accounts/'+account+'/workers/scripts/'+resource['name']
   elif resource['kind']=='r2':
    if not state.get('contentsDeleted'):cli(['r2','object','delete',resource['name']+'/recovery/generation','--remote'],OUT/'default.json','fallback-fence-delete')
    path='accounts/'+account+'/r2/buckets/'+resource['name']
   else:path='accounts/'+account+'/d1/database/'+resource['id']
   response=api(path,method='DELETE',optional=True)
   if response.get('available')is False and response.get('status')!=404:raise RuntimeError('Deletion refused')
   state['cleanup'].append({'kind':resource['kind'],'deleted':True})
  except BaseException as error:state['cleanup'].append({'kind':resource['kind'],'deleted':False,'failureType':type(error).__name__})
  save()
 state['absence']=[]
 if account:
  for kind,path in [('worker','workers/scripts'),('d1','d1/database?per_page=100'),('r2','r2/buckets'),('namespace','workers/durable_objects/namespaces')]:
   try:
    result=api('accounts/'+account+'/'+path);items=result['result']
    if isinstance(items,dict):
     if items.get('truncated'):raise RuntimeError('Truncated inventory')
     items=items['buckets']
    if result.get('result_info',{}).get('total_pages',1)>1:raise RuntimeError('Paginated inventory')
    state['absence'].append({'kind':kind,'absent':not any(PREFIX in json.dumps(item)for item in items)})
   except BaseException:state['absence'].append({'kind':kind,'absent':False})
 state['cleaned']=len(state['cleanup'])==len(state['resources'])and all(r['deleted']for r in state['cleanup'])and len(state['absence'])==4 and all(r['absent']for r in state['absence']);save();print(json.dumps({'phase':state['status'],'cleaned':state['cleaned'],'spent':state['spent']}),flush=True)
