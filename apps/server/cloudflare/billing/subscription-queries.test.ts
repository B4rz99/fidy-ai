import type { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { SubscriptionOffers, SubscriptionStatus } from "@fidy/server/subscription-runtime";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import coreWorker from "../core-worker";
import { makeCardEnrollmentD1 } from "../card-enrollment/card-enrollment-d1.test-fixture";
import { executeProtectedSubscriptionQuery } from "./subscription-queries";

const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const sessionA = "20000000-0000-4000-8000-000000000001";
const sessionB = "20000000-0000-4000-8000-000000000002";
const patId = "30000000-0000-4000-8000-000000000001";
const token = new Uint8Array(32);
const pastEnd = Date.parse("2026-09-08T12:00:00Z");
let instance: Option.Option<Miniflare> = Option.none();
let fixtureNumber = 0;
// @effect-diagnostics-next-line asyncFunction:off
afterEach(async () => {
  if (Option.isSome(instance)) await instance.value.dispose();
  instance = Option.none();
});

// @effect-diagnostics-next-line asyncFunction:off
const fixture = async (): Promise<D1Database> => {
  const created = await Effect.runPromise(
    makeCardEnrollmentD1(`subscription-query-${++fixtureNumber}`, [
      "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
      "CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL) STRICT",
      "CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_digest BLOB NOT NULL, revoked_at_ms INTEGER, idle_expires_at_ms INTEGER NOT NULL, hard_expires_at_ms INTEGER NOT NULL) STRICT",
      "CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY) STRICT",
      "CREATE TABLE pat_audit (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, pat_id TEXT, operation TEXT NOT NULL, outcome TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL) STRICT",
      "CREATE TABLE pat_atomic_assertion (id INTEGER PRIMARY KEY CHECK (id = 1), accepted INTEGER NOT NULL CHECK (accepted = 1)) STRICT",
      "CREATE TABLE pats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bearer_digest BLOB NOT NULL, scopes_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, last_used_at_ms INTEGER) STRICT",
    ])
  );
  instance = Option.some(created.instance);
  const db = created.db;
  const migration = await Bun.file(
    new URL("../migrations/0016_subscription_standing.sql", import.meta.url)
  ).text();
  await db.batch(
    migration
      .replace(/^--.*$/gmu, "")
      .trim()
      .split(/;\s*\n(?=CREATE |DROP |$)/u)
      .map((statement) => db.prepare(statement))
  );
  const past = Date.parse("2026-09-01T12:00:00Z");
  const future = Effect.runSync(Clock.currentTimeMillis) + 86_400_000;
  await db.batch([
    db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(userA),
    db.prepare("INSERT INTO users VALUES (?, 'America/Bogota')").bind(userB),
    db.prepare("INSERT INTO trial_periods VALUES (?, ?, ?)").bind(userA, past, past + 604_800_000),
    db.prepare("INSERT INTO trial_periods VALUES (?, ?, ?)").bind(userB, past, past + 604_800_000),
    db
      .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?)")
      .bind(sessionA, userA, token, future, future),
    db
      .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?)")
      .bind(sessionB, userB, token, future, future),
    db
      .prepare("INSERT INTO pats VALUES (?, ?, ?, '[\"write\"]', ?, NULL, NULL)")
      .bind(patId, userA, token, future),
  ]);
  return db;
};

// @effect-diagnostics-next-line asyncFunction:off
it("returns only the authenticated User's expired trial and rejects a wrong bearer without an audit", async () => {
  const db = await fixture();
  const subject = { id: sessionA, userId: userA, digest: token };
  const response = await executeProtectedSubscriptionQuery({
    db,
    subject,
    operation: "subscription.getSubscriptionStatus",
  });
  expect(response.status).toBe(200);
  const body = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(SubscriptionStatus) })
  )(await response.json());
  expect(body.data.accessTier).toBe("free");
  expect(body.data.trialPeriod.startedAt.epochMilliseconds).toBe(
    Date.parse("2026-09-01T12:00:00Z")
  );
  expect(body.data.recentAttempts).toEqual([]);
  const foreign = await executeProtectedSubscriptionQuery({
    db,
    subject: { ...subject, userId: userB },
    operation: "subscription.getSubscriptionStatus",
  });
  expect(foreign.status).toBe(401);
  expect((await db.prepare("SELECT * FROM pat_audit").all()).results).toHaveLength(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("cannot renew the original TrialPeriod by updating its persisted interval", async () => {
  const db = await fixture();
  await expect(
    db
      .prepare("UPDATE trial_periods SET ends_at_ms = ends_at_ms + 604800000 WHERE user_id = ?")
      .bind(userA)
      .run()
  ).rejects.toThrow();
  const response = await executeProtectedSubscriptionQuery({
    db,
    subject: { id: sessionA, userId: userA, digest: token },
    operation: "subscription.getSubscriptionStatus",
  });
  const body = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(SubscriptionStatus) })
  )(await response.json());
  expect(body.data.trialPeriod.endsAt.epochMilliseconds).toBe(pastEnd);
});

