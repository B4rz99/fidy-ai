import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Renames the persisted Subscription price tables without replacing migration 0029's identity. */
export const subscriptionPriceVocabulary = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE public.price_revisions RENAME TO prices;
    ALTER TABLE public.published_price_revisions RENAME TO published_prices;
    ALTER TABLE public.published_prices RENAME COLUMN price_revision_id TO price_id
  `;
}).pipe(Effect.asVoid);
