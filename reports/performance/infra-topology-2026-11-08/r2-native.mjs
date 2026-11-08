import {Miniflare,convertV4MiniflareOptions}from'miniflare';
import {fileURLToPath}from'node:url';
import {readFileSync,writeFileSync}from'node:fs';
import {createHash}from'node:crypto';
const root=fileURLToPath(new URL('.',import.meta.url));
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:root+'r2-worker.js',compatibilityDate:'2026-09-08',bindings:{PROBE_TOKEN:'synthetic-local-only',PROBE_EXPIRES:String(Date.now()+3600000)},r2Buckets:{FENCE:'synthetic-fence'}}));
const state={passed:false,checks:[],digest:createHash('sha256').update(readFileSync(root+'r2-worker.js')).digest('hex')};
async function get(path,method='GET',expected=200,token='synthetic-local-only'){
 const response=await mf.dispatchFetch('https://probe'+path,{method,headers:{'x-probe-token':token}});const text=await response.text();
 if(response.status!==expected)throw Error('unexpected status '+response.status);return text;
}
try{
 await get('/read','GET',404,'wrong');state.checks.push('invalid token refuses work');
 await get('/read','GET',503);state.checks.push('missing generation refuses');
 await get('/seed','POST',204);
 if(JSON.parse(await get('/read')).generation!=='initial')throw Error('generation mismatch');state.checks.push('fresh generation read returns seeded value');
 await get('/cleanup','DELETE',204);await get('/read','GET',503);state.checks.push('cleanup removes private bytes');
 state.passed=true;console.log(JSON.stringify(state));
}finally{await mf.dispose();writeFileSync(root+'r2-native-results.json',JSON.stringify(state,null,2)+'\n');}
