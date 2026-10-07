import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, Schema } from "effect";
import { expect, it } from "vitest";
import { command } from "./production-fixture";

const project = process.cwd();
const fixture = `
import { Database } from 'bun:sqlite';
import { BunCrypto, BunFileSystem } from '${project}/node_modules/@effect/platform-bun/dist/index.js';
import { Effect, Layer, Schema } from '${project}/node_modules/effect/dist/index.js';
import { disposeBudget } from '${project}/scripts/mcp/production-cleanup.ts';
import { Scope } from '${project}/scripts/mcp/production-fixture.ts';
const db=new Database('fixture.sqlite');
db.exec("CREATE TABLE budgets(id TEXT,user_id TEXT,category_id TEXT,currency TEXT,cap TEXT);CREATE TABLE audit(operation TEXT);CREATE TABLE transactions(id TEXT);INSERT INTO budgets VALUES('30000000-0000-4000-8000-000000000001','99000000-2026-4000-8000-000000000001','10000000-0000-4000-8000-000000000007','COP','1000');INSERT INTO transactions VALUES('immutable-transaction');");
const scope=Schema.decodeUnknownSync(Scope)({approved:true,authorization:'isolated cleanup seam',approvedAt:'2026-10-07T00:00:00Z',namespace:'cleanup-test',fixtureUserId:'99000000-2026-4000-8000-000000000001',portfolio:'fixture',accountId:'a32350b6918ad7e78bc589b6630af1c2',databaseId:'2622d5b0-5e0f-4766-b836-ff0f635a92a6',revision:'63494fd4f7a915005a8f750547f4bb3548835e90',coreVersion:'2ef8ed24-1a98-4bcc-a083-533c433a803b',ingressVersion:'41ce2bf1-22e3-410f-926c-24fb2d65323f',workers:{core:'fixture',ingress:'fixture'},binaries:{claude:process.cwd()+'/client',codex:process.cwd()+'/client'},windowMinutes:30,maximumRequests:100});
Effect.runPromise(disposeBudget({scope,root:process.cwd()},'claude').pipe(Effect.provide(Layer.mergeAll(BunCrypto.layer,BunFileSystem.layer)))).then(()=>{console.log(JSON.stringify({budgets:db.query('SELECT count(*) count FROM budgets').get().count,acceptedAudit:db.query('SELECT count(*) count FROM audit').get().count,transactions:db.query('SELECT id FROM transactions').all(),creates:db.query("SELECT count(*) count FROM audit WHERE operation='create'").get().count}));db.close();},()=>{process.exitCode=1;db.close();});
`;
const wrangler = `import {Database} from 'bun:sqlite';const db=new Database('fixture.sqlite');const sql=process.argv[process.argv.indexOf('--command')+1];if(!sql.startsWith('SELECT '))process.exit(1);console.log(JSON.stringify([{success:true,results:db.query(sql).all(),meta:{changes:0}}]));db.close();`;
const client = `#!/usr/bin/env bun
import {Database} from 'bun:sqlite';
if(process.argv.includes('--version')){console.log('2.1.289 (Claude Code)');process.exit(0);}
process.stdin.setRawMode(true);
const endpoint=process.env.ANTHROPIC_BASE_URL+'/v1/messages';const tools=[{name:'mcp__fidy__deleteBudget'}];
const response=await fetch(endpoint,{method:'POST',body:JSON.stringify({tools,messages:[]})});const body=await response.text();if(!body.includes('deleteBudget')||!body.includes('30000000-0000-4000-8000-000000000001'))process.exit(1);
process.stdout.write('Confirmar la acción');await new Promise(resolve=>process.stdin.once('data',resolve));
const db=new Database('fixture.sqlite');db.transaction(()=>{db.exec("DELETE FROM budgets WHERE id='30000000-0000-4000-8000-000000000001';INSERT INTO audit VALUES('delete');");})();db.close();
await fetch(endpoint,{method:'POST',body:JSON.stringify({tools,messages:[{content:[{type:'tool_result',tool_use_id:'fixture_0',content:JSON.stringify({data:'30000000-0000-4000-8000-000000000001',next:[]})}]}]})});await Bun.sleep(1000);
`;
const Outcome = Schema.Struct({
  budgets: Schema.Finite,
  acceptedAudit: Schema.Finite,
  creates: Schema.Finite,
  transactions: Schema.Array(Schema.Struct({ id: Schema.String })),
});
it("recovers a committed Budget after lost creation delivery and confirms deletion without retrying creation", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-cleanup-seam-" });
        yield* fs.makeDirectory(`${root}/node_modules/wrangler/bin`, { recursive: true });
        yield* fs.writeFileString(`${root}/node_modules/wrangler/bin/wrangler.js`, wrangler);
        yield* fs.writeFileString(`${root}/client`, client, { mode: 0o700 });
        yield* fs.writeFileString(`${root}/fixture.ts`, fixture);
        expect(yield* fs.exists(`${root}/claude-budget-private.json`)).toBe(false);
        const output = yield* command(["bun", `${root}/fixture.ts`], root);
        expect(yield* Schema.decodeEffect(Schema.fromJsonString(Outcome))(output)).toEqual({
          budgets: 0,
          acceptedAudit: 1,
          creates: 0,
          transactions: [{ id: "immutable-transaction" }],
        });
        expect(yield* fs.exists(`${root}/claude-budget-private.json`)).toBe(true);
      })
    ).pipe(Effect.provide(BunFileSystem.layer))
  ));
