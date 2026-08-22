import { Data } from "effect";

/** Internal admission failure carrying the stable delay before another anonymous start. */
export class BrowserLoginStartRateLimited extends Data.TaggedError("BrowserLoginStartRateLimited")<{
  readonly retryAfterSeconds: number;
}> {}

/** Internal fail-fast admission failure when global or lock capacity is unavailable. */
export class BrowserLoginCapacityExceeded extends Data.TaggedError(
  "BrowserLoginCapacityExceeded"
) {}

/** Internal generic refusal for an invalid, expired, superseded, or consumed pairing. */
export class BrowserLoginPairingInvalid extends Data.TaggedError("BrowserLoginPairingInvalid") {}

/** Internal cadence refusal carrying the persisted server-directed retry delay. */
export class BrowserLoginPollingRateLimited extends Data.TaggedError(
  "BrowserLoginPollingRateLimited"
)<{ readonly retryAfterSeconds: number }> {}
