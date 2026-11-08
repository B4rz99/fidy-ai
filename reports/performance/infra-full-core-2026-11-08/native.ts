// Native feasibility only. No Cloudflare API, remote bindings, deployment, or production data.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Effect, Schema } from 'effect';
import { installTestSchema } from '../../../apps/server/cloudflare/d1-test-fixture';
import { currentDisclosureFor } from '../../../apps/server/src/shell/consent/operations';
import { DisclosureSnapshot } from '../../../apps/server/src/shell/consent/contract';
import { makeDefaultDashboard } from '../../../apps/server/src/core/dashboard/operations';
import { DashboardDocument, WidgetId } from '../../../apps/server/src/core/dashboard/contract';
import { categoryIds } from '../../../apps/server/src/core/categories/contract';
const root=new URL('./',import.meta.url).pathname,dir=root+'core';
const users=['24000000-0000-4000-8000-000000000481','24000000-0000-4000-8000-000000000482'];
const session=index=>'30000000-0000-4000-8000-00000000000'+(index+1);
const token=index=>(index?'b':'a').repeat(43),gate='local-only-feasibility';
const vars=await Bun.file(root+'fixture-vars.json').json();
Object.assign(vars,{HOSTED_AI_MODEL:'gpt-6-luna',ERASURE_REQUIRED:'true',BENCH_LOCAL_CALIBRATION:process.env.BENCH_ENFORCED==='1'?'false':'true',BENCH_TOKEN:gate,PROBE_EXPIRES:String(Date.now()+7200000),BENCH_USERS:users.join(',')});
const files:string[]=await Bun.file(root+'files.json').json();
const modules=[{type:'ESModule' as const,path:root+'worker.js',contents:await Bun.file(root+'worker.js').text()},{type:'ESModule' as const,path:dir+'/probe-worker.js',contents:await Bun.file(dir+'/probe-worker.js').text()},...await Promise.all(['guard.js','cost-plan.js'].map(async name=>({type:'ESModule' as const,path:dir+'/'+name,contents:await Bun.file(dir+'/'+name).text()}))),...await Promise.all(files.filter(p=>p.endsWith('.js')).map(async path=>({type:'ESModule' as const,path,contents:await Bun.file(path).text()})))];
const mf=new Miniflare(convertV4MiniflareOptions({name:'infra-full-core-prototype',modulesRoot:root,modules,compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],bindings:vars,d1Databases:['DB','SETUP_DB'],r2Buckets:['ERASURE_BUCKET'],durableObjects:{REGISTRY_USER:{className:'RegistryUser',useSQLite:true},RECOVERY_AUTHORITY:{className:'RecoveryAuthority',useSQLite:true},LOCAL_USER:{className:'LocalUser',useSQLite:true},USER_TRANSACTION_COORDINATOR:{className:'UserTransactionCoordinator',useSQLite:true}},handleStructuredLogs:entry=>{if(entry.level==='error')console.error(JSON.stringify({localError:true}));}}));
const checks:any[]=[],samples:any[]=[];
const quoted=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const commands=async(user:string,queries:any[],variant='sqlite')=>{
 const response=await mf.dispatchFetch('https://probe.invalid/__probe/sql',{method:'POST',headers:{'x-fidy-bench':gate,'x-probe-ceiling':JSON.stringify({rowsRead:100000,rowsWritten:5000}),'x-probe-seed-user':user,'x-probe-storage':variant},body:JSON.stringify(queries)});
 if(!response.ok)throw Error('Local fixture SQL failed');return response.json();
};
const headers=(variant:string,index=0)=>({'x-fidy-bench':gate,'x-probe-ceiling':JSON.stringify({rowsRead:100000,rowsWritten:5000}),'x-probe-storage':variant,Cookie:'__Host-fidy_session='+(['sqlite','registry'].includes(variant)?users[index]+'.':'')+token(index),'Fidy-Session-Binding':session(index),Origin:'https://app.fidyapp.com','x-oauth-source':'c'.repeat(64)});
const read=async(variant:string,path:string,index=0,extra={})=>mf.dispatchFetch('https://api.fidyapp.com'+path,{headers:{...headers(variant,index),...extra}});
const scalar=async(user:string,sql:string)=>Number((await commands(user,[{sql,params:[]}]))[0].results[0].total);
const fault=async(user:string,remaining:number,queries:any[],variant='sqlite')=>{
 const response=await mf.dispatchFetch('https://probe.invalid/__probe/fault',{method:'POST',headers:{'x-fidy-bench':gate,'x-probe-ceiling':JSON.stringify({rowsRead:100000,rowsWritten:5000}),'x-probe-seed-user':user},body:JSON.stringify({remaining,commands:queries})});
 if(response.status!==204)throw Error('Race injection unavailable');
};
const routes=['/web/session/binding','/web/session/binding?context=application','/web/session/binding?context=transactions','/user','/categories','/transactions','/budget-status?timeZone=America%2FBogota','/recurring-plans?month=2026-11&view=compact','/dashboard/view','/dashboard/catalog','/ingestion/review-workspace','/pats','/subscription/status','/subscription/offers','/web/consent','/web/oauth/connections','/web/subscription/payment-enrollments/availability'];
try {
 const db=await mf.getD1Database('DB');await installTestSchema({db});
 // A fresh final-schema snapshot avoids replaying ALTER migrations in a future disposable
 // hosted fixture. Schema source remains current migrations; no application schema changes.
 const catalogue=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'").all()).results as any[];
 const order={table:0,view:1,index:2,trigger:3};catalogue.sort((a,b)=>order[a.type]-order[b.type]||a.name.localeCompare(b.name));
 const bootstrap:any[]=[];
 for(const table of catalogue.filter(row=>row.type==='table')){
  const columns=(await db.prepare('PRAGMA table_xinfo('+quoted(table.name)+')').all()).results.filter((column:any)=>column.hidden===0).map((column:any)=>column.name);
  const rows=(await db.prepare('SELECT '+columns.map(quoted).join(',')+' FROM '+quoted(table.name)).all()).results;
  for(const row of rows)bootstrap.push({sql:'INSERT INTO '+quoted(table.name)+'('+columns.map(quoted).join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')',params:columns.map(column=>row[column] instanceof Uint8Array?Array.from(row[column]):row[column])});
 }
 const beforeTriggers=catalogue.filter(row=>row.type!=='trigger').map(row=>({sql:row.sql,params:[]}));
 const triggers=catalogue.filter(row=>row.type==='trigger').map(row=>({sql:row.sql,params:[]}));
 const snapshot=[...beforeTriggers,...bootstrap,...triggers];
 await Bun.write(root+'schema-snapshot.json',JSON.stringify({source:'current installed migrations; no retained User rows',objects:catalogue.length,commands:snapshot},null,2));
 const setupCosts=[];
 for(let i=0;i<snapshot.length;i+=30){
  const response=await mf.dispatchFetch('https://probe.invalid/__probe/sql',{method:'POST',headers:{'x-fidy-bench':gate,'x-probe-storage':'d1-setup','x-probe-ceiling':JSON.stringify({rowsRead:100000,rowsWritten:5000})},body:JSON.stringify(snapshot.slice(i,i+30))});
  if(!response.ok)throw Error('D1 snapshot calibration failed at '+i+': '+await response.text());
  await response.arrayBuffer();setupCosts.push(JSON.parse(response.headers.get('x-bench-cost')!));
 }
 await Bun.write(root+'setup-calibration.json',JSON.stringify(setupCosts,null,2));
 for(const user of users)for(const variant of ['sqlite','registry']){for(let i=0;i<snapshot.length;i+=30)await commands(user,snapshot.slice(i,i+30),variant);}
 const now=Date.now();
 const document=makeDefaultDashboard({restaurantCategoryId:categoryIds.restaurantes,widgetIds:[1,2,3,4].map(i=>WidgetId.make('31000000-0000-4000-8000-00000000000'+i))});
 const seed=[];
 for(let index=0;index<users.length;index++){
  const user=users[index],pairing='20000000-0000-4000-8000-00000000000'+(index+1),grant='40000000-0000-4000-8000-00000000000'+(index+1);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token(index))));
  const rows=[
   {sql:"INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?,?,?)",params:[user,now,now,now+604800000]},
   {sql:"INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?, ?, ?,?,'consumed',?,?)",params:[pairing,index?'BCDF-GHJL':'BCDF-GHJK',digest,user,now,now+600000]},
   {sql:"INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,?,?,?,?,?)",params:[session(index),pairing,user,digest,now,now+600000,now+3600000,now+7776000000]},
   {sql:"INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant',?,?,?,'fixture','fixture',?,?)",params:[grant,user,Schema.encodeSync(Schema.fromJsonString(DisclosureSnapshot))(currentDisclosureFor()),now,now]},
   {sql:"INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES(?,'dashboard',?,1)",params:[user,Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(DashboardDocument)))(document)]},
   {sql:"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20) INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms) SELECT printf('81000000-0000-4000-8000-%012d',x+?),?,'1000','COP','outflow','Synthetic fixture','10000000-0000-4000-8000-000000000016',?-x*60000,? FROM n",params:[index*100,user,now,now]},
  ];
  await db.batch(rows.map(row=>db.prepare(row.sql).bind(...row.params)));
  const serializable=rows.map(row=>({...row,params:row.params.map(value=>value instanceof Uint8Array?Array.from(value):value)}));
  await commands(user,serializable);await commands(user,serializable,'registry');seed.push({user,commands:serializable});
 }
 await Bun.write(root+'seed.json',JSON.stringify({now,seed},null,2));
 const renewal={sql:'UPDATE web_sessions SET created_at_ms=?,fresh_until_ms=?,idle_expires_at_ms=?,hard_expires_at_ms=? WHERE id=?',params:[now,now+600000,now+3600000,now+7776000000,session(0)]};
 for(const variant of ['d1','sqlite','registry'])await commands(users[0],[renewal],variant);

 const bucket=await mf.getR2Bucket('ERASURE_BUCKET');
 for(const variant of ['d1','sqlite','registry','replica']){
  const response=await read(variant,'/categories');checks.push({name:'missing-independent-R2',variant,status:response.status});if(response.status!==503)throw Error('Missing R2 admitted '+variant);
 }
 await mf.dispatchFetch('https://probe/__probe/recovery',{method:'PUT',headers:{'x-fidy-bench':gate},body:'initial'});
 for(const [name,index,extra]of [
  ['wrong-routing-prefix',0,{Cookie:'__Host-fidy_session='+users[1]+'.'+token(0)}],
  ['wrong-cookie',0,{Cookie:'__Host-fidy_session='+users[0]+'.'+'c'.repeat(43)}],
  ['wrong-binding',0,{'Fidy-Session-Binding':session(1)}],
  ['duplicate-cookie',0,{Cookie:'__Host-fidy_session='+users[0]+'.'+token(0)+'; __Host-fidy_session='+users[0]+'.'+token(0)}],
 ] as const){const response=await read('sqlite','/categories',index,extra);checks.push({name,status:response.status});if(response.status!==401)throw Error('Credential isolation failed: '+name);}
 if(await scalar(users[1],'SELECT count(*) AS total FROM audit_entries')!==0)throw Error('Foreign routing recorded work for another User');
 const second=await read('sqlite','/categories',1);if(second.status!==200)throw Error('Second User unavailable');
 const auditSql="SELECT count(*) AS total FROM audit_entries WHERE operation='categories.listCategories'";
 const auditBefore=await scalar(users[0],auditSql);
 const pressureBefore=JSON.stringify((await commands(users[0],[{sql:'SELECT * FROM canonical_request_buckets ORDER BY subject',params:[]}]))[0].results);
 await commands(users[0],[{sql:"CREATE TRIGGER refuse_probe_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='categories.listCategories' BEGIN SELECT RAISE(ABORT,'fixture Audit refusal'); END",params:[]}]);
 const rollback=await read('sqlite','/categories');if(rollback.status!==503||await scalar(users[0],auditSql)!==auditBefore)throw Error('Audit atomicity failed');checks.push({name:'Audit-rollback',status:rollback.status});
 if(JSON.stringify((await commands(users[0],[{sql:'SELECT * FROM canonical_request_buckets ORDER BY subject',params:[]}]))[0].results)!==pressureBefore)throw Error('Audit refusal spent User pressure');
 await commands(users[0],[{sql:'DROP TRIGGER refuse_probe_audit',params:[]}]);
 await fault(users[0],2,[{sql:'UPDATE users SET time_zone=? WHERE id=?',params:['America/New_York',users[0]]}]);
 const changedContext=await read('sqlite','/web/session/binding?context=transactions');checks.push({name:'calendar-context-changed-before-disclosure',status:changedContext.status});if(changedContext.status!==503)throw Error('Stale calendar context disclosed');
 await commands(users[0],[{sql:'UPDATE users SET time_zone=? WHERE id=?',params:['America/Bogota',users[0]]}]);
 for(let round=0;round<3;round++)for(const path of routes)for(const variant of round%2?['registry','replica','sqlite','d1']:['d1','sqlite','replica','registry']){
  await Bun.sleep(120);const started=performance.now();const response=await read(variant,path);const body=await response.text(),elapsedMs=performance.now()-started;
  if(response.status!==200)throw Error('Read unavailable: '+variant+' '+path+' '+response.status);
  const value=JSON.parse(body);if(path==='/dashboard/view')value.data.context.calculatedAt='<request-time>';
  const hash=new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
  samples.push({round,path,variant,status:response.status,elapsedMs,comparisonHash:hash,bytes:body.length,cost:JSON.parse(response.headers.get('x-bench-cost')||'null'),timings:response.headers.get('server-timing'),batches:response.headers.get('fidy-recovery-batches'),coordinatorBatches:response.headers.get('fidy-dashboard-recovery-batches')});
  await Bun.write(root+'native-samples.json',JSON.stringify({samples,checks},null,2));console.log(JSON.stringify({round,path,variant,elapsedMs:Math.round(elapsedMs*10)/10}));
 }
 for(const path of routes)if(new Set(samples.filter(row=>row.path===path).map(row=>row.comparisonHash)).size!==1)throw Error('Complete response mismatch: '+path);
 const dashboardAudit="SELECT count(*) AS total FROM audit_entries WHERE operation='dashboard.getDashboardView' AND outcome='accepted'";
 const beforeRevocation=await scalar(users[0],dashboardAudit);
 await fault(users[0],2,[{sql:'UPDATE web_sessions SET revoked_at_ms=? WHERE id=?',params:[Date.now(),session(0)]}]);
 const revoked=await read('sqlite','/dashboard/view');checks.push({name:'credential-revoked-before-final-projection',status:revoked.status});
 if(![401,503].includes(revoked.status)||await scalar(users[0],dashboardAudit)!==beforeRevocation)throw Error('Revoked projection disclosed or accepted Audit committed');
 const before=await scalar(users[0],auditSql);await mf.dispatchFetch('https://probe/__probe/recovery',{method:'PUT',headers:{'x-fidy-bench':gate},body:'10000000-0000-4000-8000-000000000999'});
 for(const variant of ['d1','sqlite','registry','replica']){const response=await read(variant,'/categories');checks.push({name:'independent-R2-generation-mismatch',variant,status:response.status});if(response.status!==503)throw Error('Stale generation admitted');}
 if(await scalar(users[0],auditSql)!==before)throw Error('Generation mismatch changed Audit');
 await Bun.write(root+'native-samples.json',JSON.stringify({samples,checks,completeResponseParity:true,productionMigration:false},null,2));
 if(process.env.BENCH_ENFORCED!=='1'){
 const planResponse=await mf.dispatchFetch('https://probe.invalid/__probe/plan',{headers:{'x-fidy-bench':gate}});
 if(!planResponse.ok)throw Error('Plan unavailable');await Bun.write(root+'calibrated-plan.json',JSON.stringify(await planResponse.json(),null,2));
 }
 const cleanup=await mf.dispatchFetch('https://probe.invalid/__probe/cleanup',{method:'DELETE',headers:{'x-fidy-bench':gate}});if(cleanup.status!==204)throw Error('Fixture cleanup failed');
 console.log(JSON.stringify({completeResponses:samples.length,checks:checks.length,completeResponseParity:true,productionMigration:false}));
} finally {await mf.dispose();}
