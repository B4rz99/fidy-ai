import {
  installHistoricalErasureChunk,
  installHistoricalErasureStorage,
} from "../schema-cutover.test-fixture";
import { Data, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { prepareResourceCounter, sweepCompactionCounters } from "./operations";

class NativeFailure extends Data.TaggedError("NativeFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, NativeFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new NativeFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = "14350000-0000-4000-8000-000000000011";
const foreign = "14350000-0000-4000-8000-000000000012";
const archive = "14350000-0000-4000-8000-000000000013";
const originalSchema = `CREATE TABLE resource_admission_counters (
  policy_key TEXT NOT NULL CHECK(policy_key IN (
    'email.pairing.user.v1','email.pairing.global.v1','email.replacement.user.v1','pat.pairing.source.v1'
  )),
  scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 256),
  window_kind TEXT NOT NULL CHECK(window_kind='anchored'),
  window_start_ms INTEGER NOT NULL,
  window_ends_ms INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK(used BETWEEN 1 AND CASE policy_key
    WHEN 'email.pairing.global.v1' THEN 1000 WHEN 'pat.pairing.source.v1' THEN 20 ELSE 5 END),
  last_work_id TEXT CHECK(last_work_id IS NULL OR length(last_work_id)=36),
  owner_user_id TEXT REFERENCES users(id),
  CHECK(window_ends_ms=window_start_ms+CASE policy_key
    WHEN 'email.replacement.user.v1' THEN 86400000 WHEN 'pat.pairing.source.v1' THEN 600000 ELSE 3600000 END),
  CHECK((policy_key='email.pairing.global.v1' AND scope_key='global' AND owner_user_id IS NULL)
    OR (policy_key IN ('email.pairing.user.v1','email.replacement.user.v1')
      AND owner_user_id IS NOT NULL AND scope_key=owner_user_id)
    OR (policy_key='pat.pairing.source.v1' AND owner_user_id IS NULL
      AND length(scope_key)=64 AND scope_key NOT GLOB '*[^0-9a-f]*')),
  CHECK((policy_key='email.replacement.user.v1' AND last_work_id IS NOT NULL)
    OR (policy_key<>'email.replacement.user.v1' AND last_work_id IS NULL))
) STRICT;
CREATE TABLE hosted_compaction_attempts (
  user_id TEXT NOT NULL REFERENCES users(id),
  day_ms INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK (used BETWEEN 1 AND 3),
  PRIMARY KEY (user_id, day_ms)
) STRICT;`;
const block = (guide: string, name: string): ReadonlyArray<string> => {
  const sql = guide.match(
    new RegExp(
      `<!-- ${name}:start -->\\s*\x60\x60\x60sql\\s*([\\s\\S]*?)\x60\x60\x60\\s*<!-- ${name}:end -->`,
      "u"
    )
  )?.[1];
  if (sql === undefined) throw new Error("Missing documented compaction conversion");
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

it.each([
  "complete",
  "interrupted",
  "invalid_day",
  "policy_collision",
  "unfinished_chunk",
  "active_erasure",
] as const)(
  "preserves exact daily capacity and historical evidence through %s compaction conversion",
  (outcome) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* native(() => databases.acquire());
        yield* native(() => installTestSchema({ db }));
        yield* native(() => installHistoricalErasureStorage(db));
        yield* native(() => installHistoricalErasureChunk(db));
        const baseline = yield* native(() =>
          Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
        );
        const owned = baseline
          .split("--> statement-breakpoint")
          .map((sql) => sql.trim())
          .filter((sql) => /\b(?:TABLE|ON) resource_admission_counters\b/u.test(sql));
        yield* native(() =>
          db.batch([
            db.prepare("DROP TABLE resource_admission_counters"),
            ...originalSchema
              .split(";")
              .map((sql) => sql.trim())
              .filter(Boolean)
              .map((sql) => db.prepare(sql)),
            ...[owner, foreign].map((id) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(id)
            ),
            db.prepare(
              "INSERT INTO resource_admission_counters(rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used) VALUES(17,'email.pairing.global.v1','global','anchored',1000000,4600000,999)"
            ),
            db
              .prepare(
                "INSERT INTO hosted_compaction_attempts(rowid,user_id,day_ms,used) VALUES(7,?,0,3),(101,?,86400000,2),(1,?,0,1)"
              )
              .bind(owner, owner, foreign),
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,1,'Complete')"
              )
              .bind(archive, archive),
            db
              .prepare(
                "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES(?,'hosted_compaction_attempts','initial:71',?,1)"
              )
              .bind(archive, '{"user_id":"historical","day_ms":-86400000,"used":2}'),
          ])
        );
        if (outcome === "invalid_day") {
          yield* native(() =>
            db
              .prepare("UPDATE hosted_compaction_attempts SET day_ms=86400001 WHERE rowid=101")
              .run()
          );
        }
        if (outcome === "unfinished_chunk") {
          yield* native(() =>
            db
              .prepare("INSERT INTO erasure_chunk(request_id,row_ref) VALUES(?,'7')")
              .bind(archive)
              .run()
          );
        }
        if (outcome === "active_erasure") {
          yield* native(() =>
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,1,'Erasing')"
              )
              .bind(owner, owner)
              .run()
          );
        }
        if (outcome === "policy_collision") {
          yield* native(() =>
            db.batch([
              db.prepare("DROP TABLE resource_admission_counters"),
              db
                .prepare(
                  "CREATE TABLE resource_admission_counters AS SELECT 17 AS rowid,'hosted.compaction.user.v1' AS policy_key,? AS scope_key,'calendar' AS window_kind,0 AS window_start_ms,86400000 AS window_ends_ms,1 AS used,NULL AS last_work_id,? AS owner_user_id"
                )
                .bind(owner, owner),
            ])
          );
        }
        const before = yield* native(() =>
          db.prepare("SELECT rowid,* FROM hosted_compaction_attempts ORDER BY rowid").all()
        );
        const counters = yield* native(() =>
          db.prepare("SELECT rowid,* FROM resource_admission_counters ORDER BY rowid").all()
        );
        const archived = yield* native(() => db.prepare("SELECT * FROM erasure_archives").all());
        const guide = yield* native(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const statements = [
          ...owned
            .filter((sql) => sql.startsWith("CREATE TABLE"))
            .map((sql) =>
              sql.replace(
                "CREATE TABLE resource_admission_counters",
                "CREATE TABLE resource_admission_counters_next"
              )
            ),
          ...block(guide, "compaction-counter-copy"),
          ...owned.filter((sql) => !sql.startsWith("CREATE TABLE")),
          ...(outcome === "interrupted"
            ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('compaction_counter_cutover',0)"]
            : []),
          ...block(guide, "compaction-counter-verify"),
        ];
        const commit = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(statements.map((sql) => db.prepare(sql)));
        if (outcome !== "complete") {
          yield* native(() => expect(commit()).rejects.toThrow());
          expect(
            (yield* native(() =>
              db.prepare("SELECT rowid,* FROM hosted_compaction_attempts ORDER BY rowid").all()
            )).results
          ).toEqual(before.results);
          expect(
            (yield* native(() =>
              db.prepare("SELECT rowid,* FROM resource_admission_counters ORDER BY rowid").all()
            )).results
          ).toEqual(counters.results);
        } else {
          yield* native(() => commit());
          expect(
            (yield* native(() =>
              db
                .prepare(
                  "SELECT rowid,owner_user_id,window_start_ms,window_ends_ms,used FROM resource_admission_counters WHERE window_kind='calendar' ORDER BY rowid"
                )
                .all()
            )).results
          ).toEqual([
            {
              rowid: 18,
              owner_user_id: foreign,
              window_start_ms: 0,
              window_ends_ms: 86400000,
              used: 1,
            },
            {
              rowid: 24,
              owner_user_id: owner,
              window_start_ms: 0,
              window_ends_ms: 86400000,
              used: 3,
            },
            {
              rowid: 118,
              owner_user_id: owner,
              window_start_ms: 86400000,
              window_ends_ms: 172800000,
              used: 2,
            },
          ]);
          expect(
            (yield* native(() =>
              db
                .prepare(
                  "SELECT rowid,* FROM resource_admission_counters WHERE window_kind='anchored' ORDER BY rowid"
                )
                .all()
            )).results
          ).toEqual(counters.results);
          const admit = (current: number): Promise<D1Result> =>
            prepareResourceCounter({
              db,
              kind: "hosted_compaction",
              current,
              subject: { sql: "SELECT ? AS user_id", params: [owner] },
            }).run();
          expect((yield* native(() => admit(86399999))).meta.changes).toBe(0);
          expect((yield* native(() => admit(86400000))).meta.changes).toBe(1);
          expect((yield* native(() => admit(86400001))).meta.changes).toBe(0);
          expect((yield* native(() => admit(172800000))).meta.changes).toBe(1);
        }
        expect(
          (yield* native(() => db.prepare("SELECT * FROM erasure_archives").all())).results
        ).toEqual(archived.results);
      })
    )
);

