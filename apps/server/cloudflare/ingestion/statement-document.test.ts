import { Clock, Data, Effect, Exit, Option } from "effect";
import { deepStrictEqual } from "node:assert";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import type { HostedCanonicalCaller } from "../canonical-work/contract";
import { stageHeldStatementDocument, withHeldStatementDocumentUpload } from "./operations";
import { StatementStagingUnavailable } from "./internal/statement-staging";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}
const wait = <A>(run: () => Promise<A>): Effect.Effect<A, TestFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) });

it("refuses a held document at exact supplied Clock lease expiry before retaining bytes and releases its lease", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* wait(storage.acquire);
      yield* wait(() =>
        installTestSchema({
          db,
          sources: Array.from(
            new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
          )
            .sort()
            .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
        })
      );
      const current = yield* Clock.currentTimeMillis;
      const caller: HostedCanonicalCaller = {
        _tag: "HostedCanonical",
        userId: "10000000-0000-4000-8000-000000000001",
        sessionId: "session",
        turnId: "turn",
        authorizedOperation: Option.none(),
        originTurns: { sql: "SELECT 'turn' AS turn_id", params: [] },
        publicationOrigin: { sql: "SELECT 'turn' AS turn_id", params: [] },
        authority: {
          table: "hosted_turns",
          predicate: "id = ? AND status = 'pending'",
          bindings: ["turn"],
        },
      };
      yield* wait(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
            )
            .bind(caller.userId, current),
          db
            .prepare(
              "INSERT INTO onboarding_consent_records VALUES ('consent',?,'{}','disclosure','decision',1,1)"
            )
            .bind(caller.userId),
          db
            .prepare(
              "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status) VALUES ('session',?,'{}',?,'active')"
            )
            .bind(caller.userId, current),
          db
            .prepare(
              "INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,status) VALUES ('turn',?,'session',?,'pending')"
            )
            .bind(caller.userId, current),
          db
            .prepare(
              "INSERT INTO statement_whatsapp_documents(turn_id,user_id,media_id,created_at_ms) VALUES ('turn',?,'media',?)"
            )
            .bind(caller.userId, current),
        ])
      );
      const live = yield* Clock.Clock;
      const expiry = current + 600000;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => expiry,
        currentTimeMillis: Effect.succeed(expiry),
        currentTimeNanosUnsafe: () => BigInt(expiry) * 1000000n,
        currentTimeNanos: Effect.succeed(BigInt(expiry) * 1000000n),
        monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: live.monotonicTimeNanos,
        sleep: (duration) => live.sleep(duration),
      };
      const result = yield* Effect.exit(
        withHeldStatementDocumentUpload({
          db,
          caller,
          current,
          work: (grant) =>
            stageHeldStatementDocument({
              db,
              bucket,
              caller,
              current,
              grant,
              bytes: new TextEncoder().encode("Fecha,Descripcion,Valor\n2026-01-01,Mercado,1000\n"),
            }),
        }).pipe(Effect.provideService(Clock.Clock, clock))
      );
      deepStrictEqual(
        result,
        Exit.fail(new StatementStagingUnavailable({ reason: "authority_unavailable" }))
      );
      expect((yield* wait(() => bucket.list())).objects).toEqual([]);
      expect(
        yield* wait(() =>
          db
            .prepare(
              "SELECT released_at_epoch_ms FROM resource_admission_events WHERE policy_key='ingestion.upload.outstanding.v1'"
            )
            .first("released_at_epoch_ms")
        )
      ).toBe(expiry);
      expect(
        yield* wait(() =>
          db
            .prepare("SELECT upload_grant_id FROM statement_whatsapp_documents")
            .first("upload_grant_id")
        )
      ).toBeNull();
    })
  ));
