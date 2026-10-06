import { Clock, Effect } from "effect";
import type { ConsentUnavailable } from "./contract";
import { sweepOffers } from "./internal/proactivity-consent";

/** Execute the fixed undecided-offer retention policy against the bound Core database and authoritative runtime clock. Maintenance cannot choose legal-evidence deletion or another retention period. */
export const sweepProactivityConsentOffers = (
  db: D1Database
): Effect.Effect<void, ConsentUnavailable> =>
  Effect.gen(function* () {
    const nowEpochMs = yield* Clock.currentTimeMillis;
    yield* sweepOffers({ db, nowEpochMs });
  });
