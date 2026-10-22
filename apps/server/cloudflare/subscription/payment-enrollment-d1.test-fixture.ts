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
  yield* fromPromise(() =>
    installCurrentTestObjects({
      db,
      tables: [
        "verified_email_credentials",
        "resource_admission_grants",
        "resource_admission_events",
        "billing_attempts",
        "billing_attempt_context",
        "billing_callback_hints",
        "billing_price_notices",
        "billing_provider_transactions",
        "billing_retry_clearances",
        "subscriptions",
        "subscription_cancellations",
        "subscription_cancellation_context",
        "payment_enrollments",
        "payment_sources",
        "payment_enrollment_context",
        "payment_source_context",
        "refund_attempts",
        "subscription_prices",
        "subscription_renewal_fences",
        "subscription_standing",
      ],
    })
  );
  return { db };
});

export const queuedBillingExecution = (): Pick<WorkflowInstance, "status" | "restart"> => ({
  status: () => Promise.resolve({ status: "queued" }),
  restart: () => Promise.resolve(),
});
