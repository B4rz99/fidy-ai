import { Clock, DateTime, Effect, Schema } from "effect";
import { DisclosureSnapshot } from "../src/shell/consent/contract";
import { currentDisclosureFor } from "../src/shell/consent/operations";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";

const databases = isolatedTestDatabases();
export const db = await databases.acquire();

await installTestSchema({ db });

export const fixtureUserId = "24000000-0000-4000-8000-000000000241";
export const firstCardUserId = "24000000-0000-4000-8000-000000000281";
export const firstDaviplataUserId = "24000000-0000-4000-8000-000000000291";
const otherUserId = "24000000-0000-4000-8000-000000000261";
const otherTransactionId = "24000000-0000-4000-8000-000000000262";
const backupRecoveryCode = "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2";
const recoveryUserId = "24000000-0000-4000-8000-000000000311";
export const pairingUserId = "24000000-0000-4000-8000-000000000321";
export const dashboardUserId = "24000000-0000-4000-8000-000000000351";
export const budgetEditingUserId = "24000000-0000-4000-8000-000000000491";
export const budgetUserId = "24000000-0000-4000-8000-000000000371";
export const privacyUserId = "24000000-0000-4000-8000-000000000381";
export const privacyErasureUserId = "24000000-0000-4000-8000-000000000441";
export const privacyRenewalUserId = "24000000-0000-4000-8000-000000000431";
export const accessUserId = "24000000-0000-4000-8000-000000000361";
export const paginationUserId = "24000000-0000-4000-8000-000000000341";
export const recurringUserId = "24000000-0000-4000-8000-000000000401";
export const recurringSummaryUserId = "24000000-0000-4000-8000-000000000411";
export const recurringEditingUserId = "24000000-0000-4000-8000-000000000501";
export const recurringIsolatedIdentities = [
  { key: "recurringRecoveryUnavailable", userId: "24000000-0000-4000-8000-000000000421" },
  { key: "recurringRecoveryMalformed", userId: "24000000-0000-4000-8000-000000000611" },
  { key: "recurringRecoveryLimited", userId: "24000000-0000-4000-8000-000000000621" },
  { key: "recurringRecoveryPressure", userId: "24000000-0000-4000-8000-000000000631" },
  { key: "recurringLifecycle", userId: "24000000-0000-4000-8000-000000000581" },
  { key: "recurringTracking", userId: "24000000-0000-4000-8000-000000000561" },
  { key: "recurringExceptions", userId: "24000000-0000-4000-8000-000000000571" },
  { key: "recurringChat", userId: "24000000-0000-4000-8000-000000000541" },
  { key: "recurringPagination", userId: "24000000-0000-4000-8000-000000000551" },
] as const;
export const navigationIdentities = [
  { key: "navigationConsent", userId: "24000000-0000-4000-8000-000000000651" },
  { key: "navigationLoading", userId: "24000000-0000-4000-8000-000000000641" },
  { key: "navigationReviewBudget", userId: "24000000-0000-4000-8000-000000000591" },
  { key: "navigationReviewTransactions", userId: "24000000-0000-4000-8000-000000000601" },
  { key: "navigationClock", userId: "24000000-0000-4000-8000-000000000511" },
  { key: "navigationTransactions", userId: "24000000-0000-4000-8000-000000000451" },
  { key: "navigationBudget", userId: "24000000-0000-4000-8000-000000000461" },
  { key: "navigationRecurring", userId: "24000000-0000-4000-8000-000000000471" },
  { key: "navigationDashboard", userId: "24000000-0000-4000-8000-000000000481" },
] as const;
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
        "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES (?,?,?,?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
      )
      .bind(identity.userId, "acceptance-portfolio", identity.bsuid, identity.createdAtMs),
    db
      .prepare(
        "WITH incoming(user_id,email_address,verified_at_ms) AS (VALUES (?,?,?)) INSERT INTO verified_email_credentials(user_id,address,verified_at_ms) SELECT incoming.user_id,incoming.email_address,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,verified_at_ms=excluded.verified_at_ms"
      )
      .bind(identity.userId, identity.email, identity.createdAtMs),
    db
      .prepare("UPDATE users SET trial_started_at_ms=?2,trial_ends_at_ms=?3 WHERE id=?1")
      .bind(identity.userId, identity.createdAtMs, identity.createdAtMs + trialDurationMs),
    db
      .prepare(`INSERT INTO consent_history (record_type,id, user_id, disclosure_json, disclosure_message_id, decision_message_id,
     decision_received_at_ms, occurred_at_ms) VALUES ('processing_grant',?,?,?,?,?,?,?)`)
      .bind(
        identity.consentId,
        identity.userId,
        Schema.encodeSync(Schema.fromJsonString(DisclosureSnapshot))(currentDisclosureFor()),
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
await Promise.all(
  [...navigationIdentities, ...recurringIsolatedIdentities].map((identity) =>
    seedIdentity({
      userId: identity.userId,
      bsuid: `CO.${identity.key}`,
      email: `${identity.key.toLowerCase()}@example.com`,
      consentId: `${identity.userId.slice(0, -1)}2`,
    })
  )
);
await seedIdentity({
  userId: recurringUserId,
  bsuid: "CO.Recurring",
  email: "recurrentes@example.com",
  consentId: "24000000-0000-4000-8000-000000000402",
});
await seedIdentity({
  userId: recurringSummaryUserId,
  bsuid: "CO.RecurringSummary",
  email: "resumen-recurrentes@example.com",
  consentId: "24000000-0000-4000-8000-000000000412",
});
await seedIdentity({
  userId: recurringEditingUserId,
  bsuid: "CO.RecurringEditing",
  email: "edicion-recurrentes@example.com",
  consentId: "24000000-0000-4000-8000-000000000502",
});
await seedIdentity({
  userId: privacyUserId,
  bsuid: "CO.Privacy",
  email: "privacidad@example.com",
  consentId: "24000000-0000-4000-8000-000000000382",
  createdAtMs: now - expiredTrialAgeMs,
});
await seedIdentity({
  userId: privacyErasureUserId,
  bsuid: "CO.PrivacyErasure",
  email: "eliminacion-privacidad@example.com",
  consentId: "24000000-0000-4000-8000-000000000442",
  createdAtMs: now - expiredTrialAgeMs,
});
await seedIdentity({
  userId: privacyRenewalUserId,
  bsuid: "CO.PrivacyRenewal",
  email: "renovacion-privacidad@example.com",
  consentId: "24000000-0000-4000-8000-000000000432",
  createdAtMs: now - expiredTrialAgeMs,
});
await db
  .prepare(
    "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,notes,occurred_at,created_at) VALUES('24000000-0000-4000-8000-000000000383',?,'12000','COP','outflow','10000000-0000-4000-8000-000000000001','Solicitud de acceso de prueba','2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z')"
  )
  .bind(privacyUserId)
  .run();
await seedIdentity({
  userId: dashboardUserId,
  bsuid: "CO.Dashboard",
  email: "tablero@example.com",
  consentId: "24000000-0000-4000-8000-000000000352",
});
await seedIdentity({
  userId: budgetEditingUserId,
  bsuid: "CO.BudgetEditing",
  email: "budget-editing@example.com",
  consentId: "24000000-0000-4000-8000-000000000492",
});
await seedIdentity({
  userId: budgetUserId,
  bsuid: "CO.Budget",
  email: "presupuesto@example.com",
  consentId: "24000000-0000-4000-8000-000000000372",
});
await seedIdentity({
  userId: paginationUserId,
  bsuid: "CO.Pagination",
  email: "paginacion@example.com",
  consentId: "24000000-0000-4000-8000-000000000342",
});
await seedIdentity({
  userId: accessUserId,
  bsuid: "CO.Access",
  email: "accesos@example.com",
  consentId: "24000000-0000-4000-8000-000000000362",
});
const connectionPageSize = 25;
const connectionSuffixWidth = 12;
await db.batch(
  Array.from({ length: connectionPageSize + 1 }, (_, index) => {
    const suffix = String(index + 1).padStart(connectionSuffixWidth, "0");
    return db
      .prepare(`INSERT INTO oauth_connections
      (id, request_id, user_id, client_id, claimed_client_name, redirect_uri, resource,
       scopes_json, approved_at_ms, expires_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        `26000000-0000-4000-8000-${suffix}`,
        `27000000-0000-4000-8000-${suffix}`,
        accessUserId,
        "synthetic-metadata-client",
        `Agente paginado ${index + 1}`,
        "https://client.test/callback",
        "https://api.fidyapp.com/mcp",
        '["read"]',
        now,
        now + trialDurationMs
      );
  })
);
const historyPageSize = 100;
const continuationRecords = 5;
const millisecondsPerDay = 86_400_000;
const uuidSuffixWidth = 12;
await db.batch(
  Array.from({ length: historyPageSize + continuationRecords }, (_, index) => {
    const createdAt = now - (index < continuationRecords ? millisecondsPerDay : 0);
    return db
      .prepare(`INSERT INTO transactions
      (id, user_id, amount, currency, direction, counterparty, category_id, occurred_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(
        `25000000-0000-4000-8000-${String(index + 1).padStart(uuidSuffixWidth, "0")}`,
        paginationUserId,
        "1000",
        "COP",
        "outflow",
        `Registro paginado ${index}`,
        "10000000-0000-4000-8000-000000000001",
        DateTime.formatIso(DateTime.makeUnsafe(now)),
        DateTime.formatIso(DateTime.makeUnsafe(createdAt))
      );
  })
);
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
  .prepare(
    `UPDATE card_enrollments SET source_method='card',payment_source_id=incoming.id,source_wompi_id=incoming.wompi_source_id,source_billing_email=incoming.billing_email,source_created_at_ms=incoming.created_at_ms FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms FROM (VALUES (?, ?, ?, ?, ?, ?))) incoming WHERE card_enrollments.id=incoming.enrollment_id AND card_enrollments.user_id=incoming.user_id`
  )
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
await seedIdentity({
  userId: firstCardUserId,
  bsuid: "CO.FirstCard",
  email: "tarjeta@example.com",
  consentId: "24000000-0000-4000-8000-000000000282",
});
// Provider-authenticated Users need not establish the optional email-login credential.
await db
  .prepare("DELETE FROM verified_email_credentials WHERE user_id = ?")
  .bind(firstCardUserId)
  .run();

await seedIdentity({
  userId: firstDaviplataUserId,
  bsuid: "CO.FirstDaviplata",
  email: "daviplata@example.com",
  consentId: "24000000-0000-4000-8000-000000000292",
  createdAtMs: now - expiredTrialAgeMs,
});

const recoveryDigest = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(backupRecoveryCode))
);
await seedIdentity({
  userId: recoveryUserId,
  bsuid: "CO.Recovery",
  email: "recuperacion@example.com",
  consentId: "24000000-0000-4000-8000-000000000312",
});
await db
  .prepare(
    "INSERT INTO backup_recovery_credentials(user_id,code_digest,created_at_ms,revision) VALUES(?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET code_digest=excluded.code_digest,created_at_ms=excluded.created_at_ms,consumed_at_ms=NULL,revision=excluded.revision"
  )
  .bind(recoveryUserId, recoveryDigest, now)
  .run();

const recoveryDisclosureUserId = "24000000-0000-4000-8000-000000000331";
const recoveryDisclosureDigest = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode("23456-789AB-CDEFG-HJKLM-NPQRS"))
);
await seedIdentity({
  userId: recoveryDisclosureUserId,
  bsuid: "CO.RecoveryDisclosure",
  email: "recovery-disclosure@example.com",
  consentId: "24000000-0000-4000-8000-000000000332",
});
await db
  .prepare(
    "INSERT INTO backup_recovery_credentials(user_id,code_digest,created_at_ms,revision) VALUES(?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET code_digest=excluded.code_digest,created_at_ms=excluded.created_at_ms,consumed_at_ms=NULL,revision=excluded.revision"
  )
  .bind(recoveryDisclosureUserId, recoveryDisclosureDigest, now)
  .run();
