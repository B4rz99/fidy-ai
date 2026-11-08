import {Effect} from 'effect';
import {BunServices} from '@effect/platform-bun';
import {WorkerBundle} from '../../../node_modules/alchemy/src/Cloudflare/Workers/Sources/Rolldown.ts';
const root=new URL('../../../',import.meta.url).pathname,here=new URL('./',import.meta.url).pathname;
const dirty=Bun.spawnSync(['git','diff','--name-only','HEAD','--','apps/server'],{cwd:root});
if(dirty.exitCode||dirty.stdout.toString().trim())throw Error('Application source must be clean');
const out=here+'core';
const result=await Effect.runPromise(Effect.gen(function*(){const builder=yield* WorkerBundle;return yield* builder.build({id:'infra-full-core-prototype',main:root+'apps/server/cloudflare/core-worker.ts',compatibility:{date:'2026-09-08',flags:['nodejs_compat']},entry:{kind:'external'},stack:{name:'infra-prototype-only',stage:'local'},extraOptions:{input:{resolve:{alias:{'~':root+'apps/server/src'}}},output:{dir:out}}});}).pipe(Effect.provide(BunServices.layer)));
const files=[];for(const f of result.files){const path=f.path.startsWith('/')?f.path:out+'/'+f.path;await Bun.write(path,f.content);files.push(path);}
for(const f of ['probe-worker.js','guard.js'])await Bun.write(out+'/'+f,await Bun.file(here+'harness/'+f).arrayBuffer());
await Bun.write(out+'/cost-plan.js','export default {};\n');
await Bun.write(here+'files.json',JSON.stringify(files));
const source=Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root}).stdout.toString().trim();
await Bun.write(here+'manifest.json',JSON.stringify({source,applicationSourceClean:true,localBuildOnly:true,files:files.length},null,2));console.log(JSON.stringify({source,files:files.length}));
