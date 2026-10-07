import { Data, Effect } from "effect";
import { Miniflare } from "miniflare";
import { applyTestMigration } from "../d1-test-fixture";

class FixtureFailure extends Data.TaggedError("FixtureFailure") {}
const fromPromise = <A>(tryPromise: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: tryPromise, catch: () => new FixtureFailure() }).pipe(Effect.orDie);

/** Isolated D1 fixture with the production PaymentEnrollment migration and caller-owned auth tables. */
export const makePaymentEnrollmentD1 = Effect.fnUntraced(function* (
  name: string,
  authSchema: ReadonlyArray<string>
) {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: name, type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch() {return new Response('ok')}}",
                type: "esm",
              },
            },
          },
          name,
          type: "worker",
        },
      },
    ],
  });
  yield* fromPromise(() => instance.ready);
  const db = yield* fromPromise(() => instance.getD1Database("DB"));
  yield* fromPromise(() => db.batch(authSchema.map((statement) => db.prepare(statement))));
  for (const file of [
    "0002_resource_admission.sql",
    "0009_card_enrollment.sql",
    "0012_billing_collection.sql",
    "0030_payment_enrollment.sql",
    "0031_daviplata_enrollment.sql",
    "0035_billing_corrections.sql",
    "0052_weekly_card_renewal.sql",
    "0053_calendar_card_renewal.sql",
    "0058_wallet_renewal.sql",
  ]) {
    yield* fromPromise(() =>
      applyTestMigration({ db, source: new URL(`../migrations/${file}`, import.meta.url) })
    );
  }
  return { db, instance };
});
