import { Effect, Schema } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { runBillingCollectionWorkflow } from "./runtime";
import { activeProUserCondition } from "../../src/shell/access-tier/operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const id = (kind: number): string => `${kind}4520000-0000-4000-8000-000000000001`;
const started = 1800000000123;
const ends = started + 604800000;

it.each(["valid", "changed-paid-through", "interrupted-copy", "interrupted-columns"] as const)(
  "preserves the cancellation decision, original source, child data and archives or rolls back %s history",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* wait(() => databases.acquire());
        const noticeTarget = precedingSchema({
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
        const refundTarget = precedingSchema({
          current: noticeTarget,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(new URL("./price-notice-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        const current = precedingSchema({
          current: refundTarget,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(new URL("./refund-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        const previous = precedingSchema({
          current,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* wait(() =>
              Bun.file(new URL("./cancellation-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        const guide = yield* wait(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        yield* wait(() => db.batch(previous.map((sql) => db.prepare(sql))));
        yield* wait(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO users(rowid,id,service_market,locale,time_zone,created_at_ms) VALUES(17,?,'CO','es-CO','America/Bogota',1)"
              )
              .bind(id(1)),
            db
              .prepare(
                "INSERT INTO users(rowid,id,service_market,locale,time_zone,created_at_ms) VALUES(18,?,'CO','es-CO','America/Bogota',1)"
              )
              .bind(id(7)),
            db.prepare("INSERT INTO subscriptions(id,user_id) VALUES(?,?)").bind(id(6), id(1)),
            db.prepare("INSERT INTO subscriptions(id,user_id) VALUES(?,?)").bind(id(8), id(7)),
            db
              .prepare(`INSERT INTO payment_enrollments(id,subscription_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,payment_request_id,wompi_candidate_source_id,method,wompi_environment)
        VALUES(?,?,'22700000-0000-4000-8000-000000000001','payer@example.test','creating','create','{}','{}',100,900100,?,42,'daviplata','sandbox')`)
              .bind(id(2), id(6), id(5)),
            db
              .prepare(
                "INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_environment,wompi_source_id,billing_email,method,verified_at_ms,archive_row_ref) VALUES(?,?,?,'sandbox',42,'payer@example.test','daviplata',123,'source:original')"
              )
              .bind(id(3), id(6), id(2)),
            db.prepare("UPDATE payment_enrollments SET status='available' WHERE id=?").bind(id(2)),
            db
              .prepare(
                `INSERT INTO billing_attempts(id,subscription_id,enrollment_id,payment_request_id,payment_source_id,price_id,time_zone,wompi_environment,wompi_reference,created_at_ms) VALUES(?,?,?,?,?,'22700000-0000-4000-8000-000000000001','America/Bogota','sandbox','fidy-cancelled',100)`
              )
              .bind(id(4), id(6), id(2), id(5), id(3)),
            db
              .prepare(
                "UPDATE billing_attempts SET collection_state='sent',collection_sent_at_ms=101 WHERE id=?"
              )
              .bind(id(4)),
            db
              .prepare(
                "INSERT INTO billing_provider_transactions(transaction_id,attempt_id,status,first_observed_at_ms,finalized_at_ms) VALUES('cancelled-transaction',?,'APPROVED',?,?)"
              )
              .bind(id(4), started + 1, started),
            db
              .prepare(
                "UPDATE billing_attempts SET status='succeeded',finalized_at_ms=?,paid_starts_at_ms=?,paid_ends_at_ms=?,paid_renewal_anchor_ms=? WHERE id=?"
              )
              .bind(started, started, ends, ends, id(4)),
            db
              .prepare("UPDATE subscriptions SET current_paid_attempt_id=? WHERE id=?")
              .bind(id(4), id(6)),
            db
              .prepare(
                `UPDATE users SET cancellation_paid_attempt_id=?,cancellation_payment_source_id=?,cancellation_cancelled_at_ms=?,cancellation_paid_through_ms=?,cancellation_source_cancellation='void-pending',cancellation_void_started_at_ms=?,cancellation_verification_count=3,cancellation_last_offered_at_ms=? WHERE id=?`
              )
              .bind(id(4), id(3), started + 2, ends, started + 3, started + 4, id(1)),
            db
              .prepare(
                "INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES(?,'dashboard','{\"original\":true}',2)"
              )
              .bind(id(1)),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','subscription_cancellations','initial:17','{\"historical\":\"unchanged\"}',1)"
            ),
          ])
        );
        if (history === "changed-paid-through") {
          yield* wait(() =>
            db.batch([
              db.prepare("DROP TRIGGER subscription_cancellation_immutable"),
              db.prepare(
                "UPDATE users SET cancellation_paid_through_ms=cancellation_paid_through_ms+1 WHERE cancellation_cancelled_at_ms IS NOT NULL"
              ),
            ])
          );
        }
        const retained = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
            db.prepare("SELECT rowid,* FROM users ORDER BY rowid"),
            ...[
              "billing_attempts",
              "payment_sources",
              "subscriptions",
              "user_documents",
              "erasure_archives",
            ].map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
          ]);
        const before = (yield* wait(retained)).map((result) => result.results);
        const access = activeProUserCondition({ userId: id(1), nowEpochMs: started + 100 });
        expect(
          yield* wait(() =>
            db
              .prepare(`SELECT ${access.sql} AS active`)
              .bind(...access.params)
              .first("active")
          )
        ).toBe(1);
        const objects = yield* wait(() =>
          db
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE type IN('view','trigger','index') AND sql IS NOT NULL"
            )
            .all<{ type: string; name: string }>()
        );
        const apply = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(
            [
              ...documentedSqlBlock({ guide, marker: "subscription-cancellation-preflight" }),
              schemaDefinition({ source: current, target: "subscription_cancellations" }),
              ...documentedSqlBlock({ guide, marker: "subscription-cancellation-copy" }),
              ...documentedSqlBlock({ guide, marker: "subscription-cancellation-copy-check" }),
              ...(history === "interrupted-copy"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...objects.results.map(
                (object) => `DROP ${object.type.toUpperCase()} "${object.name}"`
              ),
              ...documentedSqlBlock({ guide, marker: "subscription-cancellation-remove" }),
              ...(history === "interrupted-columns"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...current.filter((sql) => /^CREATE (?:UNIQUE )?(?:VIEW|TRIGGER|INDEX) /u.test(sql)),
              ...documentedSqlBlock({ guide, marker: "subscription-cancellation-verify" }),
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
          yield* wait(() => db.prepare("SELECT rowid,* FROM subscription_cancellations").first())
        ).toEqual({
          rowid: 17,
          subscription_id: id(6),
          paid_attempt_id: id(4),
          payment_source_id: id(3),
          cancelled_at_ms: started + 2,
          paid_through_ms: ends,
          source_cancellation_state: "void-pending",
          void_started_at_ms: started + 3,
          void_verified_at_ms: null,
          verification_count: 3,
          last_offered_at_ms: started + 4,
        });
        const after = (yield* wait(retained)).map((result) => result.results);
        expect(after.slice(2)).toEqual(before.slice(2));
        expect(
          yield* wait(() =>
            db
              .prepare(`SELECT ${access.sql} AS active`)
              .bind(...access.params)
              .first("active")
          )
        ).toBe(1);
        yield* wait(() =>
          expect(
            db
              .prepare("DELETE FROM subscription_cancellations WHERE subscription_id=?")
              .bind(id(6))
              .run()
          ).rejects.toThrow("subscription_cancellation_immutable")
        );
        yield* wait(() =>
          expect(
            db
              .prepare(
                "UPDATE subscription_cancellations SET verification_count=2 WHERE subscription_id=?"
              )
              .bind(id(6))
              .run()
          ).rejects.toThrow("subscription_cancellation_immutable")
        );
        yield* wait(() =>
          expect(
            db
              .prepare(`INSERT INTO subscription_cancellations(subscription_id,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,verification_count)
        SELECT ?,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,'detached',0 FROM subscription_cancellations`)
              .bind(id(8))
              .run()
          ).rejects.toThrow("subscription_cancellation_invalid")
        );
        expect(
          yield* wait(() =>
            db.prepare("SELECT count(*) FROM subscription_cancellations").first("count(*)")
          )
        ).toBe(1);
        const provider = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(url, init);
          expect(request.method).toBe("GET");
          expect(new URL(request.url).pathname).toBe("/v1/payment_sources/42");
          return Promise.resolve(
            Response.json({ data: { id: 42, type: "DAVIPLATA", status: "AVAILABLE" } })
          );
        });
        vi.stubGlobal("fetch", provider);
        try {
          yield* wait(() =>
            runBillingCollectionWorkflow({
              environment: {
                DB: db,
                WOMPI_ENVIRONMENT: "sandbox",
                WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
                WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
                WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
              },
              payload: { version: 2, kind: "source-cancellation", userId: id(1) },
              activity: (_name, _options, run) => run(),
              sleep: (_name, _duration) => Promise.resolve(),
            })
          );
          expect(provider).toHaveBeenCalledTimes(5);
          expect(
            yield* wait(() =>
              db
                .prepare(
                  "SELECT verification_count,void_started_at_ms FROM subscription_cancellations"
                )
                .first()
            )
          ).toEqual({ verification_count: 8, void_started_at_ms: started + 3 });
        } finally {
          vi.unstubAllGlobals();
        }
      })
    )
);
