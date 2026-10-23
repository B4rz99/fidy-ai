import { installHistoricalErasureChunk } from "../schema-cutover.test-fixture";
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
const originalSchema = `CREATE TABLE resource_admission_counters (
  policy_key TEXT NOT NULL CHECK(policy_key IN (
    'email.pairing.user.v1','email.pairing.global.v1','email.replacement.user.v1'
  )),
  scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 256),
  window_kind TEXT NOT NULL CHECK(window_kind='anchored'),
  window_start_ms INTEGER NOT NULL,
  window_ends_ms INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK(used BETWEEN 1 AND CASE policy_key
    WHEN 'email.pairing.global.v1' THEN 1000 ELSE 5 END),
  last_work_id TEXT CHECK(last_work_id IS NULL OR length(last_work_id)=36),
  owner_user_id TEXT REFERENCES users(id),
  CHECK(window_ends_ms=window_start_ms+CASE policy_key
    WHEN 'email.replacement.user.v1' THEN 86400000 ELSE 3600000 END),
  CHECK((policy_key='email.pairing.global.v1' AND scope_key='global' AND owner_user_id IS NULL)
    OR (policy_key IN ('email.pairing.user.v1','email.replacement.user.v1')
      AND owner_user_id IS NOT NULL AND scope_key=owner_user_id)),
  CHECK((policy_key='email.replacement.user.v1' AND last_work_id IS NOT NULL)
    OR (policy_key<>'email.replacement.user.v1' AND last_work_id IS NULL))
) STRICT;
CREATE TABLE resource_admission_events (
  grant_id TEXT NOT NULL
    REFERENCES resource_admission_grants(id) DEFERRABLE INITIALLY DEFERRED,
  policy_key TEXT NOT NULL CHECK (length(policy_key) BETWEEN 1 AND 128),
  dimension TEXT NOT NULL CHECK (
    dimension IN ('stable_user', 'source', 'operation', 'outstanding_work', 'spend')
  ),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  policy_kind TEXT NOT NULL CHECK (
    policy_kind IN ('rolling_window', 'calendar_window', 'outstanding')
  ),
  units INTEGER NOT NULL CHECK (units > 0),
  admitted_at_epoch_ms INTEGER NOT NULL CHECK (admitted_at_epoch_ms >= 0),
  window_start_epoch_ms INTEGER,
  expires_at_epoch_ms INTEGER NOT NULL,
  released_at_epoch_ms INTEGER,
  PRIMARY KEY (grant_id, policy_key),
  CHECK (expires_at_epoch_ms > admitted_at_epoch_ms),
  CHECK (
    (policy_kind = 'outstanding' AND window_start_epoch_ms IS NULL) OR
    (policy_kind <> 'outstanding' AND window_start_epoch_ms IS NOT NULL)
  ),
  CHECK (released_at_epoch_ms IS NULL OR released_at_epoch_ms >= admitted_at_epoch_ms)
) STRICT;
CREATE TABLE pat_pairing_admission (
  source_digest BLOB PRIMARY KEY NOT NULL CHECK (length(source_digest) = 32),
  window_start_ms INTEGER NOT NULL,
  started_count INTEGER NOT NULL CHECK (started_count BETWEEN 1 AND 20)
) STRICT;
CREATE TABLE pat_review_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  occurred_at_ms INTEGER NOT NULL
) STRICT;`;

