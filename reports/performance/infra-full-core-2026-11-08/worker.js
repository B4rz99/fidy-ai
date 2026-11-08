// Disposable current-Core topology comparison. No production bindings.
import probe,{LocalUser,UserTransactionCoordinator}from'./core/probe-worker.js';
export {LocalUser,UserTransactionCoordinator};
export class RecoveryAuthority {
 constructor(ctx,env){this.ctx=ctx;ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS generation(value TEXT NOT NULL)').toArray();}
 async fetch(request){
  if(request.method==='PUT'){
   const value=await request.text();if(value.length>64)return new Response(null,{status:400});
   this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DELETE FROM generation').toArray();this.ctx.storage.sql.exec('INSERT INTO generation VALUES(?)',value).toArray();});
   return new Response(null,{status:204});
  }
  if(request.method==='DELETE'){await this.ctx.storage.deleteAll();return new Response(null,{status:204});}
  const row=this.ctx.storage.sql.exec('SELECT value FROM generation').toArray()[0];
  return row?new Response(row.value):new Response(null,{status:503});
 }
}
const registryBucket=env=>new Proxy(env.ERASURE_BUCKET,{get(target,key){
 if(key==='get')return async(name,...args)=>{
  if(name!=='recovery/generation')return target.get(name,...args);
  const response=await env.RECOVERY_AUTHORITY.getByName('independent-generation').fetch('https://recovery/read');
  if(!response.ok)return null;
  const value=await response.text();if(value.length>64)throw Error('Invalid fixture generation');
  return {size:value.length,etag:'prototype-independent-generation',text:async()=>value,body:new Response(value).body};
 };
 const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});
export class RegistryUser extends LocalUser {constructor(ctx,env){super(ctx,{...env,ERASURE_BUCKET:registryBucket(env)});}}
export default{async fetch(request,env,context){
 if(!env.BENCH_TOKEN||request.headers.get('x-fidy-bench')!==env.BENCH_TOKEN||Date.now()>Number(env.PROBE_EXPIRES||0))return new Response(null,{status:404});
 const path=new URL(request.url).pathname,started=performance.now(),headers=new Headers(request.headers),mode=headers.get('x-probe-storage');
 if(path==='/__probe/health')return Response.json({ready:true},{headers:{'x-bench-cost':JSON.stringify({rowsRead:0,rowsWritten:0,batches:0,failed:false,unaccounted:false})}});
 if(path==='/__probe/cleanup'){
  for(const user of env.BENCH_USERS.split(','))await env.REGISTRY_USER.getByName(user).fetch('https://probe/__probe/delete',{headers:{'x-probe-user':user}});
  await env.RECOVERY_AUTHORITY.getByName('independent-generation').fetch('https://recovery/delete',{method:'DELETE'});
 }
 if(path==='/__probe/recovery'&&request.method==='PUT'){
  const value=await request.clone().text();const r=await env.RECOVERY_AUTHORITY.getByName('independent-generation').fetch('https://recovery/set',{method:'PUT',body:value});
  if(r.status!==204)return new Response(null,{status:503});
 }
 const locations=[];let DB=mode==='replica'?env.DB.withSession('first-unconstrained'):env.DB;
 DB=new Proxy(DB,{get(target,key){
  if(key==='batch')return async statements=>{
   const rows=await target.batch(statements);
   for(const r of rows){const m=r.meta||{};const location={};for(const k of ['served_by_region','served_by_colo'])if(typeof m[k]==='string'&&/^[A-Z]{2,6}$/.test(m[k]))location[k]=m[k];if(typeof m.served_by_primary==='boolean')location.served_by_primary=m.served_by_primary;
    if(Object.keys(location).length&&locations.length<32&&!locations.some(v=>JSON.stringify(v)===JSON.stringify(location)))locations.push(location);
   }return rows;
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 if(mode==='replica')headers.set('x-probe-storage','d1');
 if(mode==='registry')headers.set('x-probe-storage','sqlite');
 const response=await probe.fetch(new Request(request,{headers}),{...env,DB,...(mode==='registry'?{LOCAL_USER:env.REGISTRY_USER}:{})},context);
 const out=new Headers(response.headers);out.set('cache-control','no-store');out.set('x-bench-handler-ms',String(performance.now()-started));out.set('x-probe-locations',JSON.stringify(locations));
 return new Response(response.body,{status:response.status,headers:out});
}};
