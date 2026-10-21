import { Data, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import {
  preparePATReviewAdmission,
  prepareResourceCounter,
  sweepPATReviewEvents,
  sweepPATSourceCounters,
} from "./operations";

class NativeFailure extends Data.TaggedError("NativeFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, NativeFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new NativeFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = "14330000-0000-4000-8000-000000000011";
const foreign = "14330000-0000-4000-8000-000000000012";
const legacySchema = [
  "CREATE TABLE pat_pairing_admission(source_digest BLOB PRIMARY KEY NOT NULL CHECK(length(source_digest)=32),window_start_ms INTEGER NOT NULL,started_count INTEGER NOT NULL CHECK(started_count BETWEEN 1 AND 20)) STRICT",
  "CREATE INDEX pat_pairing_admission_expiry ON pat_pairing_admission(window_start_ms)",
  "CREATE TABLE pat_review_attempts(id TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL REFERENCES web_sessions(id),occurred_at_ms INTEGER NOT NULL) STRICT",
  "CREATE INDEX pat_review_expiry ON pat_review_attempts(occurred_at_ms)",
  "CREATE INDEX pat_review_rate ON pat_review_attempts(session_id,occurred_at_ms)",
  `CREATE TRIGGER historical_pat_review_attempts_delete BEFORE DELETE ON pat_review_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM web_sessions p WHERE p.id=OLD.session_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='pat_review_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;`,
];
const legacySweep = (
  input: Readonly<{ db: D1Database; current: number; limit: number }>
): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(`DELETE FROM pat_pairing_admission WHERE source_digest IN(
  SELECT source_digest FROM pat_pairing_admission WHERE window_start_ms<=? ORDER BY window_start_ms LIMIT ?)`)
    .bind(input.current - 1_200_000, input.limit),
  input.db
    .prepare(`DELETE FROM pat_review_attempts WHERE id IN(
  SELECT id FROM pat_review_attempts WHERE occurred_at_ms<=? ORDER BY occurred_at_ms LIMIT ?)`)
    .bind(input.current - 1_200_000, input.limit),
];
const cost = (results: ReadonlyArray<D1Result>): Readonly<{ read: number; written: number }> => ({
  read: results.reduce((total, result) => total + result.meta.rows_read, 0),
  written: results.reduce((total, result) => total + result.meta.rows_written, 0),
});

const seedHistory = (db: D1Database): Effect.Effect<void, NativeFailure> =>
  Effect.gen(function* () {
    yield* native(() => db.batch(legacySchema.map((sql) => db.prepare(sql))));
    for (const [index, id] of [owner, foreign].entries()) {
      yield* native(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
            )
            .bind(id),
          db
            .prepare(
              "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,?,zeroblob(32),?,'consumed',0,600000)"
            )
            .bind(id, `BCDF-GHJ${index}`, id),
          db
            .prepare(
              "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,?,1,600001,2592000001,7776000001)"
            )
            .bind(id, id, id, new Uint8Array(32).fill(index + 1)),
        ])
      );
    }
    for (const [index, current] of [1_000_000, 1_000_000, 1_000_001, 2_000_000].entries()) {
      const userId = index === 2 ? foreign : owner;
      const source = new Uint8Array(32).fill(index);
      const reviewId = `review-${index}`;
      yield* native(() =>
        db.batch([
          db.prepare("INSERT INTO pat_pairing_admission VALUES(?,?,20)").bind(source, current),
          db
            .prepare("INSERT INTO pat_review_attempts VALUES(?,?,?)")
            .bind(reviewId, userId, current),
          prepareResourceCounter({
            db,
            kind: "pat_pairing_source",
            sourceDigest: source,
            current,
            subject: { sql: "SELECT 1", params: [] },
          }),
          db
            .prepare(
              "UPDATE resource_admission_counters SET used=20 WHERE policy_key='pat.pairing.source.v1' AND scope_key=lower(hex(?))"
            )
            .bind(source),
          ...preparePATReviewAdmission({
            db,
            id: reviewId,
            sessionId: userId,
            userId,
            current,
            eligible: { sql: "SELECT 1", params: [] },
          }),
        ])
      );
    }
    yield* native(() =>
      db.batch([
        db.prepare(
          "INSERT INTO resource_admission_events(grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,window_start_epoch_ms,expires_at_epoch_ms) VALUES('foreign','foreign-policy','operation','foreign-scope','rolling_window',1,1000000,400000,1600000)"
        ),
        db.prepare("INSERT INTO resource_admission_grants VALUES('foreign',1000000,1)"),
        prepareResourceCounter({
          db,
          kind: "email_pairing_global",
          current: 1_000_000,
          subject: { sql: "SELECT 1", params: [] },
        }),
      ])
    );
  });

