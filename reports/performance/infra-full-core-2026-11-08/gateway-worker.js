// Disposable transport control. Adds one service binding while retaining the full target Core.
export default {async fetch(request,env){
 if(!env.BENCH_TOKEN||request.headers.get('x-fidy-bench')!==env.BENCH_TOKEN||Date.now()>Number(env.PROBE_EXPIRES||0))return new Response(null,{status:404});
 const started=performance.now(),response=await env.CORE.fetch(request),headers=new Headers(response.headers);
 headers.set('x-probe-gateway-ms',String(performance.now()-started));
 return new Response(response.body,{status:response.status,headers});
}};
