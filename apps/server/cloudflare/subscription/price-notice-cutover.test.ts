import { Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const userId = "10000000-0000-4000-8000-000000000001";
const subscriptionId = "20000000-0000-4000-8000-000000000001";

it.each(["valid", "missing-owner", "interrupted-copy", "interrupted-swap"] as const)(
  "preserves pending, claimed and acknowledged Price notices or rolls back %s history",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* wait(() => databases.acquire());
        const current = precedingSchema({
          current: precedingSchema({
            current: precedingSchema({
              current: precedingSchema({
                current: precedingSchema({
                  current: schemaStatements(
                    yield* wait(() =>
                      Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
                    )
                  ),
                  history: yield* Schema.decodeEffect(CutoverHistory)(
                    yield* wait(() =>
                      Bun.file(
                        new URL(
                          "../ingestion/backfill-progress-cutover.test-fixture.json",
                          import.meta.url
                        )
                      ).text()
                    )
                  ),
                }),
                history: yield* Schema.decodeEffect(CutoverHistory)(
                  yield* wait(() =>
                    Bun.file(
                      new URL(
                        "../ingestion/email-media-review-cutover.test-fixture.json",
                        import.meta.url
                      )
                    ).text()
                  )
                ),
              }),
              history: yield* Schema.decodeEffect(CutoverHistory)(
                yield* wait(() =>
                  Bun.file(
                    new URL(
                      "../ingestion/statement-review-cutover.test-fixture.json",
                      import.meta.url
                    )
                  ).text()
                )
              ),
            }),
            history: yield* Schema.decodeEffect(CutoverHistory)(
              yield* wait(() =>
                Bun.file(
                  new URL("../ingestion/materialization-cutover.test-fixture.json", import.meta.url)
                ).text()
              )
            ),
          }),
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(
                new URL("../ingestion/forwarding-cutover.test-fixture.json", import.meta.url)
              ).text()
            )
          ),
        });
        const previous = precedingSchema({
          current,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(new URL("./price-notice-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        yield* wait(() => db.batch(previous.map((sql) => db.prepare(sql))));
        yield* wait(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
              )
              .bind(userId),
            db.prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES('10000000-0000-4000-8000-000000000002','CO','es-CO','America/Bogota',1)"
            ),
            db
              .prepare("INSERT INTO subscriptions(id,user_id) VALUES(?,?)")
              .bind(subscriptionId, userId),
            db.prepare(
              "INSERT INTO subscriptions(id,user_id) VALUES('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002')"
            ),
            db
              .prepare(
                "INSERT INTO billing_price_notices(rowid,user_id,price_id,created_at_ms,last_offered_at_ms,send_started_at_ms,accepted_at_ms) VALUES(17,?,'22700000-0000-4000-8000-000000000001',123,456,789,999)"
              )
              .bind(userId),
            db
              .prepare(
                "INSERT INTO billing_price_notices(rowid,user_id,price_id,created_at_ms,last_offered_at_ms,send_started_at_ms) VALUES(18,?,'22700000-0000-4000-8000-000000000002',124,457,790)"
              )
              .bind(userId),
            db
              .prepare(
                "INSERT INTO billing_price_notices(rowid,user_id,price_id,created_at_ms,last_offered_at_ms) VALUES(19,?,'22700000-0000-4000-8000-000000000003',125,458)"
              )
              .bind(userId),
            db.prepare(
              "INSERT INTO billing_price_notices(rowid,user_id,price_id,created_at_ms) VALUES(20,'10000000-0000-4000-8000-000000000002','22700000-0000-4000-8000-000000000001',126)"
            ),
            db
              .prepare(
                "INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES(?,'dashboard','{\"original\":true}',2)"
              )
              .bind(userId),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','billing_price_notices','initial:17','{\"historical\":\"unchanged\"}',1)"
            ),
          ])
        );
        if (history === "missing-owner") {
          yield* wait(() =>
            db.prepare("DELETE FROM subscriptions WHERE id=?").bind(subscriptionId).run()
          );
        }
        const retained = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
            db.prepare("SELECT rowid,* FROM billing_price_notices ORDER BY rowid"),
            ...["users", "subscriptions", "user_documents", "erasure_archives"].map((table) =>
              db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)
            ),
          ]);
        const before = (yield* wait(retained)).map((result) => result.results);
        const objects = yield* wait(() =>
          db
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE type IN('view','trigger','index') AND sql IS NOT NULL"
            )
            .all<{ type: string; name: string }>()
        );
        const guide = yield* wait(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const apply = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(
            [
              ...documentedSqlBlock({ guide, marker: "subscription-price-notice-preflight" }),
              schemaDefinition({ source: current, target: "billing_price_notices" }).replace(
                "CREATE TABLE billing_price_notices",
                "CREATE TABLE billing_price_notices_1454"
              ),
              ...documentedSqlBlock({ guide, marker: "subscription-price-notice-copy" }),
              ...documentedSqlBlock({ guide, marker: "subscription-price-notice-copy-check" }),
              ...(history === "interrupted-copy"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...objects.results.map(
                (object) => `DROP ${object.type.toUpperCase()} "${object.name}"`
              ),
              ...documentedSqlBlock({ guide, marker: "subscription-price-notice-swap" }),
              ...(history === "interrupted-swap"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...current.filter((sql) => /^CREATE (?:UNIQUE )?(?:VIEW|TRIGGER|INDEX) /u.test(sql)),
              ...documentedSqlBlock({ guide, marker: "subscription-price-notice-verify" }),
            ].map((sql) => db.prepare(sql))
          );
        if (history !== "valid") {
          yield* wait(() =>
            expect(apply()).rejects.toThrow("CHECK constraint failed: accepted = 1")
          );
          expect((yield* wait(retained)).map((result) => result.results)).toEqual(before);
          return;
        }
        yield* wait(apply);
        expect(
          (yield* wait(() =>
            db
              .prepare(
                "SELECT rowid,user_id,price_id,created_at_ms,last_offered_at_ms,send_started_at_ms,provider_accepted_at_ms AS accepted_at_ms FROM billing_price_notice_context ORDER BY rowid"
              )
              .all()
          )).results
        ).toEqual(before[1]);
        expect((yield* wait(retained)).map((result) => result.results).slice(2)).toEqual(
          before.slice(2)
        );
        yield* wait(() =>
          expect(
            db
              .prepare(
                "UPDATE billing_price_notices SET subscription_id='20000000-0000-4000-8000-000000000002' WHERE rowid=19"
              )
              .run()
          ).rejects.toThrow("billing_price_notice_identity")
        );
      })
    )
);
