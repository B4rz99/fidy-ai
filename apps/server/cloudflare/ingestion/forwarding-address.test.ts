import { Clock, Data, Effect, Exit, Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import {
  consentHistoryTestSchema,
  installAuditTestSchema,
  installForwardingTestSchema,
} from "../d1-test-fixture";
import { afterEach, expect, it } from "vitest";
import { forwardingAddressResponse } from "./operations";
import { executeCanonicalQuery, executeCanonicalWork } from "../canonical-operations/operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";

const userA = "10000000-0000-4000-8000-000000000101";
const userB = "10000000-0000-4000-8000-000000000102";
const sessionA = "20000000-0000-4000-8000-000000000101";
const digest = new Uint8Array(32).fill(7);
const instances: Miniflare[] = [];
class TestFailure extends Data.TaggedError("TestFailure")<{ readonly cause: unknown }> {}
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) }).pipe(Effect.orDie);

const setup = Effect.fn(function* () {
  const miniflare = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "address-test", type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default { fetch() { return new Response('ok') } }",
                type: "esm",
              },
            },
          },
          name: "address-test-worker",
          type: "worker",
        },
      },
    ],
  });
  instances.push(miniflare);
  yield* wait(() => miniflare.ready);
  const db = yield* wait(() => miniflare.getD1Database("DB"));
  yield* wait(() =>
    db.exec(`CREATE TABLE users (paid_attempt_id TEXT,paid_price_id TEXT,paid_period_ends_at_ms INTEGER,paid_renewal_anchor_ms INTEGER,audit_retention_cutoff_ms INTEGER,id TEXT PRIMARY KEY, trial_started_at_ms INTEGER, trial_ends_at_ms INTEGER ,service_market TEXT,locale TEXT,time_zone TEXT,created_at_ms INTEGER,verified_email_address TEXT,email_verified_at_ms INTEGER,recovery_code_digest BLOB,recovery_created_at_ms INTEGER,recovery_consumed_at_ms INTEGER,recovery_revision INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER,route_portfolio_id TEXT,route_bsuid TEXT,route_phone_number_id TEXT,route_verified_at_ms INTEGER);
    ${consentHistoryTestSchema};

    CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT, token_digest BLOB, revoked_at_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER);
    CREATE TABLE statement_submission_audit (id TEXT PRIMARY KEY, user_id TEXT, operation TEXT, outcome TEXT, occurred_at_ms INTEGER);
    CREATE TABLE statement_review_audit (id TEXT PRIMARY KEY, user_id TEXT, operation TEXT, outcome TEXT DEFAULT 'success', occurred_at_ms INTEGER);
    CREATE TABLE transaction_audit (user_id TEXT, operation TEXT, occurred_at_ms INTEGER);
    CREATE TABLE statement_clarification_audit (id TEXT PRIMARY KEY, user_id TEXT, operation TEXT, outcome TEXT, occurred_at_ms INTEGER);
    CREATE TABLE category_audit (user_id TEXT, occurred_at_ms INTEGER);
    CREATE TABLE memory_audit (user_id TEXT, occurred_at_ms INTEGER);
    CREATE VIEW subscription_standing AS SELECT rowid,id AS user_id,paid_attempt_id AS attempt_id,paid_period_ends_at_ms FROM users WHERE paid_attempt_id IS NOT NULL;
    CREATE TABLE billing_attempts (id TEXT, user_id TEXT, payment_source_id TEXT, billing_period TEXT, paid_starts_at_ms INTEGER,paid_ends_at_ms INTEGER,paid_renewal_anchor_ms INTEGER);
 CREATE TABLE card_payment_sources (id TEXT, user_id TEXT, method TEXT);
 CREATE TABLE subscription_renewal_stops (user_id TEXT); CREATE VIEW subscription_renewal_fences AS SELECT * FROM subscription_renewal_stops;

    CREATE TABLE refund_attempts(id TEXT,adjusted_attempt_id TEXT,access_ends_at_ms INTEGER,renewal_stopped_user_id TEXT);`)
  );
  for (const [name, event, table] of [
    ["statement_submission_audit_no_update", "UPDATE", "statement_submission_audit"],
    ["statement_submission_audit_no_delete", "DELETE", "statement_submission_audit"],
  ]) {
    yield* wait(() =>
      db.prepare(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN SELECT 1; END`).run()
    );
  }
  yield* wait(() => installForwardingTestSchema({ db, tables: [] }));
  yield* wait(() => installAuditTestSchema(db));
  for (const user of [userA, userB]) {
    yield* wait(() =>
      db
        .prepare(
          "WITH fixture_user(id) AS (VALUES (?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) SELECT id,'CO','es-CO','America/Bogota',0 FROM fixture_user"
        )
        .bind(user)
        .run()
    );
    yield* wait(() =>
      db
        .prepare(
          "INSERT INTO consent_history (record_type,user_id,accepted_at_ms) VALUES ('processing_grant',?, 1)"
        )
        .bind(user)
        .run()
    );
  }
  yield* wait(() =>
    db
      .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?)")
      .bind(sessionA, userA, digest, 9_000_000_000_000, 9_000_000_000_000)
      .run()
  );
  return db;
});

afterEach(() =>
  Effect.runPromise(
    Effect.forEach(instances.splice(0), (instance) => wait(() => instance.dispose()), {
      discard: true,
    })
  )
);

it("issues unpredictable User-specific addresses at verified Consent and returns the same canonical address", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const subject = { id: sessionA, userId: userA, digest };
      const current = yield* Clock.currentTimeMillis;
      const enabled = yield* executeCanonicalWork({
        oauthConfirmation: Option.none(),
        db,
        subject,
        current,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("ingestion.enableEmailForwarding"),
          input: {},
        },
      });
      const body = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.Struct({ address: Schema.String }),
        })
      )(yield* wait(() => enabled.json()));
      expect(enabled.status).toBe(200);
      expect(body.data.address).toMatch(/^[a-f0-9]{48}@fidyapp\.com$/u);
      const query = yield* executeCanonicalQuery({
        db,
        subject,
        operation: CanonicalOperationId.make("ingestion.getEmailForwarding"),
        input: {},
        bucket: Option.none(),
      });
      expect(Option.isSome(query)).toBe(true);
      if (Option.isNone(query)) return;
      expect(query.value.status).toBe(200);
      expect(yield* wait(() => query.value.json())).toMatchObject({
        data: { address: { address: body.data.address }, remainingThisMonth: 30 },
      });
      expect(
        (yield* wait(() =>
          db
            .prepare(
              "SELECT operation FROM (SELECT id,user_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='publication') AS ingestion_publication_audit WHERE user_id = ? ORDER BY occurred_at_ms,operation"
            )
            .bind(userA)
            .all()
        )).results
      ).toEqual([
        { operation: "ingestion.enableEmailForwarding" },
        { operation: "ingestion.getEmailForwarding" },
      ]);
    })
  ));

it("returns unavailable without a defect when a retained forwarding creation date exceeds the Date range", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* wait(() =>
        db
          .prepare(
            "UPDATE users AS email_forwarding_addresses SET forwarding_issued_at_ms = ? WHERE forwarding_address_id IS NOT NULL AND id = ?"
          )
          .bind(8_640_000_000_000_001, userA)
          .run()
      );
      const outcome = yield* Effect.exit(
        forwardingAddressResponse({
          db,
          subject: { id: sessionA, userId: userA, digest },
          operation: "ingestion.getEmailForwarding",
        })
      );
      expect(outcome).toMatchObject({ _tag: "Success" });
      if (Exit.isFailure(outcome)) return;
      expect(outcome.value.status).toBe(503);
      expect(yield* wait(() => outcome.value.json())).toEqual({ status: "unavailable" });
    })
  ));

it("refuses a cross-User session subject and revoked Consent without disclosing an address or recording success", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const wrong = yield* forwardingAddressResponse({
        db,
        subject: { id: sessionA, userId: userB, digest },
        operation: "ingestion.getEmailForwarding",
      });
      expect(wrong.status).not.toBe(200);
      const current = yield* Clock.currentTimeMillis;
      const wrongMutation = yield* executeCanonicalWork({
        oauthConfirmation: Option.none(),
        db,
        subject: { id: sessionA, userId: userB, digest },
        current,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("ingestion.enableEmailForwarding"),
          input: {},
        },
      });
      expect(wrongMutation.status).not.toBe(200);
      yield* wait(() =>
        db
          .prepare(
            "INSERT INTO consent_history(record_type,user_id) VALUES ('processing_withdrawal',?)"
          )
          .bind(userA)
          .run()
      );
      const revoked = yield* forwardingAddressResponse({
        db,
        subject: { id: sessionA, userId: userA, digest },
        operation: "ingestion.getEmailForwarding",
      });
      expect(revoked.status).not.toBe(200);
      const revokedMutation = yield* executeCanonicalWork({
        oauthConfirmation: Option.none(),
        db,
        subject: { id: sessionA, userId: userA, digest },
        current,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("ingestion.enableEmailForwarding"),
          input: {},
        },
      });
      expect(revokedMutation.status).not.toBe(200);
      expect(
        (yield* wait(() =>
          db
            .prepare(
              "SELECT id FROM (SELECT id,user_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='publication') AS ingestion_publication_audit"
            )
            .all()
        )).results
      ).toHaveLength(0);
    })
  ));

it("canonical query dispatch refuses a mutation identity and an unavailable operation before owner work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const subject = { id: sessionA, userId: userA, digest };
      for (const operation of ["ingestion.enableEmailForwarding", "memory.unavailableOperation"]) {
        const response = yield* executeCanonicalQuery({
          db,
          subject,
          operation: CanonicalOperationId.make(operation),
          input: {},
          bucket: Option.none(),
        });
        expect(Option.isNone(response)).toBe(true);
      }
      expect(
        (yield* wait(() =>
          db
            .prepare(
              "SELECT id FROM (SELECT id,user_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='publication') AS ingestion_publication_audit"
            )
            .all()
        )).results
      ).toHaveLength(0);
    })
  ));
