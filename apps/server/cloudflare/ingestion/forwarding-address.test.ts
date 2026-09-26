import { Clock, Data, Effect, Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { forwardingAddressResponse } from "./forwarding-address";
import {
  forwardingAddressMutationAdapter,
  prepareForwardingAddress,
} from "../mutations/forwarding-address-mutation";
import { executeCanonicalMutationUnit } from "../mutations/canonical-mutation-unit";
import { canonicalMutationAdapter } from "../mutations/canonical-mutation-registry";
import { CanonicalOperationId } from "@fidy/server/canonical-runtime";

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
    CREATE TABLE pat_audit (user_id TEXT, pat_id TEXT, operation TEXT, occurred_at_ms INTEGER);
    CREATE TABLE category_audit (user_id TEXT, occurred_at_ms INTEGER);
    CREATE TABLE memory_audit (user_id TEXT, occurred_at_ms INTEGER);
    CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY, started_at_ms INTEGER, ends_at_ms INTEGER);
    CREATE TABLE subscriptions (user_id TEXT PRIMARY KEY, attempt_id TEXT, paid_period_ends_at_ms INTEGER);
    CREATE TABLE billing_paid_periods (attempt_id TEXT PRIMARY KEY, starts_at_ms INTEGER);`)
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
  const migration = yield* wait(() =>
    Bun.file(new URL("../migrations/0017_forwarded_email.sql", import.meta.url)).text()
  );
  for (const statement of migration
    .replace(/^--.*$/gmu, "")
    .trim()
    .split(/;\s*\n(?=(?:CREATE|ALTER|INSERT|DROP) |$)/u)) {
    if (statement.trim().length > 0) yield* wait(() => db.prepare(statement.trim()).run());
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
      expect(
        Option.isSome(
          canonicalMutationAdapter(CanonicalOperationId.make("ingestion.enableEmailForwarding"))
        )
      ).toBe(true);
      const current = yield* Clock.currentTimeMillis;
      const prepared = yield* prepareForwardingAddress({
        db,
        subject,
        current,
        bucket: Option.none(),
        input: {},
      });
      expect(prepared._tag).toBe("Prepared");
      if (prepared._tag !== "Prepared") return;
      const execution = yield* executeCanonicalMutationUnit({
        db,
        subject,
        current,
        mutations: [prepared.mutation],
      });
      expect(execution._tag).toBe("Committed");
      if (execution._tag !== "Committed") return;
      const value = execution.values[0];
      if (value === undefined) return;
      const enabled = yield* forwardingAddressMutationAdapter.present(value);
      const body = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.Struct({ address: Schema.String }),
        })
      )(yield* wait(() => enabled.json()));
      expect(enabled.status).toBe(200);
      expect(body.data.address).toMatch(/^[a-f0-9]{48}@fidyapp\.com$/u);
      const read = yield* forwardingAddressResponse({
        db,
        subject,
        operation: "ingestion.getEmailForwarding",
      });
      expect(read.status).toBe(200);
      expect(yield* wait(() => read.json())).toMatchObject({
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
      yield* wait(() =>
        db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(userA).run()
      );
      const revoked = yield* forwardingAddressResponse({
        db,
        subject: { id: sessionA, userId: userA, digest },
        operation: "ingestion.getEmailForwarding",
      });
      expect(revoked.status).not.toBe(200);
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM statement_submission_audit").all())).results
      ).toHaveLength(0);
    })
  ));
