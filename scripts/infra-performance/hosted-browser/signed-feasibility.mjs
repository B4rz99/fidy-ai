// Credential-free measurement branch. All requests remain inside the runner's local workerd.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { chromium } from "@playwright/test";

const sum = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sort = (v) => v === null || typeof v !== "object" ? v : Array.isArray(v) ? v.map(sort) : Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));
export async function runBrowser({variant, origins, cookie, expected, forward, afterRequest}) {
  const tls={ cert:Bun.file(process.env.BROWSER_TLS_CERT),key:Bun.file(process.env.BROWSER_TLS_KEY) };
  const dir=resolve(process.env.FIDY_DIAGNOSTIC_DIR);
  const events=[], snapshots={};
  const report = () => Bun.write(join(dir,variant+".json"),JSON.stringify({variant,events,snapshots},null,2));
  const controls = expected.data.map(w=>({id:"transaction-"+w.id,label:w.counterparty}));
  const assets=resolve(process.env[variant==="d1"?"D1_WEB_ASSETS":"NATIVE_WEB_ASSETS"]);
  const web=Bun.serve({hostname:"127.0.0.1",port:0,tls,fetch:async request=>{
    const u=new URL(request.url);
    if (request.method!=="GET"||u.origin!==origins.browser) return new Response(null,{status:403});
    const path=resolve(assets,"."+u.pathname);
    if(!path.startsWith(assets+sep))return new Response(null,{status:403});
    const file=Bun.file(u.pathname==="/app/transactions"?join(assets,"index.html"):path);
    return await file.exists()?new Response(file):new Response(null,{status:404});
  }});
  const api=Bun.serve({hostname:"127.0.0.1",port:0,tls,fetch:async request=>{
    const url=new URL(request.url);
    if(url.origin!==origins.api||request.headers.get("origin")!==origins.browser||!["GET","OPTIONS"].includes(request.method)||
       !["/web/session/binding","/ingestion/review-workspace","/transactions","/user"].includes(url.pathname))return new Response(null,{status:403});
    const key=request.method+" "+url.pathname+url.search;
    const response=await forward(request);
    const ev={route:key,status:response.status, origin:response.headers.get("access-control-allow-origin"),credentials:response.headers.get("access-control-allow-credentials"),hasCookie:request.headers.has("cookie"), hasBinding:request.headers.has("fidy-session-binding")};
    events.push(ev);
    const bytes=await response.arrayBuffer();
    if (response.ok&&request.method==="GET") {
      const data=JSON.parse(new TextDecoder().decode(bytes));
      const capture=(name,val)=>{snapshots[name]=Object.fromEntries(Object.entries(val??{}).map(([k,v])=>[k,sum(sort(v))]));};
      if(url.pathname==="/web/session/binding"&&url.search) {
        snapshots.contextTopLevel=Object.keys(data).sort();
        snapshots.initial=Object.keys(data.initial??{}).sort();
        assert.deepEqual(data.initial?.transactions?.page,expected);
      }
      if(url.pathname==="/user") capture("profile",data.data);
      if(url.pathname==="/transactions") assert.deepEqual(data,expected);
      if(url.pathname==="/ingestion/review-workspace") {capture("review",data); snapshots.reviewCount=data.pendingCount??data.data?.pendingCount;}
    }
    afterRequest?.(key,response,ev);
    await report();
    const headers=new Headers(response.headers);
    headers.delete("x-fidy-comparison-cost");
    return new Response(bytes.byteLength?bytes:null,{status:response.status,headers});
  }});
  let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.ASSESSMENT_CHROMIUM,env:{HOME:process.env.HOME,PATH:process.env.PATH},args:["--no-proxy-server","--ignore-certificate-errors-spki-list="+process.env.BROWSER_TLS_PIN,
      "--host-resolver-rules=MAP "+new URL(origins.api).hostname+":443 127.0.0.1:"+api.port+", MAP "+new URL(origins.browser).hostname+":443 127.0.0.1:"+web.port+", MAP * ~NOTFOUND, EXCLUDE localhost"]});
    const context=await browser.newContext({timezoneId:"America/Bogota",serviceWorkers:"block"});
    await context.addCookies([{name:"__Host-fidy_session",value:cookie.slice("__Host-fidy_session=".length),url:origins.api,httpOnly:true,secure:true,sameSite:"Lax"}]);
    const page=await context.newPage();
    const ready=()=>page.waitForFunction(rows=>{
      const controls=Array.from(document.querySelectorAll('button[data-transaction-slot="transaction-identity-control"]'));
      return controls.length===rows.length&&controls.every((el,i)=>el.id===rows[i].id&&el.matches(":enabled")&&el.getClientRects().length>0&&el.textContent.includes(rows[i].label));
    },controls,{timeout:12000});
    const counts=page.waitForResponse(r=>r.request().method()==="GET"&&new URL(r.url()).pathname==="/ingestion/review-workspace",{timeout:12000});
    await page.goto(origins.browser+"/app/transactions?month=2026-11",{waitUntil:"commit"});
    await Promise.all([ready(),counts]);
    events.push({stage:"startup",complete:true});
    for(let i=0;i<3;i++){
      const read=page.waitForResponse(r=>r.request().method()==="GET"&&new URL(r.url()).pathname==="/transactions");
      const profile=page.waitForResponse(r=>r.request().method()==="GET"&&new URL(r.url()).pathname==="/user");
      await page.getByRole("button",{name:"Actualizar transacciones",exact:true}).click();
      for(const res of await Promise.all([read,profile])){
        assert.equal(res.status(),200);
        await res.body();
      }
      await ready();
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      events.push({stage:"refresh",complete:true});
      await Bun.sleep(750);
    }
  } finally{
    await report();
    await browser?.close();await web.stop(true);await api.stop(true);
  }
}
