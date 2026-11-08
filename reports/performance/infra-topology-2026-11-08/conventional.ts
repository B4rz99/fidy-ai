// THROWAWAY colocated HTTP + SQLite control. Local measurements only.
import {Database} from 'bun:sqlite';
import {mkdir,writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=await mkdtemp(join(tmpdir(),'fidy-infra-synthetic-'));
const generationPath=join(directory,'generation');
const samples=[],checks=[];
let server;
try{
 await writeFile(generationPath,'initial');
 for(const size of [1000,100000]){
  const db=new Database(join(directory,'synthetic-'+size+'.sqlite'));
  db.exec("PRAGMA journal_mode=WAL;CREATE TABLE control(generation TEXT NOT NULL);INSERT INTO control VALUES('initial');CREATE TABLE grants(owner INTEGER PRIMARY KEY,active INTEGER NOT NULL);INSERT INTO grants VALUES(1,1);CREATE TABLE movements(id INTEGER PRIMARY KEY,owner INTEGER NOT NULL,amount INTEGER NOT NULL);CREATE INDEX movements_owner ON movements(owner);CREATE TABLE audit(id INTEGER PRIMARY KEY,owner INTEGER NOT NULL)");
  const insert=db.prepare('INSERT INTO movements VALUES(?,1,100)');db.transaction(()=>{for(let i=1;i<=size;i++)insert.run(i);})();
  const fence=db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM control WHERE generation=?) THEN 'true' ELSE '' END) AS ok");
  const grant=db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM grants WHERE owner=? AND active=1) THEN 'true' ELSE '' END) AS ok");
  const total=db.prepare('SELECT count(*) AS count,sum(amount) AS amount FROM movements WHERE owner=?');
  const audit=db.prepare('INSERT INTO audit(owner) SELECT ? WHERE EXISTS(SELECT 1 FROM grants WHERE owner=? AND active=1)');
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
   if(request.headers.get('x-probe-token')!=='synthetic-local-only')return new Response(null,{status:404});
   try{
    const owner=new URL(request.url).searchParams.get('owner')==='2'?2:1;
    const generation=await readFile(generationPath,'utf8');
    const data=db.transaction(()=>{fence.get(generation);grant.get(owner);const result=total.get(owner);audit.run(owner,owner);return result;})();
    return Response.json(data,{headers:{'cache-control':'no-store'}});
   }catch{return new Response(null,{status:403});}
  }});
  const request=async(owner=1)=>{const start=performance.now(),response=await fetch('http://127.0.0.1:'+server.port+'/?owner='+owner,{headers:{'x-probe-token':'synthetic-local-only'}});const text=await response.text();return {elapsedMs:performance.now()-start,status:response.status,data:text?JSON.parse(text):null};};
  for(let round=0;round<31;round++){
   const result=await request();
   if(result.status!==200||result.data.count!==size||result.data.amount!==size*100)throw Error('projection mismatch');
   samples.push({size,round,elapsedMs:result.elapsedMs});
  }
  const count=()=>db.prepare('SELECT count(*) AS count FROM audit').get().count;
  const before=count();
  if((await request(2)).status!==403||count()!==before)throw Error('unauthorized side effect');
  await writeFile(generationPath,'mismatch');
  if((await request()).status!==403||count()!==before)throw Error('generation mismatch side effect');
  await writeFile(generationPath,'initial');
  checks.push({size,matchingTotals:true,unauthorizedRefused:true,mismatchedFenceRefused:true});
  await server.stop(true);server=undefined;db.close();
 }
 const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
 const report={scope:'Colocated Bun HTTP and SQLite, fresh independent local-file generation read; local lower bound only. No deployed provider, independent service durability, full Fidy schema or application parity proven.',checks,samples,summary:[1000,100000].map(size=>{const xs=samples.filter(r=>r.size===size&&r.round>0).map(r=>r.elapsedMs);return {size,n:xs.length,medianMs:percentile(xs,.5),p95Ms:percentile(xs,.95)};})};
 await writeFile(new URL('./conventional-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({checks,summary:report.summary},null,2));
}finally{await server?.stop(true);await rm(directory,{recursive:true,force:true});}
