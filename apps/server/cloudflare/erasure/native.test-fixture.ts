import { coordinatorTestDatabase } from "../d1-test-fixture";
import { Effect, FileSystem, type Scope } from "effect";
import { Miniflare } from "miniflare";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";

const noContentStatus = 204;
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
type NativeBindings = Readonly<{
  db: D1Database;
  snapshot: D1Database;
  originals: R2Bucket;
  registry: R2Bucket;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>;
const build = (): Effect.Effect<string> =>
  Effect.gen(function* () {
    const result = yield* wait(() =>
      Bun.build({
        entrypoints: [new URL("../coordinator-test-harness.ts", import.meta.url).pathname],
        target: "browser",
        external: ["cloudflare:workers"],
      })
    );
    const output = result.outputs[0];
    if (!result.success || output === undefined) {
      return yield* Effect.die(new Error("Native erasure fixture build failed"));
    }
    return yield* wait(() => output.text());
  });
const create = (
  input: Readonly<{ directory: string; module: string; restored: boolean }>
): Miniflare =>
  new Miniflare({
    resourcePersistencePath: input.directory,
    workers: [
      {
        config: {
          name: "titular-erasure",
          type: "worker",
          compatibilityDate: "2026-09-08",
          exports: { UserTransactionCoordinator: { type: "durable-object", storage: "sqlite" } },
          env: {
            DB: { type: "d1", id: input.restored === true ? "titular-before" : "titular-erasure" },
            SNAPSHOT_DB: { type: "d1", id: "titular-before" },
            EMAIL_BUCKET: { type: "r2", name: "erasure-originals" },
            STATEMENT_STAGING_BUCKET: { type: "r2", name: "erasure-originals" },
            ERASURE_BUCKET: { type: "r2", name: "erasure-registry" },
            ERASURE_REQUIRED: { type: "text", value: "true" },
            USER_TRANSACTION_COORDINATOR: {
              type: "durable-object",
              worker: "titular-erasure",
              exportName: "UserTransactionCoordinator",
            },
            AI: { type: "json", value: { run: null } },
            HOSTED_AI_MODEL: { type: "text", value: approvedWorkersAiModel },
          },
          manifest: {
            mainModule: "index.mjs",
            modules: { "index.mjs": { type: "esm", contents: input.module } },
          },
        },
      },
    ],
  });
const bindings = (runtime: Miniflare): Promise<NativeBindings> =>
  Promise.all([
    coordinatorTestDatabase({ runtime, binding: "DB" }),
    coordinatorTestDatabase({ runtime, binding: "SNAPSHOT_DB" }),
    runtime.getBindings<{ EMAIL_BUCKET: R2Bucket; ERASURE_BUCKET: R2Bucket }>(),
    runtime.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR"),
  ]).then(([db, snapshot, buckets, namespace]) => ({
    db,
    snapshot,
    originals: buckets.EMAIL_BUCKET,
    registry: buckets.ERASURE_BUCKET,
    coordinator: {
      getByName: (name): Pick<Fetcher, "fetch"> => ({
        fetch: (input, init) => {
          const request = new Request(input, init);
          return request.text().then((body) =>
            namespace
              .getByName(name)
              .fetch(request.url, {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                body,
              })
              .then(replayNativeResponse)
          );
        },
      }),
    },
  }));

export const nativeErasurePlatform: Effect.Effect<
  Readonly<{
    acquire: () => Promise<NativeBindings>;
    advanceClock: (milliseconds: number) => Promise<void>;
    restart: () => Promise<NativeBindings>;
    restoreSnapshot: () => Promise<NativeBindings>;
    restoreLive: () => Promise<NativeBindings>;
  }>,
  never,
  FileSystem.FileSystem | Scope.Scope
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectory({ prefix: "fidy-erasure-" }).pipe(Effect.orDie);
  const module = yield* build();
  let restored = false;
  let runtime = create({ directory, module, restored });
  const initial = yield* wait(() => bindings(runtime));
  yield* wait(() => initial.registry.put("recovery/generation", "initial"));
  yield* Effect.addFinalizer(() =>
    wait(() => runtime.dispose()).pipe(
      Effect.ensuring(fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie))
    )
  );
  const replace = (next: boolean): Promise<NativeBindings> =>
    runtime.dispose().then(() => {
      restored = next;
      runtime = create({ directory, module, restored });
      return bindings(runtime);
    });
  return {
    acquire: () => bindings(runtime),
    advanceClock: (milliseconds) =>
      runtime
        .dispatchFetch("http://fixture/__fixture/clock", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ milliseconds }),
        })
        .then((response) => {
          if (response.status !== noContentStatus) {
            throw new Error("Native fixture clock advance failed");
          }
        }),
    restoreSnapshot: () => replace(true),
    restoreLive: () => replace(false),
    restart: () => replace(restored),
  };
});

const replayNativeResponse = (
  response: Readonly<{
    arrayBuffer: () => Promise<ArrayBuffer>;
    status: number;
    headers: Iterable<readonly [string, string]>;
  }>
): Promise<Response> =>
  response.arrayBuffer().then(
    (bytes) =>
      new Response(new Uint8Array(bytes), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      })
  );

const proofByteCount = 32;
const shortCodeLength = 8;
const freshnessMilliseconds = 600000;
const sessionLifetimeMilliseconds = 7776000000;
type PersonalSeed = Readonly<{ db: D1Database; userId: string; current: number; index: number }>;
export const seedPersonalClasses = (input: PersonalSeed): Effect.Effect<void> =>
  wait(() =>
    input.db
      .batch([
        ...identityRows(input),
        ...conversationRows(input),
        ...projectionRows(input),
        ...credentialRows(input),
        ...renewalAndPlanRows(input),
      ])
      .then(() => undefined)
  );
