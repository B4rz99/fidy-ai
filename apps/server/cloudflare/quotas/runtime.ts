import { Effect } from "effect";
import { QuotaRetentionUnavailable } from "./contract";

// Consumption identities outlive both a commercial month and the ninety-day ingestion lifetime.
const consumptionLifetimeMs = 8_035_200_000; // Ninety-three days.
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
