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
 await response.text();
 if(step===0){const housekeeping=await fetch(endpoint,{method:'POST',body:JSON.stringify({model:'fixture-model',tools:[],messages:[{content:[]}]})});if(!housekeeping.ok)process.exit(1);if((await housekeeping.text()).includes('"tool_use"'))process.exit(1);
 const pending=await fetch(endpoint,{method:'POST',body:JSON.stringify({model:'fixture-model',tools:mode==='missing-tool'?[{name:'unrelated'}]:tools,messages:[{content:[]}]})});if(!pending.ok)process.exit(1);if((await pending.text()).includes('"tool_use"'))process.exit(1);}
 if(mode==='incomplete')process.exit(0);
 if(mode==='cancel'){
  process.stdout.write('Confirmar la acción');
  await new Promise(resolve=>process.stdin.once('data',resolve));
 }
 const result=mode==='cancel'?{isError:true,error:{code:'user_action_required'}}:mode==='wrong-refusal'?{isError:true,error:{code:'unavailable'}}:{isError:false,id:'30000000-0000-4000-8000-000000000001'};
 content.push({type:'tool_result',tool_use_id:'fixture_'+step,content:JSON.stringify(result)});
}
await fetch(endpoint,{method:'POST',body:JSON.stringify({model:'fixture-model',tools,messages:[{content}]})});
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
  it("keeps native login onboarding complete and answers separate startup approvals", () =>
    run(
      withClient("login-tools", ({ root, binary }) =>
        Effect.gen(function* () {
          yield* Effect.all([nativeLogin("claude", binary, root), callbackFixture(root)], {
            concurrency: 2,
          });
          const result = yield* nativeTools("claude", binary, root, "refresh", "synthetic-test");
          expect(result.passed).toBe(true);
        })
      )
    ));
  it("requires all journey results and retains the private Budget identity", () =>
    run(
      withClient("journey", ({ root, binary }) =>
        Effect.gen(function* () {
          const result = yield* nativeTools("claude", binary, root, "journey", "synthetic-test");
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
          const result = yield* nativeTools("claude", binary, root, "cancel", "synthetic-test");
          expect(result).toMatchObject({ passed: true, nativeFormAnswered: true, received: 1 });
        })
      )
    ));
  it.each(["incomplete", "wrong-refusal", "missing-tool"])(
    "rejects %s instead of claiming proof",
    (mode) =>
      run(
        withClient(mode, ({ root, binary }) =>
          Effect.gen(function* () {
            const phase: NativeMode = mode === "wrong-refusal" ? "headless" : "refresh";
            const result = yield* Effect.result(
              nativeTools("claude", binary, root, phase, "synthetic-test")
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
              nativeTools("claude", binary, root, "refresh", "synthetic-test")
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
