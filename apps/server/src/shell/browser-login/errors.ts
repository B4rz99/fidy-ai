import { Data, Schema } from "effect";

/** Internal admission failure carrying the stable delay before another anonymous start. */
export class BrowserLoginStartRateLimited extends Data.TaggedError("BrowserLoginStartRateLimited")<{
  readonly retryAfterSeconds: number;
}> {}

/** Internal fail-fast admission failure when global or lock capacity is unavailable. */
export class BrowserLoginCapacityExceeded extends Data.TaggedError(
  "BrowserLoginCapacityExceeded"
) {}

const browserLoginUnavailableError = {
  code: "rate_limited",
  message: "Browser login is temporarily unavailable. Try again later.",
} as const;

const BrowserLoginUnavailableError = Schema.Struct({
  code: Schema.Literal(browserLoginUnavailableError.code),
  message: Schema.Literal(browserLoginUnavailableError.message),
});

/** Documented 429 shape; the handler adds Retry-After on its raw encoded response. */
export class BrowserLoginRateLimitedApi extends Schema.ErrorClass<BrowserLoginRateLimitedApi>(
  "BrowserLoginRateLimitedApi"
)({ error: BrowserLoginUnavailableError }, { httpApiStatus: 429 }) {}

/** Capacity exhaustion intentionally shares the generic public message. */
export class BrowserLoginUnavailableApi extends Schema.ErrorClass<BrowserLoginUnavailableApi>(
  "BrowserLoginUnavailableApi"
)({ error: BrowserLoginUnavailableError }, { httpApiStatus: 503 }) {}

/** Shared non-enumerating body encoded for both rate and capacity admission failures. */
export const browserLoginUnavailableBody = { error: browserLoginUnavailableError } as const;
