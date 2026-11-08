import json
from preflight import api,ROOT
accounts=api('accounts')['result']
if len(accounts)!=1:raise RuntimeError('Ambiguous account')
account=accounts[0]['id'];scripts=api('accounts/'+account+'/workers/scripts')['result'];observations=[]
for script in scripts:
 name=script['id']
 if 'core'not in name.lower()or not name.lower().startswith('fidy'):continue
 settings=api('accounts/'+account+'/workers/scripts/'+name+'/settings')['result']
 out={'name':name,'placement':settings.get('placement'),'limits':settings.get('limits'),'databases':[]}
 for binding in settings.get('bindings',[]):
  if binding.get('type')=='d1':
   database=api('accounts/'+account+'/d1/database/'+binding['id'])['result']
   out['databases'].append({k:database.get(k)for k in ['name','file_size','num_tables','read_replication','created_at']})
 observations.append(out)
(ROOT/'runtime-settings.json').write_text(json.dumps(observations,indent=2)+'\n');print(json.dumps(observations))
