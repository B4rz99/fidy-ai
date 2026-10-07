import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import { join } from "node:path";
import {
  type Crypto,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";
import { type NativeMode, nativeLogin, nativeTools } from "./production-native";

const processAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.try({
    try: () => {
      process.kill(pid, 0);
      return true;
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false));
const readinessAttempts = 20;
const readinessDelay = 100;
const decodePid = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Int));
const executableMode = 0o700;
const fakeClient = `#!/usr/bin/env bun
if (process.argv.includes('--version')) {console.log('2.1.289 (Claude Code)');process.exit(0);}
const mode=await Bun.file(process.cwd()+'/mock-mode.json').json();
process.stdin.setRawMode(true);
if(mode==='login-tools'){
 const config=await Bun.file(process.env.CLAUDE_CONFIG_DIR+'/.claude.json').json();
 if(config.theme!=='dark'||config.hasCompletedOnboarding!==true)process.exit(1);
 if(process.argv.includes('login')){process.stdout.write('https://api.fidyapp.com/oauth/authorize?fixture=synthetic');await new Promise(resolve=>process.stdin.once('data',resolve));config.theme='light';config.hasCompletedOnboarding=false;config.projects={};config.fixtureOAuthPreserved=true;await Bun.write(process.env.CLAUDE_CONFIG_DIR+'/.claude.json',JSON.stringify(config));process.exit(0);}
 if(config.fixtureOAuthPreserved!==true)process.exit(1);
 process.stdout.write('Do you want to use this API key?');
 await new Promise(resolve=>process.stdin.once('data',resolve));
 process.stdout.write('Allow the fidy MCP server');
 await new Promise(resolve=>process.stdin.once('data',resolve));
}
if(mode==='hang'){await Bun.write(process.cwd()+'/child-pid.json',String(process.pid)); await new Promise(()=>{}); }
const endpoint=process.env.ANTHROPIC_BASE_URL+'/v1/messages';
const tools=['listCategories','createBudget','executeAtomicBatch','deleteBudget'].map(name=>({name:'mcp__fidy__'+name}));
const probe=await fetch(endpoint.replace('/v1/messages','/api/hello'),{method:'POST'});
if(probe.status!==404)process.exit(1);
for(const method of ['HEAD','OPTIONS']){const probe=await fetch(endpoint,{method});if(probe.status!==204)process.exit(1);}
const content=[];
const count=mode==='journey'?3:1;
for(let step=0;step<count;step++){
 const response=await fetch(endpoint,{method:'POST',body:JSON.stringify({model:'fixture-model',tools,messages:[{content}]})});
 if(!response.ok)process.exit(1);
 const events=await response.text();
 if(step===0){const housekeeping=await fetch(endpoint,{method:'POST',body:JSON.stringify({model:'fixture-model',tools:[],messages:[{content:[]}]})});if(!housekeeping.ok)process.exit(1);if((await housekeeping.text()).includes('"tool_use"'))process.exit(1);
 const pending=await fetch(endpoint,{method:'POST',body:JSON.stringify({model:'fixture-model',tools:mode==='missing-tool'?[{name:'unrelated'}]:tools,messages:[{content:[]}]})});if(!pending.ok)process.exit(1);if((await pending.text()).includes('"tool_use"'))process.exit(1);}
 if(mode==='incomplete')process.exit(0);
 if(mode==='cancel'){
  process.stdout.write('Confirmar la acción');
  await new Promise(resolve=>process.stdin.once('data',resolve));
 }
 const stamp='2026-10-07T00:00:00.000Z';const id='30000000-0000-4000-8000-000000000001';
 const args=events.split('\\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(event=>event.delta?.partial_json)?.delta.partial_json;
 const calls=args?JSON.parse(args).payload?.calls:undefined;
 const transaction={id,money:{amount:'15000',currency:'COP'},direction:'outflow',categoryId:'10000000-0000-4000-8000-000000000006',occurredAt:stamp,createdAt:stamp,revision:0};
 const success=mode==='journey'&&step===1?{data:{id,categoryId:'10000000-0000-4000-8000-000000000007',cap:{amount:'1000',currency:'COP'},createdAt:stamp,updatedAt:stamp},next:[]}:mode==='journey'&&step===2?{data:{results:calls.map(call=>({callId:call.callId,operation:call.operation,output:{data:transaction,next:[]}}))},next:[]}:{data:[],next:[]};
 const result=mode==='cancel'?{isError:true,error:{code:'user_action_required',message:'Confirmation required.'},next:[]}:mode==='wrong-refusal'?{isError:true,error:{code:'unavailable',message:'Unavailable.'},next:[]}:success;
 content.push({type:'tool_result',tool_use_id:'fixture_'+step,content:mode==='malformed'?'not valid JSON':JSON.stringify(result)});
}
await fetch(endpoint,{method:'POST',body:JSON.stringify({model:'fixture-model',tools,messages:[{content}]})});
await Bun.sleep(1000);
`;
const fakeCodex = `#!/usr/bin/env bun
if(process.argv.includes('--version')){console.log('codex-cli 0.160.0');process.exit(0);}
if(process.argv.includes('app-server')){if(process.argv.includes('version'))console.log(JSON.stringify({managedCodexPath:process.env.CODEX_HOME+'/owned/codex',appServerVersion:'0.160.0'}));process.exit(0);}
const config=await Bun.file(process.env.CODEX_HOME+'/config.toml').text();
const endpoint=config.match(/base_url="([^"]+)"/)[1]+'/responses';
const required=config.includes('[mcp_servers.fidy]\\nrequired=true\\n');
const tools=required?[{type:'namespace',name:'mcp__fidy',tools:[{type:'function',name:'listCategories'}]}]:[{type:'function',name:'unrelated'}];
await Bun.sleep(1100);
const response=await fetch(endpoint,{method:'POST',body:JSON.stringify({tools,input:[]})});
const body=await response.text();
if(!required||!body.includes('function_call'))process.exit(1);
await fetch(endpoint,{method:'POST',body:JSON.stringify({tools,input:[{type:'function_call_output',call_id:'fixture_0',output:JSON.stringify({data:[],next:[]})}]})});
await Bun.sleep(1000);
`;
const decodeBudget = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const withClient = <A, E>(
  mode: string,
  use: (
    input: Readonly<{ root: string; binary: string }>
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Crypto.Crypto>
): Effect.Effect<A, PlatformError.PlatformError | E, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-native-proof-" });
      const binary = join(root, "claude");
      yield* fs.writeFileString(binary, fakeClient, { mode: executableMode });
      yield* fs.writeFileString(join(root, "mock-mode.json"), stringify(mode));
      yield* fs.writeFileString(
        join(root, "claude-budget-private.json"),
        stringify({ id: "30000000-0000-4000-8000-000000000001" })
      );
      return yield* use({ root, binary });
    })
  );
