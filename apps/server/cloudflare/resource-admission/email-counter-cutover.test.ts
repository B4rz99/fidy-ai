import { Data, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { documentedSqlBlock } from "../schema-cutover.test-fixture";
import { prepareResourceCounter, resourceCounterQuery } from "./operations";

class NativeFailure extends Data.TaggedError("NativeFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, NativeFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new NativeFailure({ cause }),
  });

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "14320000-0000-4000-8000-000000000001";
const foreignUser = "14320000-0000-4000-8000-000000000002";
const originalWork = "14320000-0000-4000-8000-000000000003";
const nextWork = "14320000-0000-4000-8000-000000000004";
const historicalSchema = `CREATE TABLE email_security_limits (
  kind TEXT NOT NULL CHECK(kind IN ('pairing','replacement','pairing-global')),
  user_id TEXT REFERENCES users(id),window_started_at_ms INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK(requests>=1 AND requests<=CASE WHEN kind='pairing-global' THEN 1000 ELSE 5 END),
  last_work_id TEXT CHECK(last_work_id IS NULL OR length(last_work_id)=36),
  CHECK((kind='pairing-global' AND user_id IS NULL AND last_work_id IS NULL)
    OR (kind='pairing' AND user_id IS NOT NULL AND last_work_id IS NULL)
    OR (kind='replacement' AND user_id IS NOT NULL AND last_work_id IS NOT NULL)),
  UNIQUE(kind,user_id)
) STRICT`;

const retained = (db: D1Database): Promise<D1Result> =>
  db
    .prepare(
      "SELECT rowid,kind,user_id,CAST(window_started_at_ms AS TEXT) AS anchor,requests,last_work_id FROM email_security_limits ORDER BY rowid"
    )
    .all();

it.each(["complete", "interrupted_cutover", "inconsistent_anchor"] as const)(
  "preserves populated email capacity and proof bindings through a %s cutover",
  (outcome) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* native(() => databases.acquire());
        yield* native(() => installTestSchema({ db }));
        yield* native(() =>
          db.batch([
            ...[userId, foreignUser].map((id) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(id)
            ),
            db.prepare("DROP TABLE resource_admission_counters"),
            db.prepare(historicalSchema),
            db.prepare(
              "CREATE UNIQUE INDEX email_security_global_identity ON email_security_limits(kind) WHERE kind='pairing-global'"
            ),
            db.prepare(
              "INSERT INTO email_security_limits(rowid,kind,user_id,window_started_at_ms,requests,last_work_id) VALUES (7,'pairing-global',NULL,500000,999,NULL)"
            ),
            db
              .prepare(
                "INSERT INTO email_security_limits(rowid,kind,user_id,window_started_at_ms,requests,last_work_id) VALUES (17,'pairing',?,1000,5,NULL)"
              )
              .bind(userId),
            db
              .prepare(
                "INSERT INTO email_security_limits(rowid,kind,user_id,window_started_at_ms,requests,last_work_id) VALUES (88,'replacement',?,2000,4,?)"
              )
              .bind(userId, originalWork),
            db
              .prepare(
                "INSERT INTO email_security_limits(rowid,kind,user_id,window_started_at_ms,requests,last_work_id) VALUES (107,'pairing',?,1500,2,NULL)"
              )
              .bind(foreignUser),
          ])
        );
        if (outcome === "inconsistent_anchor") {
          yield* native(() =>
            db
              .prepare(
                "UPDATE email_security_limits SET window_started_at_ms=9223372036854775807 WHERE rowid=17"
              )
              .run()
          );
        }
        const before = yield* native(() => retained(db));
        const baseline = yield* native(() =>
          Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
        );
        const objects = baseline
          .split("--> statement-breakpoint")
          .map((sql) => sql.trim())
          .filter((sql) => /\b(?:TABLE|ON) resource_admission_counters\b/u.test(sql));
        const table = objects.find((sql) => sql.startsWith("CREATE TABLE"));
        if (table === undefined) throw new Error("Missing target counter schema");
        const guide = yield* native(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const cutover = [
          table,
          ...documentedSqlBlock({ guide, marker: "email-counter-copy" }),
          ...objects.filter((sql) => sql !== table),
          ...(outcome === "interrupted_cutover"
            ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('email_counter_cutover',0)"]
            : []),
        ];
        const commit = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(cutover.map((sql) => db.prepare(sql)));
        if (outcome !== "complete") {
          yield* native(() => expect(commit()).rejects.toThrow());
          expect((yield* native(() => retained(db))).results).toEqual(before.results);
          yield* native(() =>
            expect(
              db.prepare("SELECT used FROM resource_admission_counters").all()
            ).rejects.toThrow()
          );
          return;
        }
        yield* native(() => commit());
        expect(
          (yield* native(() =>
            db
              .prepare(
                "SELECT rowid,policy_key,scope_key,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id FROM resource_admission_counters ORDER BY rowid"
              )
              .all()
          )).results
        ).toEqual([
          {
            rowid: 7,
            policy_key: "email.pairing.global.v1",
            scope_key: "global",
            window_start_ms: 500000,
            window_ends_ms: 4100000,
            used: 999,
            last_work_id: null,
            owner_user_id: null,
          },
          {
            rowid: 17,
            policy_key: "email.pairing.user.v1",
            scope_key: userId,
            window_start_ms: 1000,
            window_ends_ms: 3601000,
            used: 5,
            last_work_id: null,
            owner_user_id: userId,
          },
          {
            rowid: 88,
            policy_key: "email.replacement.user.v1",
            scope_key: userId,
            window_start_ms: 2000,
            window_ends_ms: 86402000,
            used: 4,
            last_work_id: originalWork,
            owner_user_id: userId,
          },
          {
            rowid: 107,
            policy_key: "email.pairing.user.v1",
            scope_key: foreignUser,
            window_start_ms: 1500,
            window_ends_ms: 3601500,
            used: 2,
            last_work_id: null,
            owner_user_id: foreignUser,
          },
        ]);
        const subject = { sql: "SELECT ? AS user_id", params: [userId] };
        yield* native(() =>
          expect(
            prepareResourceCounter({
              db,
              kind: "email_pairing_user",
              subject,
              current: 3600999,
            }).run()
          ).rejects.toThrow()
        );
        yield* native(() =>
          prepareResourceCounter({
            db,
            kind: "email_pairing_user",
            subject,
            current: 3601000,
          }).run()
        );
        const query = resourceCounterQuery({ kind: "email_pairing_user", subject });
        expect(
          yield* native(() =>
            db
              .prepare(query.sql)
              .bind(...query.params)
              .first()
          )
        ).toEqual({
          used: 1,
          window_start_ms: 3601000,
          window_ends_ms: 7201000,
          last_work_id: null,
        });
        yield* native(() =>
          prepareResourceCounter({
            db,
            kind: "email_replacement",
            subject,
            current: 2001,
            workId: nextWork,
          }).run()
        );
        const refused = yield* native(() =>
          prepareResourceCounter({
            db,
            kind: "email_replacement",
            subject,
            current: 2002,
            workId: originalWork,
          }).run()
        );
        expect(refused.meta.changes).toBe(0);
        const replacement = resourceCounterQuery({ kind: "email_replacement", subject });
        expect(
          yield* native(() =>
            db
              .prepare(replacement.sql)
              .bind(...replacement.params)
              .first()
          )
        ).toEqual({
          used: 5,
          window_start_ms: 2000,
          window_ends_ms: 86402000,
          last_work_id: nextWork,
        });
        expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
      })
    )
);
