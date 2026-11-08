"""Read-only discovery. No credential or account identifier output."""
import datetime,json,pathlib,re,urllib.request,urllib.error,time
ROOT=pathlib.Path(__file__).resolve().parent
REPO=ROOT.parents[2]
def api(path,body=None,method=None,optional=False):
 config=pathlib.Path.home()/'Library/Preferences/.wrangler/config/default.toml'
 match=re.search(r'^oauth_token\s*=\s*"([^\"]+)"',config.read_text(),re.M)
 if not match: raise RuntimeError('Existing Wrangler authorization unavailable')
 request=urllib.request.Request('https://api.cloudflare.com/client/v4/'+path,headers={'Authorization':'Bearer '+match.group(1),'Content-Type':'application/json'},data=json.dumps(body).encode()if body is not None else None,method=method)
 try:
  with urllib.request.urlopen(request,timeout=25)as response: result=json.load(response)
 except urllib.error.HTTPError as error:
  if optional:return {'available':False,'status':error.code}
  raise RuntimeError('Cloudflare API HTTP '+str(error.code))from None
 if result.get('success')is False or result.get('errors'):raise RuntimeError('Cloudflare API refused request')
 return result
if __name__=='__main__':
 accounts=api('accounts')['result']
 if len(accounts)!=1:raise RuntimeError('Ambiguous Cloudflare account')
 account=accounts[0]['id'];today=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
 query='query($accountTag: string!, $start: Date!, $end: Date!) { viewer { accounts(filter: {accountTag: $accountTag}) { d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $start, date_leq: $end}) { sum { rowsRead rowsWritten } dimensions { date } } } } }'
 result=api('graphql',{'query':query,'variables':{'accountTag':account,'start':today,'end':today}})
 groups=result['data']['viewer']['accounts'][0]['d1AnalyticsAdaptiveGroups']
 if len(groups)>=10000:raise RuntimeError('Truncated analytics')
 subscriptions=api('accounts/'+account+'/subscriptions',optional=True)
 state={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'usage':{k:sum(r['sum'][k]for r in groups)for k in ['rowsRead','rowsWritten']},'subscriptionsReadable':'result'in subscriptions,'plans':[{'name':v.get('rate_plan',{}).get('public_name'),'id':v.get('rate_plan',{}).get('id'),'state':v.get('state')}for v in subscriptions.get('result',[])]}
 (ROOT/'preflight.json').write_text(json.dumps(state,indent=2)+'\n');print(json.dumps(state))
