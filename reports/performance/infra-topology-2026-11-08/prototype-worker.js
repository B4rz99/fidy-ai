// THROWAWAY synthetic topology probe. No application or production bindings.
const schema = [
 "CREATE TABLE control(generation TEXT NOT NULL)",
 "INSERT INTO control VALUES('initial')",
 "CREATE TABLE grants(owner INTEGER PRIMARY KEY, active INTEGER NOT NULL)",
 "INSERT INTO grants VALUES(1,1)",
 "CREATE TABLE movements(id INTEGER PRIMARY KEY, owner INTEGER NOT NULL, amount INTEGER NOT NULL)",
 "CREATE INDEX movements_owner ON movements(owner)",
 "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO movements SELECT x,1,100 FROM n",
 "CREATE TABLE audit(id INTEGER PRIMARY KEY, owner INTEGER NOT NULL)",
];
const fenceSql = "SELECT json(CASE WHEN EXISTS(SELECT 1 FROM control WHERE generation=?) THEN 'true' ELSE '' END) AS ok";
const grantSql = "SELECT json(CASE WHEN EXISTS(SELECT 1 FROM grants WHERE owner=? AND active=1) THEN 'true' ELSE '' END) AS ok";
const totalSql = "SELECT count(*) AS count, sum(amount) AS amount FROM movements WHERE owner=?";
const auditSql = "INSERT INTO audit(owner) SELECT ? WHERE EXISTS(SELECT 1 FROM grants WHERE owner=? AND active=1)";
async function generation(env) {
 if(env.USE_REGISTRY){const response=await env.REGISTRY.getByName('independent-recovery-authority').fetch('https://registry/read');if(!response.ok)throw Error('registry unavailable');return await response.text();}
 const object=await env.FENCE.get('recovery/generation');
 if(!object || object.size>64)throw Error('fence unavailable');
 return await object.text();
}
async function d1Read(env,units,owner) {
 let r2Ms=0,d1Ms=0,batches=0,rowsRead=0,rowsWritten=0,result;
 async function batch(statements){
  let start=performance.now();const expected=await generation(env);r2Ms+=performance.now()-start;
  start=performance.now();const rows=await env.DB.batch([env.DB.prepare(fenceSql).bind(expected),...statements]);d1Ms+=performance.now()-start;batches++;
  for(const row of rows){rowsRead+=row.meta.rows_read;rowsWritten+=row.meta.rows_written;}
  return rows.slice(1);
 }
 const grant=()=>env.DB.prepare(grantSql).bind(owner);
 const total=()=>env.DB.prepare(totalSql).bind(owner);
 const audit=()=>env.DB.prepare(auditSql).bind(owner,owner);
 if(units===3){await batch([grant()]);result=(await batch([grant(),total()]))[1];await batch([grant(),audit()]);}
 else if(units===2){await batch([grant()]);result=(await batch([grant(),total(),audit()]))[1];}
 else result=(await batch([grant(),total(),audit()]))[1];
 return {data:result.results[0],timing:{authorityMs:r2Ms,authoritySource:env.USE_REGISTRY?'sqlite-do':'r2',d1Ms,batches,rowsRead,rowsWritten}};
}
export class RecoveryRegistry {
 constructor(ctx,env){this.ctx=ctx;}
 async fetch(request){
  const url=new URL(request.url),sql=this.ctx.storage.sql;
  if(url.pathname==='/setup'){sql.exec('CREATE TABLE generation(value TEXT NOT NULL)').toArray();sql.exec("INSERT INTO generation VALUES('initial')").toArray();return new Response(null,{status:204});}
  if(url.pathname==='/delete'){sql.exec('DELETE FROM generation').toArray();return new Response(null,{status:204});}
  if(url.pathname==='/set'){this.ctx.storage.transactionSync(()=>{sql.exec('DELETE FROM generation').toArray();sql.exec('INSERT INTO generation VALUES(?)',url.searchParams.get('value')).toArray();});return new Response(null,{status:204});}
  return new Response(sql.exec('SELECT value FROM generation').one().value);
 }
}
export class LocalDatabase {
 constructor(ctx,env){this.ctx=ctx;this.env=env;}
 async fetch(request){
  const url=new URL(request.url),sql=this.ctx.storage.sql;
  if(url.pathname==='/setup'){
   this.ctx.storage.transactionSync(()=>{for(const statement of schema)sql.exec(statement).toArray();});
   return Response.json({ready:true});
  }
  if(url.pathname==='/audit')return Response.json(sql.exec('SELECT count(*) AS count FROM audit').one());
  if(url.pathname==='/d1')return Response.json(await d1Read(this.env,2,Number(url.searchParams.get('owner')||1)));
  const owner=Number(url.searchParams.get('owner')||1);
  const start=performance.now(),expected=await generation(url.pathname==='/registry'?{...this.env,USE_REGISTRY:true}:this.env),r2Ms=performance.now()-start;
  const result=this.ctx.storage.transactionSync(()=>{
   sql.exec(fenceSql,expected).toArray();sql.exec(grantSql,owner).toArray();
   const data=sql.exec(totalSql,owner).one();sql.exec(auditSql,owner,owner).toArray();return data;
  });
  return Response.json({data:result,timing:{authorityMs:r2Ms,authoritySource:url.pathname==='/registry'?'sqlite-do':'r2',batches:1}});
 }
}
export default {async fetch(request,env){
 if(!env.PROBE_TOKEN || request.headers.get('x-probe-token')!==env.PROBE_TOKEN)return new Response(null,{status:404});
 const url=new URL(request.url),path=url.pathname,start=performance.now();
 try{
  if(path==='/health')return Response.json({ready:true});
  if(path==='/setup-isolation'){
   for(let shard=0;shard<20;shard++){
    await env['DB_'+shard].batch(schema.map(s=>env['DB_'+shard].prepare(s)));
    await env.LOCAL.getByName('synthetic-tenant-'+shard).fetch('https://probe/setup');
   }
   return Response.json({ready:true});
  }
  if(path==='/setup'){
   await env.FENCE.put('recovery/generation','initial');
   await env.REGISTRY.getByName('independent-recovery-authority').fetch('https://registry/setup');
   await env.DB.batch(schema.map(s=>env.DB.prepare(s)));
   await env.LOCAL.getByName('synthetic-owner-1').fetch('https://probe/setup');
   return Response.json({ready:true});
  }
  if(path==='/missing'){await env.FENCE.delete('recovery/generation');await env.REGISTRY.getByName('independent-recovery-authority').fetch('https://registry/delete');return new Response(null,{status:204});}
  if(path==='/fence'){
   const value=url.searchParams.get('generation')==='mismatch'?'mismatch':'initial';
   await env.FENCE.put('recovery/generation',value);
   await env.REGISTRY.getByName('independent-recovery-authority').fetch('https://registry/set?value='+value);
   return new Response(null,{status:204});
  }
  if(path==='/audit'){
   const d1=await env.DB.prepare('SELECT count(*) AS count FROM audit').first();
   const local=await(await env.LOCAL.getByName('synthetic-owner-1').fetch('https://probe/audit')).json();
   return Response.json({d1:d1.count,local:local.count});
  }
  const owner=url.searchParams.get('owner')||'1';
  let response;
  if(path==='/sharded'){
   const shard=Number(url.searchParams.get('shard'));
   if(!Number.isInteger(shard)||shard<0||shard>=20)return new Response(null,{status:404});
   response=Response.json(await d1Read({...env,DB:env['DB_'+shard]},1,Number(owner)));
  }else if(path==='/isolated-do'){
   const shard=Number(url.searchParams.get('shard'));
   if(!Number.isInteger(shard)||shard<0||shard>=20)return new Response(null,{status:404});
   response=await env.LOCAL.getByName('synthetic-tenant-'+shard).fetch('https://probe/sqlite?owner='+owner);
  }else if(path==='/do-registry')response=await env.LOCAL.getByName('synthetic-owner-1').fetch('https://probe/registry?owner='+owner);
  else if(path==='/d1-registry')response=Response.json(await d1Read({...env,USE_REGISTRY:true},1,Number(owner)));
  else if(path==='/d1-session')response=Response.json(await d1Read({...env,DB:env.DB.withSession('first-unconstrained')},1,Number(owner)));
  else if(['/d1-1','/d1-2','/d1-3'].includes(path))response=Response.json(await d1Read(env,Number(path.slice(-1)),Number(owner)));
  else if(path==='/do-sqlite'||path==='/do-d1')response=await env.LOCAL.getByName('synthetic-owner-1').fetch('https://probe/'+(path==='/do-d1'?'d1':'sqlite')+'?owner='+owner);
  else return new Response(null,{status:404});
  const headers=new Headers(response.headers);headers.set('x-probe-handler-ms',String(performance.now()-start));headers.set('cache-control','no-store');
  return new Response(response.body,{status:response.status,headers});
 }catch{return Response.json({refused:true},{status:403});}
}};