// @effect-diagnostics-next-line asyncFunction:off
it("refuses an under-scoped PAT without exposing standing or recording successful work", async () => {
  const db = await fixture();
  const subject = {
    patId,
    userId: userA,
    digest: token,
    requiredScope: Option.some("read" as const),
  };
  const operations = [
    "subscription.getSubscriptionStatus",
    "subscription.listSubscriptionOffers",
  ] as const;
  const responses = await Promise.all(
    operations.map((operation) => executeProtectedSubscriptionQuery({ db, subject, operation }))
  );
  for (const response of responses) {
    expect(response.status).toBe(401);
  }
  expect((await db.prepare("SELECT * FROM pat_audit").all()).results).toHaveLength(0);
  expect(
    await db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
  ).toEqual({ last_used_at_ms: null });
});

// @effect-diagnostics-next-line asyncFunction:off
it("refuses a revoked WebSession at the canonical HTTP boundary without recording accepted work", async () => {
  const db = await fixture();
  const bearer = "1".repeat(43);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))
  );
  await db
    .prepare("UPDATE web_sessions SET token_digest = ? WHERE id = ?")
    .bind(digest, sessionA)
    .run();
  const environment: Parameters<typeof coreWorker.fetch>[1] = {
    AI: { run: () => Promise.reject(new Error("unused")) },
    DB: db,
    HOSTED_AI_MODEL: approvedWorkersAiModel,
    CONTRACT_DIGEST: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    BROWSER_ORIGIN: "https://app.fidyapp.com",
    WOMPI_ENVIRONMENT: "sandbox",
    WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
    WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
    WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
    USER_TRANSACTION_COORDINATOR: {
      getByName: (): { fetch: () => Promise<Response> } => ({
        fetch: (): Promise<Response> => Promise.reject(new Error("unused")),
      }),
    },
    KAPSO_WEBHOOK_SECRET: "",
    CLOUDFLARE_ACCESS_ISSUER: "",
    CLOUDFLARE_ACCESS_AUDIENCE: "",
    KAPSO_API_KEY: "",
    WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
    RELEASE_GIT_SHA: "",
  };
  const request = (): Request =>
    new Request("https://core.internal/subscription/status", {
      headers: { cookie: `__Host-fidy_session=${bearer}` },
    });
  const before = await coreWorker.fetch(request(), environment);
  expect(before.status).toBe(200);
  expect((await db.prepare("SELECT * FROM pat_audit").all()).results).toHaveLength(1);
  await db
    .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
    .bind(Effect.runSync(Clock.currentTimeMillis), sessionA)
    .run();
  const after = await coreWorker.fetch(request(), environment);
  expect(after.status).toBe(401);
  expect(await after.text()).not.toContain("trialPeriod");
  expect((await db.prepare("SELECT * FROM pat_audit").all()).results).toHaveLength(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("refuses an invalid WebSession before returning published Subscription Prices", async () => {
  const db = await fixture();
  const denied = await executeProtectedSubscriptionQuery({
    db,
    subject: { id: sessionA, userId: userA, digest: new Uint8Array(32).fill(1) },
    operation: "subscription.listSubscriptionOffers",
  });
  expect(denied.status).toBe(401);
  const accepted = await executeProtectedSubscriptionQuery({
    db,
    subject: { id: sessionB, userId: userB, digest: token },
    operation: "subscription.listSubscriptionOffers",
  });
  expect(accepted.status).toBe(200);
  const result = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(SubscriptionOffers) })
  )(await accepted.json());
  expect(result.data).toHaveLength(3);
  expect(result.data[0].billingPeriod).toBe("weekly");
  expect(result.data[0].money.currency).toBe("COP");
});
