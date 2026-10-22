import { Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { seedRefundCharge } from "./refund-charge.test-fixture";
import { getRefund, startRefund } from "./operations";
import { RefundAttempt } from "../../src/core/subscription/contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const userId = "10000000-0000-4000-8000-000000000001";
const attemptId = "40000000-0000-4000-8000-000000000001";
const requestId = "50000000-0000-4000-8000-000000000001";
const refundId = "60000000-0000-4000-8000-000000000001";
const authority = {
  operatorId: "original-operator",
  expiresAtMs: 9999999999999,
  permission: "billing.refund" as const,
};
const input = {
  userId,
  billingAttemptId: attemptId,
  requestId,
  intent: { kind: "refund" as const, money: { amount: "4000.01", currency: "COP" as const } },
  reason: "user-request" as const,
};
const at = 1800000000123;
const snapshot = {
  id: refundId,
  userId,
  subscriptionId: userId,
  billingAttemptId: attemptId,
  priceId: "22700000-0000-4000-8000-000000000001",
  requestId,
  kind: "refund",
  money: input.intent.money,
  reason: input.reason,
  createdAt: "2027-01-15T08:00:00.123Z",
  status: "pending",
  progress: "queued",
  treatment: {
    policyId: "refund-ends-paid-period-v1",
    taxTreatment: "not-taxable",
    paidPeriodEffect: "end-refunded-period-at-verification",
    renewalEffect: "stop-future-renewals",
    accounting: { kind: "sandbox-only" },
  },
};

it.each([
  "valid",
  "changed-price",
  "changed-owner",
  "changed-snapshot",
  "interrupted-copy",
  "interrupted-swap",
] as const)(
  "preserves reserved Money, ambiguous claims, replay and archives or rolls back %s history",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* wait(() => databases.acquire());
        const noticeTarget = precedingSchema({
          current: schemaStatements(
            yield* wait(() =>
              Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
            )
          ),
          history: yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                originalDefinitions: Schema.Array(Schema.String),
                introducedNames: Schema.Array(Schema.String),
              })
            )
          )(
            yield* wait(() =>
              Bun.file(
                new URL("../ingestion/forwarding-cutover.test-fixture.json", import.meta.url)
              ).text()
            )
          ),
        });
        const current = precedingSchema({
          current: noticeTarget,
          history: yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                originalDefinitions: Schema.Array(Schema.String),
                introducedNames: Schema.Array(Schema.String),
              })
            )
          )(
            yield* wait(() =>
              Bun.file(new URL("./price-notice-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        const previous = precedingSchema({
          current,
          history: yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                originalDefinitions: Schema.Array(Schema.String),
                introducedNames: Schema.Array(Schema.String),
              })
            )
          )(
            yield* wait(() =>
              Bun.file(new URL("./refund-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        yield* wait(() => db.batch(previous.map((sql) => db.prepare(sql))));
        yield* seedRefundCharge(db);
        // An already-claimed ambiguous refund still reserves its amount and must never be POSTed twice.
        yield* wait(() =>
          db.batch([
            db
              .prepare(
                `INSERT INTO refund_attempts(rowid,id,user_id,subscription_id,billing_attempt_id,transaction_id,request_id,intent_json,snapshot_json,amount_in_cents,original_cents,kind,operator_id,created_at_ms) VALUES(37,?,?,?,?,?,?,?,?,400001,990000,'refund','original-operator',?)`
              )
              .bind(
                refundId,
                userId,
                userId,
                attemptId,
                "provider-charge",
                requestId,
                JSON.stringify(input),
                JSON.stringify(snapshot),
                at
              ),
            db
              .prepare(
                "UPDATE refund_attempts SET submission_claimed_at_ms=?,progress='outcome-unknown',verification_attempts=3,last_verification_at_ms=?,dispatch_last_attempt_at_ms=?,published_at_ms=? WHERE id=?"
              )
              .bind(at + 1, at + 2, at + 3, at + 4, refundId),
            db.prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES('70000000-0000-4000-8000-000000000001','CO','es-CO','America/Bogota',1)"
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
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','refund_attempts','initial:37','{\"historical\":\"unchanged\"}',1)"
            ),
          ])
        );
        const settledId = "60000000-0000-4000-8000-000000000002";
        const settledRequest = "50000000-0000-4000-8000-000000000002";
        const settledInput = {
          ...input,
          requestId: settledRequest,
          reason: "duplicate-collection",
          intent: { kind: "refund", money: { amount: "1000", currency: "COP" } },
        };
        const settledSnapshot = {
          ...snapshot,
          id: settledId,
          requestId: settledRequest,
          reason: "duplicate-collection",
          money: { amount: "1000", currency: "COP" },
        };
        yield* wait(() =>
          db.batch([
            db
              .prepare(
                `INSERT INTO refund_attempts(rowid,id,user_id,subscription_id,billing_attempt_id,transaction_id,request_id,intent_json,snapshot_json,amount_in_cents,original_cents,kind,operator_id,created_at_ms) VALUES(38,?,?,?,?,?,?,?,?,100000,990000,'refund','original-operator',?)`
              )
              .bind(
                settledId,
                userId,
                userId,
                attemptId,
                "provider-charge",
                settledRequest,
                JSON.stringify(settledInput),
                JSON.stringify(settledSnapshot),
                at
              ),
            db
              .prepare("UPDATE refund_attempts SET submission_claimed_at_ms=? WHERE id=?")
              .bind(at + 5, settledId),
            db
              .prepare(
                "UPDATE refund_attempts SET provider_refund_id='original-provider-refund',verified_status='APPROVED',observed_at_ms=? WHERE id=?"
              )
              .bind(at + 10, settledId),
          ])
        );
        if (history.startsWith("changed-")) {
          let corruption =
            "UPDATE refund_attempts SET snapshot_json=json_set(snapshot_json,'$.money.amount','4001')";
          if (history === "changed-price") {
            corruption = "UPDATE refund_attempts SET original_cents=original_cents+1";
          }
          if (history === "changed-owner") {
            corruption =
              "UPDATE refund_attempts SET user_id='70000000-0000-4000-8000-000000000001'";
          }
          yield* wait(() =>
            db.batch([db.prepare("DROP TRIGGER refund_snapshot_immutable"), db.prepare(corruption)])
          );
        }
        const retained = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
            db.prepare("SELECT rowid,* FROM refund_attempts ORDER BY rowid"),
            ...[
              "users",
              "user_documents",
              "billing_attempts",
              "subscriptions",
              "erasure_archives",
            ].map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
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
              schemaDefinition({ source: current, target: "refund_charge_context" }),
              ...documentedSqlBlock({ guide, marker: "subscription-refund-preflight" }),
              schemaDefinition({ source: current, target: "refund_attempts" }).replace(
                'CREATE TABLE "refund_attempts"',
                'CREATE TABLE "refund_attempts_1453"'
              ),
              ...documentedSqlBlock({ guide, marker: "subscription-refund-copy" }),
              ...documentedSqlBlock({ guide, marker: "subscription-refund-copy-check" }),
              ...(history === "interrupted-copy"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...objects.results.map(
                (object) => `DROP ${object.type.toUpperCase()} "${object.name}"`
              ),
              "DROP VIEW refund_charge_context",
              ...documentedSqlBlock({ guide, marker: "subscription-refund-swap" }),
              ...(history === "interrupted-swap"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...current.filter((sql) => /^CREATE (?:UNIQUE )?(?:VIEW|TRIGGER|INDEX) /u.test(sql)),
              ...documentedSqlBlock({ guide, marker: "subscription-refund-verify" }),
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
        const accepted = yield* getRefund({ db, authority, userId, refundAttemptId: refundId });
        expect(yield* Schema.encodeEffect(RefundAttempt)(accepted)).toEqual({
          ...snapshot,
          progress: "outcome-unknown",
        });
        expect(yield* startRefund({ db, authority, environment: "sandbox", input })).toEqual(
          accepted
        );
        const settled = yield* getRefund({ db, authority, userId, refundAttemptId: settledId });
        const { progress: _progress, ...settledExpected } = settledSnapshot;
        expect(yield* Schema.encodeEffect(RefundAttempt)(settled)).toEqual({
          ...settledExpected,
          status: "succeeded",
          verifiedAt: "2027-01-15T08:00:00.133Z",
        });
        expect(
          yield* wait(() =>
            db
              .prepare(
                "SELECT rowid,access_ends_at_ms,renewal_stopped_at_ms FROM refund_attempts WHERE id=?"
              )
              .bind(settledId)
              .first()
          )
        ).toEqual({ rowid: 38, access_ends_at_ms: at + 10, renewal_stopped_at_ms: at + 10 });
        const after = (yield* wait(retained)).map((result) => result.results);
        expect(after.slice(2)).toEqual(before.slice(2));
        expect(
          yield* wait(() =>
            db
              .prepare(
                "SELECT rowid,verification_attempts,submission_claimed_at_ms,dispatch_last_attempt_at_ms,last_verification_at_ms FROM refund_attempts WHERE id=?"
              )
              .bind(refundId)
              .first()
          )
        ).toEqual({
          rowid: 37,
          verification_attempts: 3,
          submission_claimed_at_ms: at + 1,
          dispatch_last_attempt_at_ms: at + 3,
          last_verification_at_ms: at + 2,
        });
      })
    )
);
