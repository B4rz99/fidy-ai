// Disposable experiment-only accounting. Never imported by application code.
import { AsyncLocalStorage } from 'node:async_hooks';
export const accounting = new AsyncLocalStorage();
export const learned = new Map();
const safe = x => Number.isSafeInteger(x) && x >= 0;
export function guarded(db, env) {
 const statements = new WeakMap();
 function prepare(sql) {
  const raw = db.prepare(sql);
  function wrap(statement) {
   const value = {
    bind(...args) { return wrap(statement.bind(...args)); },
    async all() { return (await execute([value]))[0]; },
    async run() { return (await execute([value]))[0]; },
    async first(column) { const result = (await value.all()).results[0]; return result === undefined ? null : column === undefined ? result : result[column]; },
    async raw() { throw Error('Unaccounted raw operation'); }
   };
   statements.set(value, {raw:statement,sql}); return value;
  }
  return wrap(raw);
 }
 async function execute(input) {
  const scope = accounting.getStore(); if (!scope) throw Error('Missing experiment scope');
  let reserve = {rowsRead:0,rowsWritten:0}; let inFlight = false;
  try {
   const entries = input.map(s=>{const entry=statements.get(s);if(!entry)throw Error('Foreign statement');return entry;});
   const calibration = env.BENCH_LOCAL_CALIBRATION === 'true'; const plans = env.BENCH_COST_PLAN || {};
   reserve = entries.reduce((sum,entry)=>{
    const cap=plans[entry.sql];if(!calibration&&!cap)throw Error('Uncalibrated SQL');
    return {rowsRead:sum.rowsRead+(cap?.rowsRead||0),rowsWritten:sum.rowsWritten+(cap?.rowsWritten||0)};
   },{rowsRead:0,rowsWritten:0});
   if(!calibration&&(scope.rowsRead+scope.child.rowsRead+scope.reserved.rowsRead+reserve.rowsRead>scope.ceiling.rowsRead||scope.rowsWritten+scope.child.rowsWritten+scope.reserved.rowsWritten+reserve.rowsWritten>scope.ceiling.rowsWritten))throw Error('Experiment batch ceiling');
   scope.reserved.rowsRead+=reserve.rowsRead;scope.reserved.rowsWritten+=reserve.rowsWritten;inFlight=true;
   let result;
   const started=performance.now();
   try {result=await db.batch(entries.map(x=>x.raw));} catch(error) {scope.unaccounted=true;throw error;} finally {scope.storageWaitMs+=performance.now()-started;}
   scope.batches++;
   let invalid=result.length!==entries.length, overflow=false;
   // Accumulate EVERY returned result before reporting an error. The entire native batch has run.
   result.forEach((row,i)=>{
    if(!safe(row.meta?.rows_read)||!safe(row.meta?.rows_written)){invalid=true;scope.unaccounted=true;return;}
    const cost={rowsRead:row.meta.rows_read,rowsWritten:row.meta.rows_written};scope.rowsRead+=cost.rowsRead;scope.rowsWritten+=cost.rowsWritten;
    if(!row.success||!entries[i]){invalid=true;return;}
    const previous=learned.get(entries[i].sql)||{rowsRead:0,rowsWritten:0};learned.set(entries[i].sql,{rowsRead:Math.max(previous.rowsRead,cost.rowsRead),rowsWritten:Math.max(previous.rowsWritten,cost.rowsWritten)});
    const cap=plans[entries[i].sql];if(!calibration&&(cost.rowsRead>cap.rowsRead||cost.rowsWritten>cap.rowsWritten))overflow=true;
   });
   if(invalid)throw Error('Missing native cost metadata');if(overflow)throw Error('Native cost exceeded calibrated bound');return result;
  } catch(error) {scope.failed=true;throw error;} finally {if(inFlight){scope.reserved.rowsRead-=reserve.rowsRead;scope.reserved.rowsWritten-=reserve.rowsWritten;}}
 }

 return {prepare,batch:execute,exec(){throw Error('Unaccounted exec');},withSession(){throw Error('Unaccounted session');},dump(){throw Error('Unaccounted dump');}};
}
export async function measured(ceiling, fn) {
 const scope={rowsRead:0,rowsWritten:0,batches:0,storageWaitMs:0,recoveryWaitMs:0,coordinatorWaitMs:0,ceiling,reserved:{rowsRead:0,rowsWritten:0},unaccounted:false,child:{rowsRead:0,rowsWritten:0,batches:0,storageWaitMs:0,recoveryWaitMs:0}};
 return accounting.run(scope,async()=>{
  let response;try{response=await fn();}catch(error){response=Response.json({error:'experiment-refused',reason:String(error.message)},{status:503});scope.failed=true;}
  if(scope.rowsRead+scope.child.rowsRead>ceiling.rowsRead||scope.rowsWritten+scope.child.rowsWritten>ceiling.rowsWritten)scope.failed=true;
  if(scope.failed||scope.unaccounted)response=Response.json({error:'experiment-refused'},{status:503});
  const headers=new Headers(response.headers);headers.set('x-bench-cost',JSON.stringify({rowsRead:scope.rowsRead+scope.child.rowsRead,rowsWritten:scope.rowsWritten+scope.child.rowsWritten,batches:scope.batches+scope.child.batches,storageWaitMs:scope.storageWaitMs+scope.child.storageWaitMs,recoveryWaitMs:scope.recoveryWaitMs+scope.child.recoveryWaitMs,coordinatorWaitMs:scope.coordinatorWaitMs,own:{rowsRead:scope.rowsRead,rowsWritten:scope.rowsWritten,batches:scope.batches},child:scope.child,failed:scope.failed||false,unaccounted:scope.unaccounted}));
  return new Response(response.body,{status:response.status,headers});
 });
}
