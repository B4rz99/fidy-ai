import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { Data, Effect } from "effect";
import { sweepExpiredPATPairings as expire } from "./internal/pat-pairing";

/** PAT retention could not commit; no storage or credential evidence crosses this boundary. */
export class PATRetentionUnavailable extends Data.TaggedError("PATRetentionUnavailable") {}

/** Apply bounded fixed PAT and unclaimed approval expiry with atomic symmetric Consent evidence; reclaim only expired anonymous metadata. */
export const sweepExpiredPATPairings = (
  db: D1Database
): Effect.Effect<void, PATRetentionUnavailable> =>
  expire(db).pipe(Effect.mapError(() => new PATRetentionUnavailable()));

export const makeTokensErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));
