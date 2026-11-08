import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'core',modules:true,scriptPath:root+'prototype-worker.js',compatibilityDate:'2026-09-08',bindings:{PROBE_TOKEN:'synthetic-local-only'},d1Databases:{DB:'synthetic-db',...Object.fromEntries(Array.from({length:20},(_,i)=>['DB_'+i,'synthetic-db-'+i]))},r2Buckets:{FENCE:'synthetic-fence'},durableObjects:{REGISTRY:{className:'RecoveryRegistry',useSQLite:true},LOCAL:{className:'LocalDatabase',useSQLite:true}}},{name:'gateway',modules:true,compatibilityDate:'2026-09-08',script:'export default {fetch(request,env){return env.CORE.fetch(request);}}',serviceBindings:{CORE:'core'}}]}));
const state={scope:'Local native workerd, synthetic 1000-row fixture, topology screening only; no deployed latency or full application parity claim',samples:[],checks:[],passed:false};
async function request(path,expected=200,token='synthetic-local-only'){
 const start=performance.now();const isBinding=path.startsWith('/binding');const dispatch=isBinding?await mf.getWorker('gateway'):mf;const response=await (isBinding?dispatch.fetch('https://probe'+path.replace('/binding','/d1-1'),{headers:{'x-probe-token':token}}):dispatch.dispatchFetch('https://probe'+path,{headers:{'x-probe-token':token}}));const bytes=await response.text();
 if(response.status!==expected)throw Error('Unexpected status '+response.status+' for '+path);
 return {elapsedMs:performance.now()-start,body:bytes?JSON.parse(bytes):null};
}
try{
 await request('/health',404,'wrong');state.checks.push('outer gate refuses invalid token');
 await request('/setup');
 const variants=['/d1-3','/d1-2','/d1-1','/binding','/d1-session','/do-d1','/do-sqlite','/d1-registry','/do-registry'];
 for(let round=0;round<31;round++){
  for(const variant of round%2?[...variants].reverse():variants){
   const result=await request(variant);
   if(JSON.stringify(result.body.data)!==JSON.stringify({count:1000,amount:100000}))throw Error('Projection mismatch');
   state.samples.push({variant,round,elapsedMs:result.elapsedMs,...result.body.timing});
  }
 }
 state.checks.push('all 279 projections equal independently calculated count and exact integer total');
 let before=(await request('/audit')).body;
 for(const variant of variants)await request(variant+'?owner=2',403);
 let after=(await request('/audit')).body;
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Unauthorized audit side effect');
 state.checks.push('ungranted owner refused with no audit side effects');
 await request('/fence?generation=mismatch',204);
 for(const variant of variants)await request(variant,403);
 after=(await request('/audit')).body;
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Fence audit side effect');
 state.checks.push('restore-generation mismatch refused with no audit side effects');
 await request('/fence?generation=initial',204);
 for(const variant of variants)await request(variant);
 state.checks.push('restored generation permits subsequent work');
 await request('/setup-isolation');
 state.contention=[];
 for(let round=0;round<10;round++){
  const variants=['/d1-1','/sharded','/do-sqlite','/isolated-do'];
  for(const variant of round%2?[...variants].reverse():variants){
   const start=performance.now();
   const results=await Promise.all(Array.from({length:20},(_,shard)=>request(variant+'?shard='+shard)));
   if(results.some(r=>r.body.data.count!==1000||r.body.data.amount!==100000))throw Error('Concurrent projection mismatch');
   state.contention.push({variant,round,burstMs:performance.now()-start,latencies:results.map(r=>r.elapsedMs)});
  }
 }
 state.checks.push('800 burst requests return matching projections across shared/sharded D1 and shared/isolated SQLite DO');
 before=(await request('/audit')).body;
 await request('/missing',204);
 for(const variant of variants)await request(variant,403);
 after=(await request('/audit')).body;
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Missing authority side effect');
 await request('/fence?generation=initial',204);
 for(const variant of variants)await request(variant);
 state.checks.push('missing independent authority refuses all variants without audit side effects, then explicit recovery succeeds');
 state.passed=true;
 const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(p*xs.length)-1];
 state.summary=variants.map(variant=>{const rows=state.samples.filter(r=>r.variant===variant&&r.round>0);return {variant,n:rows.length,medianMs:percentile(rows.map(r=>r.elapsedMs),.5),p95Ms:percentile(rows.map(r=>r.elapsedMs),.95),batches:rows[0].batches};});
 state.contentionSummary=['/d1-1','/sharded','/do-sqlite','/isolated-do'].map(variant=>{const rows=state.contention.filter(r=>r.variant===variant&&r.round>0),latencies=rows.flatMap(r=>r.latencies);return {variant,n:latencies.length,medianMs:percentile(latencies,.5),p95Ms:percentile(latencies,.95),medianBurstMs:percentile(rows.map(r=>r.burstMs),.5)};});
 console.log(JSON.stringify({contentionSummary:state.contentionSummary,passed:state.passed,checks:state.checks,summary:state.summary},null,2));
}finally{await mf.dispose();writeFileSync(root+'native-results.json',JSON.stringify(state,null,2)+'\n');}
