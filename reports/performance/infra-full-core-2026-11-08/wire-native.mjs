import {Miniflare,convertV4MiniflareOptions}from'miniflare';
import{writeFileSync}from'node:fs';
import{fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('.',import.meta.url)),gate='local-wire-only';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:root+'wire-colocated-worker.js',compatibilityDate:'2026-09-08',bindings:{BENCH_TOKEN:gate,PROBE_EXPIRES:String(Date.now()+3600000)},d1Databases:['DB'],r2Buckets:['ERASURE_BUCKET']}));
const request=(path,init={})=>mf.dispatchFetch('https://wire'+path,{...init,headers:{'x-fidy-bench':gate,...init.headers}});
try{
 const health=await request('/__probe/health');if(health.status!==200)throw Error('Health failed');await health.arrayBuffer();
 const sql=async commands=>{const r=await request('/__probe/sql',{method:'POST',body:JSON.stringify(commands)});if(!r.ok)throw Error('Fixture failed');return r.json();};
 await sql(['CREATE TABLE authority(id INTEGER PRIMARY KEY,active INTEGER,generation TEXT)','CREATE TABLE records(id INTEGER PRIMARY KEY,amount INTEGER)','CREATE TABLE audit(id INTEGER PRIMARY KEY,event TEXT)',"INSERT INTO authority VALUES(1,1,'initial')",'WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100) INSERT INTO records SELECT i,100 FROM n'].map(sql=>({sql,params:[]})));
 await request('/__probe/recovery',{method:'PUT',body:'initial'});
 for(let i=0;i<62;i++){const r=await request('/read');if(!r.ok||JSON.stringify(await r.json())!==JSON.stringify({data:{count:100,amount:10000}}))throw Error('Projection mismatch');}
 const r=await request('/read',{headers:{cookie:'__Host-fidy_session='+'z'.repeat(43)}});if(r.status!==401)throw Error('Credential control failed');
 await request('/__probe/recovery',{method:'PUT',body:'changed'});if((await request('/read')).status!==503)throw Error('Generation control failed');
 const count=await sql([{sql:'SELECT count(*) AS count FROM audit',params:[]}]);if(count[0].results[0].count!==62)throw Error('Refusal wrote Audit');
 writeFileSync(root+'wire-native-results.json',JSON.stringify({responses:62,projectionParity:true,refusalWithoutAudit:true,scope:'synthetic network-boundary probe'}));console.log(JSON.stringify({responses:62,projectionParity:true,refusalWithoutAudit:true}));
}finally{await mf.dispose();}
