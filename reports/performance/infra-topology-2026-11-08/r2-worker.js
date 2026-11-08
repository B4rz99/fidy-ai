// THROWAWAY bounded-lifetime R2-only placement probe. Never bind production resources.
export default {async fetch(request,env){
 if(!env.PROBE_TOKEN||request.headers.get('x-probe-token')!==env.PROBE_TOKEN||Date.now()>Number(env.PROBE_EXPIRES))return new Response(null,{status:404});
 const path=new URL(request.url).pathname;
 if(path==='/seed'&&request.method==='POST'){await env.FENCE.put('recovery/generation','initial');return new Response(null,{status:204});}
 if(path==='/cleanup'&&request.method==='DELETE'){await env.FENCE.delete('recovery/generation');return new Response(null,{status:204});}
 if(path==='/health')return Response.json({ready:true},{headers:{'cache-control':'no-store'}});
 if(path!=='/read'||request.method!=='GET')return new Response(null,{status:404});
 const start=performance.now(),object=await env.FENCE.get('recovery/generation');
 if(!object||object.size>64)return new Response(null,{status:503});
 const value=await object.text();
 if(value!=='initial')return new Response(null,{status:503});
 return Response.json({generation:value},{headers:{'cache-control':'no-store','x-probe-authority-ms':String(performance.now()-start)}});
}};
