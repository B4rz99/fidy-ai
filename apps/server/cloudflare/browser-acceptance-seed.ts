import { Clock, Effect } from "effect";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";

const databases = isolatedTestDatabases();
export const db = await databases.acquire();
const migrationDirectory = new URL("./migrations/", import.meta.url);
const migrations = Array.from(new Bun.Glob("*.sql").scanSync(migrationDirectory.pathname)).sort();
// Acceptance needs the final native schema; migration-boundary tests run separately.
await installTestSchema({
  db,
  sources: migrations.map((name) => new URL(name, migrationDirectory)),
});

// This identity is confined to Miniflare. The separate loopback operator simulates a verified
// WhatsApp approval; the browser still obtains its cookie only by redeeming with the real Core.
export const fixtureUserId = "24000000-0000-4000-8000-000000000241";
export const firstCardUserId = "24000000-0000-4000-8000-000000000281";
export const firstDaviplataUserId = "24000000-0000-4000-8000-000000000291";
const otherUserId = "24000000-0000-4000-8000-000000000261";
const otherTransactionId = "24000000-0000-4000-8000-000000000262";
const backupRecoveryCode = "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2";
const recoveryUserId = "24000000-0000-4000-8000-000000000311";
export const pairingUserId = "24000000-0000-4000-8000-000000000321";
const now = Effect.runSync(Clock.currentTimeMillis);
const trialDurationMs = 604_800_000;
const expiredTrialAgeMs = 691_200_000;
type SeedIdentity = Readonly<{
  userId: string;
  bsuid: string;
  email: string;
  consentId: string;
  disclosure: string;
  decision: string;
  createdAtMs: number;
}>;
const defaultIdentity: SeedIdentity = {
  userId: fixtureUserId,
  bsuid: "CO.Acceptance",
  email: "usuario@example.com",
  consentId: "24000000-0000-4000-8000-000000000260",
  disclosure: "disclosure",
  decision: "decision",
  createdAtMs: now,
};
const seedIdentity = (overrides: Partial<SeedIdentity> = {}): Promise<void> => {
  const identity = { ...defaultIdentity, ...overrides };
  const statements = [
    db
      .prepare(
        "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?,?,?,?,?)"
      )
      .bind(identity.userId, "CO", "es-CO", "America/Bogota", identity.createdAtMs),
    db
      .prepare(
        "INSERT INTO whatsapp_identities (user_id, portfolio_id, bsuid, verified_at_ms) VALUES (?,?,?,?)"
      )
      .bind(identity.userId, "acceptance-portfolio", identity.bsuid, identity.createdAtMs),
    db
      .prepare(
        "INSERT INTO verified_email_credentials (user_id, email_address, verified_at_ms) VALUES (?,?,?)"
      )
      .bind(identity.userId, identity.email, identity.createdAtMs),
    db
      .prepare("INSERT INTO trial_periods (user_id, started_at_ms, ends_at_ms) VALUES (?,?,?)")
      .bind(identity.userId, identity.createdAtMs, identity.createdAtMs + trialDurationMs),
    db
      .prepare(`INSERT INTO onboarding_consent_records
    (id, user_id, disclosure_json, disclosure_message_id, decision_message_id,
     decision_received_at_ms, accepted_at_ms) VALUES (?,?,?,?,?,?,?)`)
      .bind(
        identity.consentId,
        identity.userId,
        "{}",
        identity.disclosure,
        identity.decision,
        identity.createdAtMs,
        identity.createdAtMs
      ),
  ];
  return statements.reduce<Promise<void>>(
    (previous, statement) => previous.then(() => statement.run()).then(() => undefined),
    Promise.resolve()
  );
};
await seedIdentity();
// Pairing owns its standing and Dashboard; enrollment journeys may run first or concurrently.
await seedIdentity({
  userId: pairingUserId,
  bsuid: "CO.Pairing",
  email: "vinculacion@example.com",
  consentId: "24000000-0000-4000-8000-000000000322",
});
await db
  .prepare(
    "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?,?,?,?,?)"
  )
  .bind(otherUserId, "CO", "es-CO", "America/Bogota", now)
  .run();
await db
  .prepare(`INSERT INTO transactions
  (id, user_id, amount, currency, direction, counterparty, category_id, occurred_at, created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`)
  .bind(
    otherTransactionId,
    otherUserId,
    "100",
    "COP",
    "outflow",
    "OTHER-USER-PRIVATE",
    "10000000-0000-4000-8000-000000000001",
    "2026-09-27T12:00:00.000Z",
    "2026-09-27T12:00:00.000Z"
  )
  .run();
const sourceEnrollmentId = "24000000-0000-4000-8000-000000000271";
export const sourceId = 3891;
export const firstCardSourceId = 3892;
export const firstDaviplataSourceId = 8276;
const enrollmentLifetimeMs = 900_000;
await db
  .prepare(`INSERT INTO card_enrollments
  (id, user_id, price_id, billing_email, status, payment_source_mode, contracts_json,
   disclosure_json, prepared_at_ms, expires_at_ms, wompi_candidate_source_id, wompi_environment)
  VALUES (?, ?, ?, ?, 'creating', 'create', '{}', '{}', ?, ?, ?, 'sandbox')`)
  .bind(
    sourceEnrollmentId,
    fixtureUserId,
    "22700000-0000-4000-8000-000000000001",
    "usuario@example.com",
    now,
    now + enrollmentLifetimeMs,
    sourceId
  )
  .run();
await db
  .prepare(`INSERT INTO card_payment_sources
  (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms)
  VALUES (?, ?, ?, ?, ?, ?)`)
  .bind(
    "24000000-0000-4000-8000-000000000272",
    fixtureUserId,
    sourceEnrollmentId,
    sourceId,
    "usuario@example.com",
    now
  )
  .run();
await db
  .prepare("UPDATE card_enrollments SET status = 'available' WHERE id = ?")
  .bind(sourceEnrollmentId)
  .run();
// A second User has verified credentials and consent but no PaymentSource. It must
// traverse first-time tokenization instead of silently reusing the primary User's source.
await seedIdentity({
  userId: firstCardUserId,
  bsuid: "CO.FirstCard",
  email: "tarjeta@example.com",
  consentId: "24000000-0000-4000-8000-000000000282",
});

// The browser suite retains history in one D1. DaviPlata must not inherit the first CARD source.
await seedIdentity({
  userId: firstDaviplataUserId,
  bsuid: "CO.FirstDaviplata",
  email: "daviplata@example.com",
  consentId: "24000000-0000-4000-8000-000000000292",
  // Born eight days ago: original TrialPeriod is expired before any payment is verified.
  createdAtMs: now - expiredTrialAgeMs,
});

const recoveryDigest = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(backupRecoveryCode))
);
// Recovery revokes existing sessions. Its parallel journey must not invalidate the
// ordinary pairing journey's User while that browser is exercising financial operations.
await seedIdentity({
  userId: recoveryUserId,
  bsuid: "CO.Recovery",
  email: "recuperacion@example.com",
  consentId: "24000000-0000-4000-8000-000000000312",
});
await db
  .prepare(
    "INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at_ms) VALUES (?,?,?)"
  )
  .bind(recoveryUserId, recoveryDigest, now)
  .run();
