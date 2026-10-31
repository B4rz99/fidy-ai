import { Data, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { preparePATReviewAdmission, prepareResourceCounter } from "./operations";

class NativeFailure extends Data.TaggedError("NativeFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, NativeFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new NativeFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = "14330000-0000-4000-8000-000000000001";
const review = "14330000-0000-4000-8000-000000000002";
const verifyAdmission = (db: D1Database): Effect.Effect<void, NativeFailure> =>
  Effect.gen(function* () {
    const source = (current: number): Promise<D1Result> =>
      prepareResourceCounter({
        db,
        kind: "pat_pairing_source",
        sourceDigest: new Uint8Array(32),
        current,
        subject: { sql: "SELECT 1", params: [] },
      }).run();
    expect((yield* native(() => source(1599999))).meta.changes).toBe(0);
    expect((yield* native(() => source(1600000))).meta.changes).toBe(1);
    const attempts = Array.from({ length: 10 }, (_, index) =>
      preparePATReviewAdmission({
        db,
        id: `next-${index}`,
        userId: owner,
        sessionId: owner,
        current: 1599999,
        eligible: { sql: "SELECT 1", params: [] },
      })
    );
    for (const prepared of attempts.slice(0, 9)) {
      expect((yield* native(() => db.batch([...prepared])))[1]?.meta.changes).toBe(1);
    }
    expect((yield* native(() => db.batch([...(attempts[9] ?? [])])))[1]?.meta.changes).toBe(0);
    expect(
      (yield* native(() =>
        db.batch([
          ...preparePATReviewAdmission({
            db,
            id: "at-boundary",
            userId: owner,
            sessionId: owner,
            current: 1600000,
            eligible: { sql: "SELECT 1", params: [] },
          }),
        ])
      ))[1]?.meta.changes
    ).toBe(1);
    expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
  });

it("renews PAT source and review capacity at the exact window boundary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
            )
            .bind(owner),
          db
            .prepare(
              "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,'BCDF-GHJK',zeroblob(32),?,'consumed',0,600000)"
            )
            .bind(owner, owner),
          db
            .prepare(
              "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,zeroblob(32),1,600001,2592000001,7776000001)"
            )
            .bind(owner, owner, owner),
          db.prepare(
            "INSERT INTO resource_admission_counters(policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used) VALUES('pat.pairing.source.v1',lower(hex(zeroblob(32))),'anchored',1000000,1600000,20)"
          ),
          ...preparePATReviewAdmission({
            db,
            id: review,
            userId: owner,
            sessionId: owner,
            current: 1000000,
            eligible: { sql: "SELECT 1", params: [] },
          }),
        ])
      );
      yield* verifyAdmission(db);
    })
  ));
