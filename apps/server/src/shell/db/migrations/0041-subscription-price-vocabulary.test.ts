import { expect, layer } from "@effect/vitest";
import { Data, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness } from "~/shell/testing/api-harness";
import { subscriptionPriceVocabulary } from "./0041-subscription-price-vocabulary";

class RollbackMigrationFixture extends Data.TaggedError("RollbackMigrationFixture")<{}> {}

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Subscription price vocabulary migration",
  (it) => {
    it.effect("renames persisted price tables and preserves their published offers", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* admin`ALTER TABLE published_prices RENAME TO published_price_revisions`;
              yield* admin`
                ALTER TABLE published_price_revisions
                  RENAME COLUMN price_id TO price_revision_id
              `;
              yield* admin`ALTER TABLE prices RENAME TO price_revisions`;

              yield* subscriptionPriceVocabulary.pipe(
                Effect.provideService(SqlClient.SqlClient, admin)
              );

              expect(
                yield* admin`
                  SELECT to_regclass('public.prices') AS "prices",
                    to_regclass('public.price_revisions') AS "legacyPrices",
                    to_regclass('public.published_prices') AS "publishedPrices",
                    to_regclass('public.published_price_revisions') AS "legacyPublishedPrices"
                `
              ).toEqual([
                {
                  prices: "prices",
                  legacyPrices: null,
                  publishedPrices: "published_prices",
                  legacyPublishedPrices: null,
                },
              ]);
              expect(
                yield* admin`
                  SELECT price_id::text AS "priceId"
                  FROM published_prices
                  ORDER BY offer_order
                `
              ).toEqual([
                { priceId: "22700000-0000-4000-8000-000000000001" },
                { priceId: "22700000-0000-4000-8000-000000000002" },
                { priceId: "22700000-0000-4000-8000-000000000003" },
              ]);

              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
        expect(
          yield* admin`
            SELECT to_regclass('public.prices') AS "prices",
              to_regclass('public.price_revisions') AS "legacyPrices"
          `
        ).toEqual([{ prices: "prices", legacyPrices: null }]);
      })
    );
  }
);
