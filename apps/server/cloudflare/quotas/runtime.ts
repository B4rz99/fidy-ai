import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { Effect } from "effect";
import { QuotaRetentionUnavailable } from "./contract";

const consumptionLifetimeMs = 8_035_200_000;
const retentionBatchSize = 1024;

/** Remove only obsolete consumption identities in bounded ticks, independently of User activity. Current-month usage and all retained ingestion/replay deduplication proofs remain intact. */
export const sweepCommercialAllowances = ({
  db,
  current,
}: Readonly<{ db: D1Database; current: number }>): Effect.Effect<void, QuotaRetentionUnavailable> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `DELETE FROM commercial_allowance_consumptions WHERE (user_id,allowance,identity) IN (SELECT user_id,allowance,identity FROM commercial_allowance_consumptions WHERE accepted_at_ms <= ? ORDER BY accepted_at_ms LIMIT ${retentionBatchSize})`
        )
        .bind(current - consumptionLifetimeMs)
        .run(),
    catch: () => new QuotaRetentionUnavailable(),
  }).pipe(Effect.asVoid);

export const makeQuotasErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));
