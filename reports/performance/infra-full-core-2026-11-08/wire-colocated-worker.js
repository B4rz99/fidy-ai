// Synthetic network-boundary probe, not Fidy Core or an adoption candidate.
export class LocalUser{async fetch(){return new Response(null,{status:204});}}
export class RegistryUser extends LocalUser{}
export class RecoveryAuthority extends LocalUser{}
export class UserTransactionCoordinator extends LocalUser{}
export default{async fetch(request,env){
 if(!env.BENCH_TOKEN||request.headers.get('x-fidy-bench')!==env.BENCH_TOKEN||Date.now()>Number(env.PROBE_EXPIRES||0))return new Response(null,{status:404});
 const path=new URL(request.url).pathname;if(path==='/__probe/health')return Response.json({ready:true},{headers:{'x-bench-cost':JSON.stringify({rowsRead:0,rowsWritten:0,batches:0,failed:false,unaccounted:false})}});const started=performance.now();let rowsRead=0,rowsWritten=0,batches=0,recoveryWaitMs=0,storageWaitMs=0,sqlDurationMs=0;const locations=[];
 const batch=async commands=>{const begin=performance.now(),rows=await env.DB.batch(commands.map(q=>env.DB.prepare(q.sql).bind(...q.params)));storageWaitMs+=performance.now()-begin;batches++;
  for(const r of rows){if(!r.success||!Number.isSafeInteger(r.meta.rows_read)||!Number.isSafeInteger(r.meta.rows_written))throw Error('Missing native metadata');rowsRead+=r.meta.rows_read;rowsWritten+=r.meta.rows_written;sqlDurationMs+=r.meta.timings?.sql_duration_ms??r.meta.duration??0;
   const l={};for(const k of ['served_by_region','served_by_colo','served_by_primary'])if(r.meta[k]!==undefined)l[k]=r.meta[k];if(Object.keys(l).length&&!locations.some(x=>JSON.stringify(x)===JSON.stringify(l)))locations.push(l);
  }return rows;
 };
 const generation=async()=>{const begin=performance.now(),r=await env.ERASURE_BUCKET.get('recovery/generation');const value=r?await r.text():null;recoveryWaitMs+=performance.now()-begin;return value;};
 let body={ready:true},status=200;
 if(path==='/__probe/cleanup'){await env.ERASURE_BUCKET.delete('recovery/generation');return new Response(null,{status:204});}
 if(path==='/__probe/recovery'){await env.ERASURE_BUCKET.put('recovery/generation',await request.text());return new Response(null,{status:204});}
 if(path==='/__probe/sql')body=await batch(await request.json());
 else if(path==='/read'){
  if(request.headers.get('cookie')?.includes('z'.repeat(43)))status=401;
  else{
   const first=await generation();if(first!=='initial')return new Response(null,{status:503});
   const standing=await batch([{sql:'SELECT generation FROM authority WHERE id=1 AND active=1 AND generation=?',params:[first]}]);if(standing[0].results.length!==1)return new Response(null,{status:503});
   const last=await generation();if(last!=='initial')return new Response(null,{status:503});
   const result=await batch([{sql:'INSERT INTO audit(event) SELECT ? WHERE EXISTS(SELECT 1 FROM authority WHERE id=1 AND active=1 AND generation=?)',params:['read',last]},{sql:'SELECT count(*) AS count,sum(amount) AS amount FROM records WHERE EXISTS(SELECT 1 FROM authority WHERE id=1 AND active=1 AND generation=?)',params:[last]}]);body={data:result[1].results[0]};
  }
 }
 const headers={'content-type':'application/json','cache-control':'no-store','x-bench-handler-ms':String(performance.now()-started),'x-bench-cost':JSON.stringify({rowsRead,rowsWritten,batches,recoveryWaitMs,storageWaitMs,failed:false,unaccounted:false}),'x-probe-locations':JSON.stringify(locations),'x-probe-sql-ms':String(sqlDurationMs),'x-probe-sql-statements':String(batches),'server-timing':`probe-r2;dur=${recoveryWaitMs}, probe-d1;dur=${storageWaitMs}, probe-sql;dur=${sqlDurationMs}`};
 return new Response(JSON.stringify(body),{status,headers});
}};