it("bounds compaction cleanup at the original retention boundary without deleting another scope", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() => installHistoricalErasureStorage(db));
      yield* native(() => installHistoricalErasureChunk(db));
      const legacy = originalSchema
        .split(";")
        .find((sql) => sql.includes("CREATE TABLE hosted_compaction_attempts"));
      if (legacy === undefined) throw Error("missing original table");
      const originalObjects = `CREATE INDEX hosted_compaction_attempts_due ON hosted_compaction_attempts(day_ms, user_id);
--> statement-breakpoint
CREATE TRIGGER historical_erasure_fence_hosted_compaction_attempts_delete BEFORE DELETE ON hosted_compaction_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('Draining','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_compaction_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;`;
      yield* native(() =>
        db.batch([
          db.prepare(legacy),
          ...originalObjects.split("--> statement-breakpoint").map((sql) => db.prepare(sql)),
          ...[owner, foreign].map((id) =>
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','UTC',1)"
              )
              .bind(id)
          ),
          db
            .prepare("INSERT INTO hosted_compaction_attempts VALUES(?,0,3),(?,86400000,2),(?,0,1)")
            .bind(owner, owner, foreign),
          ...[
            { userId: owner, day: 0 },
            { userId: owner, day: 86400000 },
            { userId: foreign, day: 0 },
          ].map(({ userId, day }) =>
            prepareResourceCounter({
              db,
              kind: "hosted_compaction",
              current: day,
              subject: { sql: "SELECT ? AS user_id", params: [userId] },
            })
          ),
          prepareResourceCounter({
            db,
            kind: "email_pairing_global",
            current: 1,
            subject: { sql: "SELECT 1", params: [] },
          }),
        ])
      );
      const costs: Array<unknown> = [];
      for (const cutoff of [0, 1]) {
        const original = yield* native(() =>
          db
            .prepare(`DELETE FROM hosted_compaction_attempts WHERE rowid IN
      (SELECT rowid FROM hosted_compaction_attempts WHERE user_id=? AND day_ms<? ORDER BY day_ms LIMIT ?)`)
            .bind(owner, cutoff, 1)
            .run()
        );
        const sweep = sweepCompactionCounters({ userId: owner, cutoff, limit: 1 });
        const shared = yield* native(() =>
          db
            .prepare(sweep.sql)
            .bind(...sweep.params)
            .run()
        );
        costs.push({
          cutoff,
          original: { read: original.meta.rows_read, written: original.meta.rows_written },
          shared: { read: shared.meta.rows_read, written: shared.meta.rows_written },
        });
        expect(shared.meta.changes).toBe(original.meta.changes);
      }
      expect(costs).toEqual([
        { cutoff: 0, original: { read: 2, written: 0 }, shared: { read: 2, written: 0 } },
        { cutoff: 1, original: { read: 5, written: 1 }, shared: { read: 5, written: 1 } },
      ]);
      expect(
        (yield* native(() =>
          db
            .prepare(
              "SELECT policy_key,scope_key,window_start_ms FROM resource_admission_counters ORDER BY policy_key,scope_key,window_start_ms"
            )
            .all()
        )).results
      ).toEqual([
        { policy_key: "email.pairing.global.v1", scope_key: "global", window_start_ms: 1 },
        { policy_key: "hosted.compaction.user.v1", scope_key: owner, window_start_ms: 86400000 },
        { policy_key: "hosted.compaction.user.v1", scope_key: foreign, window_start_ms: 0 },
      ]);
    })
  ));
