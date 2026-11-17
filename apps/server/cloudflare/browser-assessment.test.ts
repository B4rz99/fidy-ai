import { it } from "@effect/vitest";
import { afterAll, expect } from "vitest";
import { Config, Effect } from "effect";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";
import { seedAssessment } from "./browser-assessment.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

const full =
  Effect.runSync(Config.String("FIDY_REFERENCE_FULL").pipe(Config.withDefault("0"))) === "1";

const datasets = [
  {
    dataset: "production",
    transactions: 8,
    plans: 2,
    revisions: 4,
    review: 4,
    currencies: 2,
    links: 1,
    effectiveTransactions: 7,
  },
  {
    dataset: "small",
    transactions: 500,
    plans: 10,
    revisions: 10,
    review: 50,
    currencies: 2,
    links: 5,
    effectiveTransactions: 495,
  },
  ...(full
    ? [
        {
          dataset: "extreme",
          transactions: 100000,
          plans: 100,
          revisions: 10000,
          review: 5000,
          currencies: 8,
          links: 1000,
          effectiveTransactions: 99000,
        },
      ]
    : []),
];
for (const { dataset, ...expected } of datasets) {
  it.live(
    `verifies the ${dataset} financial record before measuring a comparison`,
    () =>
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* Effect.tryPromise(() => installTestSchema({ db }));
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
            )
            .bind("24000000-0000-4000-8000-000000000481")
            .run()
        );
        const counts = yield* seedAssessment({ db, dataset, now: 1794873600000 });
        expect(counts).toEqual(expected);
      }),
    600_000
  );
}
