import { fileURLToPath } from "node:url";
import { Clock, Effect } from "effect";
import { Miniflare } from "miniflare";

const miniflare = new Miniflare({
  workers: [
    {
      config: {
        compatibilityDate: "2026-09-08",
        env: { DB: { id: "browser-acceptance", type: "d1" } },
        manifest: {
          mainModule: "index.mjs",
          modules: {
            "index.mjs": {
              contents: "export default {fetch() {return new Response('ok')}}",
              type: "esm",
            },
          },
        },
        name: "browser-acceptance",
        type: "worker",
      },
    },
  ],
});
await miniflare.ready;
export const db = await miniflare.getD1Database("DB");
const migrationDirectory = new URL("./migrations/", import.meta.url);
const migrations = Array.from(
  new Bun.Glob("*.sql").scanSync({ cwd: fileURLToPath(migrationDirectory) })
).sort();
const applyMigration = (name: string): Promise<void> =>
  Bun.file(new URL(name, migrationDirectory))
    .text()
    .then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)
        .reduce<Promise<void>>(
          (previous, statement) =>
            previous.then(() => db.prepare(statement).run()).then(() => undefined),
          Promise.resolve()
        )
    );
await migrations.reduce<Promise<void>>(
  (previous, name) => previous.then(() => applyMigration(name)),
  Promise.resolve()
);

// This identity is confined to Miniflare. The separate loopback operator simulates a verified
// WhatsApp approval; the browser still obtains its cookie only by redeeming with the real Core.
export const fixtureUserId = "24000000-0000-4000-8000-000000000241";
export const firstCardUserId = "24000000-0000-4000-8000-000000000281";
const otherUserId = "24000000-0000-4000-8000-000000000261";
const otherTransactionId = "24000000-0000-4000-8000-000000000262";
const backupRecoveryCode = "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2";
const now = Effect.runSync(Clock.currentTimeMillis);
const trialDurationMs = 604_800_000;
type SeedIdentity = Readonly<{
  userId: string;
  bsuid: string;
  email: string;
  consentId: string;
  disclosure: string;
  decision: string;
}>;
const defaultIdentity: SeedIdentity = {
  userId: fixtureUserId,
  bsuid: "CO.Acceptance",
  email: "usuario@example.com",
  consentId: "24000000-0000-4000-8000-000000000260",
  disclosure: "disclosure",
  decision: "decision",
};
// @effect-diagnostics-next-line asyncFunction:off
const seedIdentity = async (overrides: Partial<SeedIdentity> = {}): Promise<void> => {
  const identity = { ...defaultIdentity, ...overrides };
  await db
    .prepare(
      "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?,?,?,?,?)"
    )
    .bind(identity.userId, "CO", "es-CO", "America/Bogota", now)
    .run();
  await db
    .prepare(
      "INSERT INTO whatsapp_identities (user_id, portfolio_id, bsuid, verified_at_ms) VALUES (?,?,?,?)"
    )
    .bind(identity.userId, "acceptance-portfolio", identity.bsuid, now)
    .run();
  await db
    .prepare(
      "INSERT INTO verified_email_credentials (user_id, email_address, verified_at_ms) VALUES (?,?,?)"
    )
    .bind(identity.userId, identity.email, now)
    .run();
  await db
    .prepare("INSERT INTO trial_periods (user_id, started_at_ms, ends_at_ms) VALUES (?,?,?)")
    .bind(identity.userId, now, now + trialDurationMs)
    .run();
  await db
    .prepare(`INSERT INTO onboarding_consent_records
    (id, user_id, disclosure_json, disclosure_message_id, decision_message_id,
     decision_received_at_ms, accepted_at_ms) VALUES (?,?,?,?,?,?,?)`)
    .bind(
      identity.consentId,
      identity.userId,
      "{}",
      identity.disclosure,
      identity.decision,
      now,
      now
    )
    .run();
};
await seedIdentity();
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
const enrollmentLifetimeMs = 900_000;
await db
  .prepare(`INSERT INTO card_enrollments
  (id, user_id, price_id, billing_email, status, payment_source_mode, contracts_json,
   disclosure_json, prepared_at_ms, expires_at_ms, wompi_candidate_source_id)
  VALUES (?, ?, ?, ?, 'creating', 'create', '{}', '{}', ?, ?, ?)`)
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
// A second User has verified credentials and consent but no CardPaymentSource. It must
// traverse first-time tokenization instead of silently reusing the primary User's source.
await seedIdentity({
  userId: firstCardUserId,
  bsuid: "CO.FirstCard",
  email: "tarjeta@example.com",
  consentId: "24000000-0000-4000-8000-000000000282",
});

const recoveryDigest = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(backupRecoveryCode))
);
await db
  .prepare(
    "INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at_ms) VALUES (?,?,?)"
  )
  .bind(fixtureUserId, recoveryDigest, now)
  .run();