const verifyRetainedHistory = (db: D1Database): Effect.Effect<void, NativeFailure> =>
  Effect.gen(function* () {
    expect(
      yield* native(() =>
        db
          .prepare(
            "SELECT owner_user_id,admitted_at_epoch_ms FROM resource_admission_events WHERE grant_id='review-2'"
          )
          .first()
      )
    ).toEqual({ owner_user_id: foreign, admitted_at_epoch_ms: 1000001 });
    expect(
      (yield* native(() =>
        db
          .prepare(
            "SELECT count(*) AS total FROM resource_admission_events WHERE policy_key='foreign-policy'"
          )
          .first()
      ))?.total
    ).toBe(1);
    expect(
      (yield* native(() =>
        db
          .prepare(
            "SELECT used FROM resource_admission_counters WHERE policy_key='email.pairing.global.v1'"
          )
          .first()
      ))?.used
    ).toBe(1);
    expect(
      (yield* native(() =>
        db
          .prepare(
            "SELECT count(*) AS total FROM resource_admission_grants WHERE id NOT IN(SELECT grant_id FROM resource_admission_events)"
          )
          .first()
      ))?.total
    ).toBe(0);
  });

it("bounds PAT cleanup at the original retention cutoff without deleting active or foreign usage", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* seedHistory(db);
      for (const scenario of [
        {
          current: 2_199_999,
          remaining: 4,
          previous: { source: { read: 2, written: 0 }, review: { read: 2, written: 0 } },
          shared: { source: { read: 2, written: 0 }, review: { read: 2, written: 0 } },
        },
        {
          current: 2_200_000,
          remaining: 3,
          previous: { source: { read: 4, written: 1 }, review: { read: 6, written: 1 } },
          shared: { source: { read: 5, written: 1 }, review: { read: 6, written: 2 } },
        },
      ]) {
        const { current } = scenario;
        const previous = yield* native(() => db.batch([...legacySweep({ db, current, limit: 1 })]));
        const source = sweepPATSourceCounters({ current, limit: 1 });
        const reviews = sweepPATReviewEvents({ current, limit: 1 });
        const shared = yield* native(() =>
          db.batch([source, reviews].map(({ sql, params }) => db.prepare(sql).bind(...params)))
        );
        expect({ source: cost(previous.slice(0, 1)), review: cost(previous.slice(1)) }).toEqual(
          scenario.previous
        );
        expect({ source: cost(shared.slice(0, 1)), review: cost(shared.slice(1)) }).toEqual(
          scenario.shared
        );
        expect(
          (yield* native(() =>
            db.prepare("SELECT count(*) AS total FROM pat_review_attempts").first()
          ))?.total
        ).toBe(scenario.remaining);
        expect(
          (yield* native(() =>
            db
              .prepare(
                "SELECT count(*) AS total FROM resource_admission_events WHERE policy_key='pat.review.session.v1'"
              )
              .first()
          ))?.total
        ).toBe(scenario.remaining);
        expect(
          (yield* native(() =>
            db.prepare("SELECT count(*) AS total FROM pat_pairing_admission").first()
          ))?.total
        ).toBe(scenario.remaining);
        expect(
          (yield* native(() =>
            db
              .prepare(
                "SELECT count(*) AS total FROM resource_admission_counters WHERE policy_key='pat.pairing.source.v1'"
              )
              .first()
          ))?.total
        ).toBe(scenario.remaining);
      }
      yield* verifyRetainedHistory(db);
    })
  ));