const identityRows = (input: PersonalSeed): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(
      "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES(?,'test-portfolio',?,?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
    )
    .bind(input.userId, `subject-${input.index}`, input.current),

  input.db.prepare(
    "INSERT INTO categories VALUES('erasure-category','Prueba',100) ON CONFLICT(id) DO NOTHING"
  ),

  input.db
    .prepare(
      "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at,created_at) VALUES(?,?,'12000','COP','outflow','erasure-category','2026-10-15T12:00:00.000Z','2026-10-15T12:00:00.000Z')"
    )
    .bind(input.userId, input.userId),

  input.db
    .prepare(
      "INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at) VALUES(?,?,?,'manual','CO','es-CO','America/Bogota','test','2026-10-15T12:00:00.000Z')"
    )
    .bind(input.userId, input.userId, input.userId),

  input.db
    .prepare(
      "INSERT INTO pats(id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) VALUES(?,?,?,?,?,'[]',7,?,?,?,?)"
    )
    .bind(
      input.userId,
      input.userId,
      input.userId.slice(-shortCodeLength),
      new Uint8Array(proofByteCount).fill(input.index + 1),
      "Prueba",
      input.current,
      input.current,
      input.current + freshnessMilliseconds,
      input.userId
    ),
];
const conversationRows = (input: PersonalSeed): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(
      "INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,'{}','test-disclosure','test-decision',?,?)"
    )
    .bind(input.userId, input.userId, input.current, input.current),

  input.db
    .prepare(
      "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,last_activity_at_ms,status) VALUES(?,?,'{}',?,?,'idle-ended')"
    )
    .bind(input.userId, input.userId, input.current, input.current),

  input.db
    .prepare(
      "INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status) VALUES(?,?,?,?,NULL,'pending')"
    )
    .bind(input.userId, input.userId, input.userId, input.current),

  input.db
    .prepare(
      "INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text) VALUES(?,?,?,?,'user',?,'Mensaje privado')"
    )
    .bind(input.userId, input.userId, input.userId, input.userId, input.current),

  input.db
    .prepare(
      "INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms) VALUES(?,?,?,?,'interrupted',?)"
    )
    .bind(`2274${input.userId.slice(4)}`, input.userId, input.userId, input.userId, input.current),
  input.db
    .prepare(
      "UPDATE hosted_turns SET status='interrupted',terminal_at_ms=? WHERE id=? AND user_id=?"
    )
    .bind(input.current, input.userId, input.userId),
];
const projectionRows = (input: PersonalSeed): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(
      "INSERT INTO recurring_series(user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid) VALUES(?,?,'COP','private-merchant','{}','{}','{}',1)"
    )
    .bind(input.userId, input.userId),

  input.db
    .prepare(
      "INSERT INTO user_documents (kind,user_id,document_json,revision) VALUES('dashboard',?,'{}',1) ON CONFLICT(user_id,kind) DO NOTHING"
    )
    .bind(input.userId),

  input.db
    .prepare(
      "INSERT INTO schedules(kind,id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id) VALUES('weekly',?,?,1,0,'{}','2026-11-01T12:00:00.000Z',?)"
    )
    .bind(input.userId, input.userId, input.userId),

  input.db
    .prepare(
      "UPDATE users SET subscription_id=incoming.id FROM (SELECT ? AS user_id,? AS id) AS incoming WHERE users.id=incoming.user_id AND users.subscription_id IS NULL"
    )
    .bind(input.userId, input.userId),

  input.db
    .prepare(
      "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,?,?,?,'consumed',?,?)"
    )
    .bind(
      input.userId,
      input.index === 0 ? "AAAA-AAAA" : "BBBB-BBBB",
      new Uint8Array(proofByteCount).fill(input.index + 1),
      input.userId,
      input.current,
      input.current + freshnessMilliseconds
    ),
];
const credentialRows = (input: PersonalSeed): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare("INSERT INTO verified_email_credentials(user_id,address,verified_at_ms) VALUES(?,?,?)")
    .bind(input.userId, `person${input.index}@example.test`, input.current),
  input.db
    .prepare(
      "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,?,?,?,?,?)"
    )
    .bind(
      input.userId,
      input.userId,
      input.userId,
      new Uint8Array(proofByteCount).fill(input.index + 1),
      input.current,
      input.current + freshnessMilliseconds,
      input.current + freshnessMilliseconds,
      input.current + sessionLifetimeMilliseconds
    ),

  input.db
    .prepare(
      "INSERT INTO audit_entries(record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES ('session_call',?,?,?,'memory.remember','success',?)"
    )
    .bind(input.userId, input.userId, input.userId, input.current),
];

const renewalAndPlanRows = (input: PersonalSeed): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(
      "INSERT INTO user_documents (kind,user_id,document_json,revision) VALUES('recurring-plan',?, json_object('revision',1,'private','User expectation'), 1)"
    )
    .bind(input.userId),
  input.db
    .prepare(
      "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES('processing_withdrawal',?,?,?,?,?)"
    )
    .bind(input.userId, input.userId, input.userId, input.userId, input.current),
  input.db
    .prepare(
      "INSERT INTO consent_history (record_type,id,user_id,withdrawal_id,grant_record_id,session_id,disclosure_json,occurred_at_ms) VALUES ('processing_renewal',?,?,?,?,?,'{}',?)"
    )
    .bind(input.userId, input.userId, input.userId, input.userId, input.userId, input.current + 1),
];
