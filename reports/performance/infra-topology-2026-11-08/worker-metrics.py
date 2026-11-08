"""Read aggregate Worker metrics only, without invocation payloads or request coordinates."""
import datetime,json
from preflight import api,ROOT
accounts=api('accounts')['result']
if len(accounts)!=1:raise RuntimeError('Ambiguous account')
account=accounts[0]['id'];settings=json.loads((ROOT/'runtime-settings.json').read_text())
if len(settings)!=1:raise RuntimeError('Ambiguous Core')
now=datetime.datetime.now(datetime.timezone.utc);start=now-datetime.timedelta(minutes=30)
query='query($account: string!, $start: Time!, $end: Time!, $script: string!) { viewer { accounts(filter: {accountTag: $account}) { workersInvocationsAdaptive(limit:100, filter:{datetime_gt:$start,datetime_lt:$end,scriptName:$script}) { sum {requests errors subrequests} quantiles {cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99} dimensions {status} } } } }'
result=api('graphql',{'query':query,'variables':{'account':account,'start':start.isoformat().replace('+00:00','Z'),'end':now.isoformat().replace('+00:00','Z'),'script':settings[0]['name']}})
rows=result['data']['viewer']['accounts'][0]['workersInvocationsAdaptive']
state={'scope':'Aggregate Core invocations, not isolated ordinary reads; includes maintenance and other entrypoints. Metric units require schema verification before conversion.','start':start.isoformat(),'end':now.isoformat(),'rows':rows}
(ROOT/'worker-metrics.json').write_text(json.dumps(state,indent=2)+'\n');print(json.dumps(state))
