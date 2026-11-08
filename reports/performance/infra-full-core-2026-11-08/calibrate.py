"""Local learned SQL upper bounds. Enforced replay must succeed before deployment."""
import json,math,pathlib
R=pathlib.Path(__file__).resolve().parent
learned=json.loads((R/'calibrated-plan.json').read_text())
extra=R/'colocated-calibrated-plan.json'
if extra.exists():
 for sql,v in json.loads(extra.read_text()).items():learned[sql]={k:max(learned.get(sql,{}).get(k,0),v[k])for k in ['rowsRead','rowsWritten']}
plan={sql:{k:math.ceil(v[k]*1.5)+4 for k in ['rowsRead','rowsWritten']}for sql,v in learned.items()}
(R/'core/cost-plan.js').write_text('export default '+json.dumps(plan)+';\n')
print(json.dumps({'statements':len(plan),'nativeReplayRequired':True}))
