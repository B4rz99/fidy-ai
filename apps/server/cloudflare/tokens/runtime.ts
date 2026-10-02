import { Data, Effect } from "effect";
import { sweepExpiredPATPairings as expire } from "./internal/pat-pairing";

/** PAT retention could not commit; no storage or credential evidence crosses this boundary. */
export class PATRetentionUnavailable extends Data.TaggedError("PATRetentionUnavailable") {}

/** Apply bounded fixed PAT and unclaimed approval expiry with atomic symmetric Consent evidence; reclaim only expired anonymous metadata. */
export const sweepExpiredPATPairings = (
  db: D1Database
): Effect.Effect<void, PATRetentionUnavailable> =>
  Effect.tryPromise({ try: () => expire(db), catch: () => new PATRetentionUnavailable() });
