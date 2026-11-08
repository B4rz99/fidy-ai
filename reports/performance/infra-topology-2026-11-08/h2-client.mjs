// Sequential bounded HTTP/2 probe transport. Inputs/results stay on private parent pipes.
import http2 from 'node:http2';
import readline from 'node:readline';
const sessions=new Map();
const close=()=>{for(const session of sessions.values())session.destroy();sessions.clear();};
process.once('SIGTERM',()=>{close();process.exit(0);});
async function request(input){
 const started=performance.now();let session=sessions.get(input.origin);const reused=!!session;
 if(!session){session=http2.connect(input.origin,{settings:{enablePush:false}});session.on('error',()=>{});sessions.set(input.origin,session);}
 if(session.destroyed||session.closed)throw Error('Closed session; no retry');
 return new Promise((resolve,reject)=>{
  const stream=session.request({':method':input.method,':path':input.path,...input.headers});let headers,chunks=[],bytes=0,ended=false;const timer=setTimeout(()=>stream.destroy(Error('Deadline')),30000);
  const fail=()=>{if(ended)return;ended=true;clearTimeout(timer);reject(Error('Uncertain transport; no retry'));};
  stream.on('response',value=>{headers=value;});stream.on('error',fail);stream.on('aborted',fail);
  stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576)stream.destroy(Error('Bound exceeded'));else chunks.push(chunk);});
  stream.on('end',()=>{if(ended)return;ended=true;clearTimeout(timer);if(!headers||session.alpnProtocol!=='h2'){reject(Error('HTTP/2 not established'));return;}resolve({headers,status:headers[':status'],body:Buffer.concat(chunks).toString('base64'),elapsedMs:performance.now()-started,protocol:'h2',reused});});
  stream.end(input.body??undefined);
 });
}
try{for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){try{const result=await request(JSON.parse(line));process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stdout.write(JSON.stringify({failed:true})+'\n');break;}}}finally{close();}
