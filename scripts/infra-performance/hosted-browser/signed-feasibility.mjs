// Credential-free measurement branch. All requests remain inside the runner's local workerd.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";
import {mountCapturedTransactionHistory} from "../reference/fresh-transactions.mjs";

const sum = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sort = (v) => v === null || typeof v !== "object" ? v : Array.isArray(v) ? v.map(sort) : Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));
export async function runBrowser({variant, origins, cookie, expected, forward, afterRequest, observations=3, network="ordinary",encoding="gzip"}) {
  const tls={ cert:Bun.file(process.env.BROWSER_TLS_CERT),key:Bun.file(process.env.BROWSER_TLS_KEY) };
  const dir=resolve(process.env.FIDY_DIAGNOSTIC_DIR);
  const events=[], snapshots={};
  const assetsDelivered={rawBytes:0,encodedBytes:0,responses:0,gzip:0};
  const report = () => Bun.write(join(dir,variant+"-"+network+"-"+encoding+".json"),JSON.stringify({variant,network,events,snapshots,assetsDelivered},null,2));
  const controls = expected.data.map(w=>({id:"transaction-"+w.id,label:w.counterparty}));
  const assets=resolve(process.env[variant==="d1"?"D1_WEB_ASSETS":"NATIVE_WEB_ASSETS"]);
  const web=Bun.serve({hostname:"127.0.0.1",port:0,tls,fetch:async request=>{
    const u=new URL(request.url);
    if (request.method!=="GET"||u.origin!==origins.browser) return new Response(null,{status:403});
    const path=resolve(assets,"."+u.pathname);
    if(!path.startsWith(assets+sep))return new Response(null,{status:403});
    const file=Bun.file(u.pathname==="/app/transactions"?join(assets,"index.html"):path);
    if(!await file.exists())return new Response(null,{status:404});
    assetsDelivered.responses++;assetsDelivered.rawBytes+=file.size;
    if(encoding==="gzip"&&/(?:javascript|css|html)/.test(file.type)&&request.headers.get("accept-encoding")?.includes("gzip")){
      const bytes=Bun.gzipSync(await file.arrayBuffer());
      assetsDelivered.encodedBytes+=bytes.byteLength;assetsDelivered.gzip++;
      return new Response(bytes,{headers:{"content-type":file.type,"content-encoding":"gzip","vary":"accept-encoding"}});
    }
    assetsDelivered.encodedBytes+=file.size;return new Response(file);
  }});
  const api=Bun.serve({hostname:"127.0.0.1",port:0,tls,fetch:async request=>{
    const url=new URL(request.url);
    if(url.origin!==origins.api||request.headers.get("origin")!==origins.browser||!["GET","OPTIONS"].includes(request.method)||
       !["/web/session/binding","/web/consent","/ingestion/review-workspace","/transactions","/user"].includes(url.pathname)){
      events.push({rejected:request.method+" "+url.pathname,keys:[...url.searchParams.keys()]});await report();
      return new Response(null,{status:403});
    }
    const key=request.method+" "+url.pathname+url.search;
    const headersOut=new Headers(request.headers);
    for(const name of ["host","connection","content-length","accept-encoding","transfer-encoding"])headersOut.delete(name);
    const response=await forward(new Request(request.url,{headers:headersOut,method:request.method}));
    const ev={route:key,status:response.status, origin:response.headers.get("access-control-allow-origin"),credentials:response.headers.get("access-control-allow-credentials"),hasCookie:request.headers.has("cookie"), hasBinding:request.headers.has("fidy-session-binding")};
    events.push(ev);
    const bytes=await response.arrayBuffer();
    Object.assign(ev,{bodyBytes:bytes.byteLength,declaredBytes:response.headers.get("content-length"),upstreamEncoding:response.headers.get("content-encoding"),upstreamVary:response.headers.get("vary")});
    if (response.ok&&request.method==="GET") {
      const data=JSON.parse(new TextDecoder().decode(bytes));
      const capture=(name,val)=>{snapshots[name]=Object.fromEntries(Object.entries(val??{}).map(([k,v])=>[k,sum(sort(v))]));};
      if(url.pathname==="/web/session/binding"&&url.search) {
        snapshots.contextTopLevel=Object.keys(data).sort();
        snapshots.initial=Object.keys(data.initial??{}).sort();
        capture("initialFields",data.initial);
        assert.deepEqual(data.initial?.transactions?.page,expected);
      }
      if(url.pathname==="/web/consent")capture("freshConsent",data);
      if(url.pathname==="/user") {capture("profile",data.data);capture("profileEnvelope",data);}
      if(url.pathname==="/transactions") assert.deepEqual(data,expected);
      if(url.pathname==="/ingestion/review-workspace") {capture("review",data); snapshots.reviewCount=data.pendingCount??data.data?.pendingCount;}
    }
    afterRequest?.(key,response,ev);
    await report();
    const headers=new Headers(response.headers);
    headers.delete("x-fidy-comparison-cost");
    return new Response(bytes.byteLength?bytes:null,{status:response.status,headers});
  }});
  let browser, measuredPage;
  try{
    browser=await chromium.launch({executablePath:process.env.ASSESSMENT_CHROMIUM,env:{HOME:process.env.HOME,PATH:process.env.PATH},args:["--no-proxy-server","--ignore-certificate-errors-spki-list="+process.env.BROWSER_TLS_PIN,
      "--host-resolver-rules=MAP "+new URL(origins.api).hostname+":443 127.0.0.1:"+api.port+", MAP "+new URL(origins.browser).hostname+":443 127.0.0.1:"+web.port+", MAP * ~NOTFOUND, EXCLUDE localhost"]});
    const context=await browser.newContext({timezoneId:"America/Bogota",serviceWorkers:"block"});
    await context.addCookies([{name:"__Host-fidy_session",value:cookie.slice("__Host-fidy_session=".length),url:origins.api,httpOnly:true,secure:true,sameSite:"Lax"}]);
    const page=await context.newPage();measuredPage=page;
    if(network==="poor"){
      const cdp=await context.newCDPSession(page);
      await cdp.send("Network.enable");
      const active=new Map();
      cdp.on("Network.requestWillBeSent",r=>{
        const u=new URL(r.request.url);
        if(u.origin===origins.api&&u.pathname==="/web/session/binding")active.set(r.requestId,{path:u.pathname,context:u.searchParams.get("context"),start:r.timestamp});
      });
      cdp.on("Network.responseReceived",r=>{
        if(active.has(r.requestId))events.push({cdp:"response",...active.get(r.requestId),time:r.timestamp,status:r.response.status,protocol:r.response.protocol});
      });
      cdp.on("Network.loadingFailed",r=>{
        if(active.has(r.requestId))events.push({cdp:"failed",...active.get(r.requestId),time:r.timestamp,canceled:r.canceled,blockedReason:r.blockedReason??null,errorText:r.errorText,cors:r.corsErrorStatus?.corsError??null});
      });
      cdp.on("Network.loadingFinished",r=>{
        if(active.has(r.requestId))events.push({cdp:"complete",...active.get(r.requestId),time:r.timestamp,encoded:r.encodedDataLength});
      });
      await page.addInitScript(({origin})=>{
        const records=[]; window.__fidyDiagnostic=records;
        const fetch=window.fetch.bind(window), timeout=AbortSignal.timeout.bind(AbortSignal);
        AbortSignal.timeout=(ms)=>{
          const t=performance.now(),signal=timeout(ms);
          signal.addEventListener("abort",()=>records.push({type:"deadline",ms,elapsed:performance.now()-t,reason:signal.reason?.name}));
          return signal;
        };
        window.fetch=(input,init)=>{
          const url=new URL(input instanceof Request?input.url:String(input),location.href);
          if(url.origin!==origin||url.pathname!=="/web/session/binding")return fetch(input,init);
          const t=performance.now(), context=url.searchParams.get("context"), signal=init?.signal??(input instanceof Request?input.signal:null);
          const record=(type,extra={})=>records.push({type,context,t,elapsed:performance.now()-t,...extra});
          record("offered");
          signal?.addEventListener("abort",()=>record("signal",{reason:signal.reason?.name,aborted:signal.aborted}));
          const out=fetch(input,init);
          out.then(r=>record("headers",{status:r.status}),err=>record("rejected",{reason:err.name,aborted:signal?.aborted}));
          return out;
        };
      },{origin:origins.api});
      await cdp.send("Network.emulateNetworkConditions",{offline:false,latency:400,downloadThroughput:125000,uploadThroughput:125000});
    }
    page.on("requestfailed",r=>events.push({failed:r.method()+" "+new URL(r.url()).pathname,reason:r.failure()?.errorText}));
    page.on("pageerror",err=>events.push({pageError:err.name}));
    page.setDefaultTimeout(25000);
    const counts=page.waitForResponse(r=>r.request().method()==="GET"&&new URL(r.url()).pathname==="/ingestion/review-workspace");
    const observe=async r=>{assert.equal(r.status(),200);return JSON.parse((await r.body()).toString("utf8"));};
    const [mounted,review]=await Promise.all([mountCapturedTransactionHistory({page,ledger:origins.browser+"/app/transactions?month=2026-11",api:origins.api,observe,observeStartup:observe},expected),counts]);
    await observe(review);events.push({stage:"startup",complete:true});
    for(let i=0;i<observations;i++){
      const profile=page.waitForResponse(r=>r.request().method()==="GET"&&new URL(r.url()).pathname==="/user");
      const [,response]=await Promise.all([mounted.refresh(),profile]);await observe(response);
      events.push({stage:"refresh",complete:true});
      await Bun.sleep(750);
    }
  } catch(err) {
    events.push({stage:"incomplete", error:err.name, message: String(err.message).split("\n")[0].slice(0,100)});
    if(measuredPage)events.push(await measuredPage.evaluate(()=>({
      route:location.pathname,title:document.title,
      text:document.body.innerText.replace(/(?:[a-f0-9-]{20,}|[A-Za-z0-9_+/=-]{32,})/g,"[redacted]").slice(0,380),
      rowCount:document.querySelectorAll("[data-transaction-slot=transaction-identity-control]").length,
      resources:performance.getEntriesByType("resource").filter(r=>r.initiatorType==="fetch").map(r=>({path:new URL(r.name).pathname,complete:r.responseEnd>0,status:r.responseStatus})),
    })));
    throw err;
  } finally{
    if(measuredPage)events.push({browserSignals:await measuredPage.evaluate(()=>window.__fidyDiagnostic??[])});
    await report();
    await browser?.close();await web.stop(true);await api.stop(true);
  }
}
