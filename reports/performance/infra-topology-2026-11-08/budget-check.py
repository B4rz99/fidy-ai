import json,pathlib,subprocess,sys,time,datetime
from preflight import api,ROOT,REPO
accounts=api('accounts')['result']
if len(accounts)!=1:raise RuntimeError('Ambiguous account')
usage=json.loads((ROOT/'preflight.json').read_text())
observed=datetime.datetime.fromisoformat(usage['observedAt'])
frame={'accountId':accounts[0]['id'],'observation':{'accountId':accounts[0]['id'],'utcDate':observed.strftime('%Y-%m-%d'),'observedAtEpochMs':int(observed.timestamp()*1000),**usage['usage']},'estimate':{'rowsRead':100000,'rowsWritten':5000}}
result=subprocess.run(['bun',str(REPO/'scripts/infra-performance/d1-budget.ts')],input=json.dumps(frame),capture_output=True,text=True,cwd=REPO)
(ROOT/'budget-decision.json').write_text(result.stdout)
print(result.stdout.strip())
