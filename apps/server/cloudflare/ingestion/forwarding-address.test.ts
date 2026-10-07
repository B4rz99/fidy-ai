import { Clock, Data, Effect, Exit, Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import { applyTestMigration } from "../d1-test-fixture";
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
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY, accepted_at_ms INTEGER NOT NULL);
    CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY);
    CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT, token_digest BLOB, revoked_at_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER);
    CREATE TABLE statement_submission_audit (id TEXT PRIMARY KEY, user_id TEXT, operation TEXT, outcome TEXT, occurred_at_ms INTEGER);
    CREATE TABLE statement_review_audit (id TEXT PRIMARY KEY, user_id TEXT, operation TEXT, occurred_at_ms INTEGER);
    CREATE TABLE statement_submission_assertion (id INTEGER PRIMARY KEY CHECK (id = 1), accepted INTEGER CHECK (accepted = 1));
    CREATE TABLE transaction_audit (user_id TEXT, operation TEXT, occurred_at_ms INTEGER);
    CREATE TABLE pat_audit (user_id TEXT, pat_id TEXT, oauth_connection_id TEXT, oauth_credential_id TEXT, operation TEXT, occurred_at_ms INTEGER);
    CREATE TABLE statement_clarification_audit (id TEXT PRIMARY KEY, user_id TEXT, operation TEXT, outcome TEXT, occurred_at_ms INTEGER);
    CREATE TABLE category_audit (user_id TEXT, occurred_at_ms INTEGER);
    CREATE TABLE memory_audit (user_id TEXT, occurred_at_ms INTEGER);
    CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY, started_at_ms INTEGER, ends_at_ms INTEGER);
    CREATE TABLE subscriptions (user_id TEXT PRIMARY KEY, attempt_id TEXT, paid_period_ends_at_ms INTEGER);
    CREATE TABLE billing_attempts (id TEXT, user_id TEXT, payment_source_id TEXT, billing_period TEXT);
 CREATE TABLE card_payment_sources (id TEXT, user_id TEXT, method TEXT);
 CREATE TABLE subscription_renewal_stops (user_id TEXT); CREATE VIEW subscription_renewal_fences AS SELECT * FROM subscription_renewal_stops;
 CREATE TABLE billing_paid_periods (attempt_id TEXT PRIMARY KEY, starts_at_ms INTEGER, ends_at_ms INTEGER);
    CREATE TABLE billing_access_adjustments (attempt_id TEXT, ends_at_ms INTEGER);`)
  );
  for (const [name, event, table] of [
    ["statement_submission_audit_no_update", "UPDATE", "statement_submission_audit"],
    ["statement_submission_audit_no_delete", "DELETE", "statement_submission_audit"],
    ["statement_audit_daily_budget", "INSERT", "statement_submission_audit"],
    ["transaction_audit_daily_budget", "INSERT", "transaction_audit"],
    ["pat_canonical_daily_budget", "INSERT", "pat_audit"],
    ["category_canonical_daily_budget", "INSERT", "category_audit"],
    ["memory_canonical_daily_budget", "INSERT", "memory_audit"],
  ]) {
    yield* wait(() =>
      db.prepare(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} BEGIN SELECT 1; END`).run()
    );
  }
  for (const name of [
    "0017_forwarded_email",
    "0019_canonical_child_guards",
    "0032_commercial_allowances",
    "0034_forwarded_email_deferral",
  ]) {
    yield* wait(() =>
      applyTestMigration({ db, source: new URL(`../migrations/${name}.sql`, import.meta.url) })
    );
  }
  for (const user of [userA, userB]) {
    yield* wait(() => db.prepare("INSERT INTO users VALUES (?)").bind(user).run());
    yield* wait(() =>
      db.prepare("INSERT INTO onboarding_consent_records VALUES (?, 1)").bind(user).run()
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
        data: { address: { address: body.data.address }, remainingThisMonth: 50 },
      });
      expect(
        (yield* wait(() =>
          db
            .prepare("SELECT operation FROM statement_submission_audit WHERE user_id = ?")
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
          .prepare("UPDATE email_forwarding_addresses SET created_at_ms = ? WHERE user_id = ?")
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
        db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(userA).run()
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
        (yield* wait(() => db.prepare("SELECT id FROM statement_submission_audit").all())).results
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
        (yield* wait(() => db.prepare("SELECT id FROM statement_submission_audit").all())).results
      ).toHaveLength(0);
    })
  ));