const block = (guide: string, name: string): ReadonlyArray<string> => {
  const sql = guide.match(
    new RegExp(
      `<!-- ${name}:start -->\\s*\x60\x60\x60sql\\s*([\\s\\S]*?)\x60\x60\x60\\s*<!-- ${name}:end -->`,
      "u"
    )
  )?.[1];
  if (sql === undefined) throw new Error("Missing documented PAT conversion");
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

const verifyConvertedAdmission = (db: D1Database): Effect.Effect<void, NativeFailure> =>
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

it.each(["complete", "interrupted", "invalid_history"] as const)(
  "preserves populated PAT pressure and existing admission through %s conversion",
  (outcome) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* native(() => databases.acquire());
        yield* native(() => installTestSchema({ db }));
        yield* native(() => installHistoricalErasureChunk(db));
        const baseline = yield* native(() =>
          Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
        );
        const objects = baseline.split("--> statement-breakpoint").map((sql) => sql.trim());
        const owned = objects.filter((sql) =>
          /\b(?:TABLE|ON) resource_admission_(?:events|counters)\b/u.test(sql)
        );
        yield* native(() =>
          db.batch([
            db.prepare("DROP TRIGGER resource_admission_review_session_owner"),
            db.prepare("DROP TABLE resource_admission_events"),
            db.prepare("DROP TABLE resource_admission_counters"),
            ...originalSchema
              .split(";")
              .map((sql) => sql.trim())
              .filter((sql) => sql.length > 0)
              .map((sql) => db.prepare(sql)),
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
            db
              .prepare(
                "INSERT INTO pat_review_attempts(rowid,id,session_id,occurred_at_ms) VALUES(7,?,?,1000000)"
              )
              .bind(review, owner),
            db.prepare("INSERT INTO pat_pairing_admission VALUES(zeroblob(32),1000000,20)"),
            db.prepare(
              "INSERT INTO resource_admission_counters(rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used) VALUES(17,'email.pairing.global.v1','global','anchored',1000000,4600000,999)"
            ),
            db.prepare(
              "INSERT INTO resource_admission_events VALUES('existing','test','operation','test','rolling_window',1,1000000,400000,1600000,NULL)"
            ),
            db.prepare("INSERT INTO resource_admission_grants VALUES('existing',1000000,1)"),
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,1,'AwaitingReview')"
              )
              .bind(owner, owner),
            db
              .prepare(
                "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES(?,'pat_review_attempts','initial:7','{}')"
              )
              .bind(owner),
          ])
        );
        if (outcome === "invalid_history") {
          yield* native(() =>
            db.prepare("UPDATE pat_pairing_admission SET window_start_ms=9223372036854775807").run()
          );
        }
        const before = yield* native(() =>
          db.prepare("SELECT id,session_id,occurred_at_ms FROM pat_review_attempts").all()
        );
        const guide = yield* native(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const stages = owned
          .filter((sql) => sql.startsWith("CREATE TABLE"))
          .map((sql) => sql.replace(/CREATE TABLE (\w+)/u, "CREATE TABLE $1_next"));
        const other = objects.filter(
          (sql) =>
            sql.startsWith("CREATE TRIGGER resource_admission_require_every_claim") ||
            sql.startsWith("CREATE TRIGGER resource_admission_review_session_owner")
        );
        const statements = [
          ...stages,
          ...block(guide, "pat-admission-copy"),
          ...owned.filter((sql) => !sql.startsWith("CREATE TABLE")),
          ...other,
          ...block(guide, "pat-admission-grants"),
          ...(outcome === "interrupted"
            ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('pat_admission_cutover',0)"]
            : []),
        ];
        const commit = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(statements.map((sql) => db.prepare(sql)));
        if (outcome !== "complete") {
          yield* native(() => expect(commit()).rejects.toThrow());
          expect(
            (yield* native(() =>
              db.prepare("SELECT id,session_id,occurred_at_ms FROM pat_review_attempts").all()
            )).results
          ).toEqual(before.results);
          expect(
            (yield* native(() =>
              db.prepare("SELECT count(*) AS total FROM resource_admission_events").first()
            ))?.total
          ).toBe(1);
          return;
        }
        yield* native(() => commit());
        expect(
          yield* native(() =>
            db
              .prepare(
                "SELECT grant_id,owner_user_id,owner_session_id,admitted_at_epoch_ms,expires_at_epoch_ms FROM resource_admission_events WHERE policy_key='pat.review.session.v1'"
              )
              .first()
          )
        ).toEqual({
          grant_id: review,
          owner_user_id: owner,
          owner_session_id: owner,
          admitted_at_epoch_ms: 1000000,
          expires_at_epoch_ms: 1600000,
        });
        expect(
          yield* native(() =>
            db
              .prepare(
                "SELECT rowid,used,window_start_ms,window_ends_ms FROM resource_admission_counters WHERE policy_key='email.pairing.global.v1'"
              )
              .first()
          )
        ).toEqual({ rowid: 17, used: 999, window_start_ms: 1000000, window_ends_ms: 4600000 });
        expect(
          (yield* native(() =>
            db
              .prepare("SELECT store_id,row_ref,body FROM erasure_archives WHERE request_id=?")
              .bind(owner)
              .all()
          )).results
        ).toEqual([{ store_id: "pat_review_attempts", row_ref: "initial:7", body: "{}" }]);
        yield* verifyConvertedAdmission(db);
      })
    )
);
