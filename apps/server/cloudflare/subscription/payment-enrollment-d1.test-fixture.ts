import { Effect } from "effect";
import { afterAll } from "vitest";
import {
  auditEntriesTestSchema,
  consentHistoryTestSchema,
  installCurrentTestObjects,
  isolatedTestDatabases,
} from "../d1-test-fixture";

const fromPromise = <A>(tryPromise: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(tryPromise).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

/** Fresh native D1 binding with immutable caller-owned auth DDL and production migrations.
 * The shared Worker closes at file teardown; no database, User, or seeded row is reused.
 */
export const makePaymentEnrollmentD1 = Effect.fnUntraced(function* (
  authSchema: ReadonlyArray<string>
) {
  const db = yield* fromPromise(() => databases.acquire());
  yield* fromPromise(() =>
    db.batch(
      [...authSchema, auditEntriesTestSchema, consentHistoryTestSchema]
        .filter((sql) => sql.trim().length > 0)
        .map((sql) => db.prepare(sql))
    )
  );
  yield* fromPromise(() => db.prepare("ALTER TABLE users ADD COLUMN subscription_id TEXT").run());
  yield* fromPromise(() =>
    db.batch(
      [
        "cancellation_paid_attempt_id TEXT",
        "cancellation_payment_source_id TEXT",
        "cancellation_cancelled_at_ms INTEGER",
        "cancellation_paid_through_ms INTEGER",
        "cancellation_source_cancellation TEXT",
        "cancellation_void_started_at_ms INTEGER",
        "cancellation_void_verified_at_ms INTEGER",
        "cancellation_verification_count INTEGER",
        "cancellation_last_offered_at_ms INTEGER",
      ].map((column) => db.prepare(`ALTER TABLE users ADD COLUMN ${column}`))
    )
  );

  yield* fromPromise(() =>
    installCurrentTestObjects({
      db,
      tables: [
        "resource_admission_grants",
        "resource_admission_events",
        "billing_attempts",
        "billing_callback_hints",
        "billing_price_notices",
        "billing_provider_transactions",
        "billing_retry_clearances",
        "card_enrollments",
        "verified_payment_sources",
        "refund_attempts",
        "subscription_prices",
        "subscription_renewal_fences",
        "subscription_standing",
      ],
      objects: ["users_subscription_id", "subscription_identities_field_"],
    })
  );
  return { db };
});