const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Crypto.Crypto>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunCrypto.layer)))
  );
const callbackFixture = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const authorization = join(root, "claude-authorize-url.txt");
  for (let attempt = 0; attempt < readinessAttempts; attempt++) {
    if (yield* fs.exists(authorization)) break;
    yield* Effect.sleep(readinessDelay);
  }
  expect(yield* fs.exists(authorization)).toBe(true);
  yield* fs.writeFileString(
    join(root, "claude-callback-url.txt"),
    "http://localhost/fixture-callback"
  );
});
describe("isolated native MCP proof boundary", () => {
  it("requires Fidy before the first Codex model catalog despite delayed startup", () =>
    run(
      withClient("codex-required", ({ root, binary }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(join(root, "codex-profile"));
          yield* fs.writeFileString(binary, fakeCodex, { mode: executableMode });
          const result = yield* nativeTools({
            host: "codex",
            binary,
            root,
            mode: "refresh",
            namespace: "synthetic-test",
            mcpUrl: Option.none(),
          });
          expect(result).toMatchObject({ passed: true, expected: 1, received: 1 });
        })
      )
    ));
  it("keeps native login onboarding complete and answers separate startup approvals", () =>
    run(
      withClient("login-tools", ({ root, binary }) =>
        Effect.gen(function* () {
          yield* Effect.all(
            [nativeLogin({ host: "claude", binary, root }), callbackFixture(root)],
            {
              concurrency: 2,
            }
          );
          const result = yield* nativeTools({
            host: "claude",
            binary,
            root,
            mode: "refresh",
            namespace: "synthetic-test",
            mcpUrl: Option.none(),
          });
          expect(result.passed).toBe(true);
        })
      )
    ));
  it("requires all journey results and retains the private Budget identity", () =>
    run(
      withClient("journey", ({ root, binary }) =>
        Effect.gen(function* () {
          const result = yield* nativeTools({
            host: "claude",
            binary,
            root,
            mode: "journey",
            namespace: "synthetic-test",
            mcpUrl: Option.none(),
          });
          expect(result).toMatchObject({ passed: true, expected: 3, received: 3 });
          const fs = yield* FileSystem.FileSystem;
          const budget = yield* fs.readFileString(join(root, "claude-budget-private.json"));
          expect(decodeBudget(budget)).toEqual({ id: "30000000-0000-4000-8000-000000000001" });
        })
      )
    ));
  it("accepts cancellation only with user_action_required", () =>
    run(
      withClient("cancel", ({ root, binary }) =>
        Effect.gen(function* () {
          const result = yield* nativeTools({
            host: "claude",
            binary,
            root,
            mode: "cancel",
            namespace: "synthetic-test",
            mcpUrl: Option.none(),
          });
          expect(result).toMatchObject({ passed: true, nativeFormAnswered: true, received: 1 });
        })
      )
    ));
  it.each(["incomplete", "wrong-refusal", "missing-tool", "malformed"])(
    "rejects %s instead of claiming proof",
    (mode) =>
      run(
        withClient(mode, ({ root, binary }) =>
          Effect.gen(function* () {
            const phase: NativeMode = mode === "wrong-refusal" ? "headless" : "refresh";
            const result = yield* Effect.result(
              nativeTools({
                host: "claude",
                binary,
                root,
                mode: phase,
                namespace: "synthetic-test",
                mcpUrl: Option.none(),
              })
            );
            expect(result._tag).toBe("Failure");
            if (mode === "wrong-refusal" && result._tag === "Failure") {
              expect(Option.getOrThrow(result.failure.diagnostics)).toMatchObject({
                requested: 1,
                received: 1,
                invoked: 1,
                resultsValid: false,
                formValid: true,
                failedTool: "deleteBudget",
                nextTool: "none",
                errorCode: "unavailable",
              });
            }
          })
        )
      )
  );
  it("stops the owned native process when verification is interrupted", () =>
    run(
      withClient("hang", ({ root, binary }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const fiber = yield* Effect.forkScoped(
              nativeTools({
                host: "claude",
                binary,
                root,
                mode: "refresh",
                namespace: "synthetic-test",
                mcpUrl: Option.none(),
              })
            );
            const path = join(root, "child-pid.json");
            for (let attempt = 0; attempt < readinessAttempts; attempt++) {
              if (yield* fs.exists(path)) break;
              yield* Effect.sleep(readinessDelay);
            }
            const pid = decodePid(yield* fs.readFileString(path));
            yield* Fiber.interrupt(fiber);
            const alive = yield* processAlive(pid);
            expect(alive).toBe(false);
          })
        )
      )
    ));
});
