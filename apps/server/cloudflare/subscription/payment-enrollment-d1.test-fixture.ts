import { Data, Effect } from "effect";
import { afterAll } from "vitest";
import { installTestSchemaWithPrefix, isolatedTestDatabases } from "../d1-test-fixture";

class FixtureFailure extends Data.TaggedError("FixtureFailure") {}
const fromPromise = <A>(tryPromise: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: tryPromise, catch: () => new FixtureFailure() }).pipe(Effect.orDie);
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
    installTestSchemaWithPrefix({
      db,
      prefixStatements: authSchema,
      sources: [
        "0002_resource_admission.sql",
        "0009_card_enrollment.sql",
        "0012_billing_collection.sql",
        "0030_payment_enrollment.sql",
        "0031_daviplata_enrollment.sql",
        "0035_billing_corrections.sql",
        "0052_weekly_card_renewal.sql",
        "0053_calendar_card_renewal.sql",
        "0058_wallet_renewal.sql",
        "0059_subscription_retries.sql",
        "0060_subscription_cancellation.sql",
      ].map((file) => new URL(`../migrations/${file}`, import.meta.url)),
    })
  );
  return { db };
});
