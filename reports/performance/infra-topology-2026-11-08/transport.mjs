import http2 from 'node:http2';
import {performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';
const root=new URL('.',import.meta.url),sessions=new Map();
const state={scope:'Public HTTP/2 transport only, no authenticated data; not view readiness',origin:{},samples:[]};
function session(origin){if(!sessions.has(origin))sessions.set(origin,http2.connect(origin));return sessions.get(origin);}
async function get(origin,path,phase,round){
 const s=session(origin),start=performance.now();
 return await new Promise((resolve,reject)=>{
  let headers,first=0;const chunks=[];let bytes=0;
  const request=s.request({':method':'GET',':path':path,'accept-encoding':'br,gzip','user-agent':'FidyInfraPublicTransport/1.0'});
  request.setTimeout(15000,()=>request.close(http2.constants.NGHTTP2_CANCEL));
  request.on('error',reject);request.on('aborted',()=>reject(Error('bounded timeout')));
  request.on('response',h=>{headers=h;first=performance.now();});
  request.on('data',chunk=>{bytes+=chunk.length;if(bytes>2000000)request.close(http2.constants.NGHTTP2_CANCEL);else chunks.push(chunk);});
  request.on('end',()=>{
   const row={origin,path,phase,round,status:headers[':status'],headerMs:first-start,totalMs:performance.now()-start,bytes,encoding:headers['content-encoding'],cache:headers['cf-cache-status'],edge:String(headers['cf-ray']||'').split('-').at(-1),serverTiming:headers['server-timing']};state.samples.push(row);resolve({row,body:Buffer.concat(chunks)});
  });request.end();
 });
}
try{
 const trace=await get('https://app.fidyapp.com','/cdn-cgi/trace','origin',0);
 let traceBody=trace.body;
 if(trace.row.encoding==='br')traceBody=(await import('node:zlib')).brotliDecompressSync(traceBody);
 if(trace.row.encoding==='gzip')traceBody=(await import('node:zlib')).gunzipSync(traceBody);
 const values=Object.fromEntries(traceBody.toString().split('\n').map(x=>x.split('=')));
 state.origin={country:values.loc,edge:values.colo,note:'Country and edge observed by Cloudflare; no claim this represents a Colombian end-user connection'};
 const html=await get('https://app.fidyapp.com','/','discovery',0);
 let body=html.body;
 if(html.row.encoding==='br')body=(await import('node:zlib')).brotliDecompressSync(body);
 if(html.row.encoding==='gzip')body=(await import('node:zlib')).gunzipSync(body);
 const assets=[...body.toString().matchAll(/(?:src|href)="([^" ]+\.js)"/g)].map(x=>x[1]);
 const runtime=assets.find(x=>x.includes('shared-runtime'));
 const targets=[['https://api.fidyapp.com','/health'],['https://app.fidyapp.com','/'],...(runtime?[['https://app.fidyapp.com',runtime]]:[])];
 state.runtimeDiscovered=Boolean(runtime);
 for(let round=0;round<11;round++)for(const [origin,path]of round%2?[...targets].reverse():targets){await new Promise(r=>setTimeout(r,100));await get(origin,path,round===0?'first-observed':'reused-http2',round);}
 const med=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
 state.summary=targets.map(([origin,path])=>{const rows=state.samples.filter(r=>r.origin===origin&&r.path===path&&r.phase==='reused-http2');return {origin,path,n:rows.length,statuses:[...new Set(rows.map(r=>r.status))],medianHeaderMs:med(rows.map(r=>r.headerMs)),medianTotalMs:med(rows.map(r=>r.totalMs)),minMs:Math.min(...rows.map(r=>r.totalMs)),maxMs:Math.max(...rows.map(r=>r.totalMs)),bytes:med(rows.map(r=>r.bytes)),edges:[...new Set(rows.map(r=>r.edge))]};});
 console.log(JSON.stringify({origin:state.origin,summary:state.summary},null,2));
}finally{for(const s of sessions.values())s.close();writeFileSync(new URL('transport-results.json',root),JSON.stringify(state,null,2)+'\n');}
