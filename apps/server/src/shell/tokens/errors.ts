import {
  ManualPATIssuanceConsumed,
  ManualPATIssuanceRateLimited,
  ManualPATReviewExpired,
  issuanceConsumedMessage,
  issuanceLimitedMessage,
  reviewExpiredMessage,
} from "./operations";

/** Maximum manual PAT grants one User may create in the rolling admission window. */
export const manualPATIssuanceLimit = 10;
/** Stable rolling window for manual PAT issuance admission. */
export const manualPATIssuanceWindowMinutes = 60;
/** Maximum delay between displaying an exact expiration and confirming its grant. */
export const manualPATReviewWindowMinutes = 15;

/** Builds the safe conflict returned for a consumed issuance request identity. */
export const makePATIssuanceConsumed = (): ManualPATIssuanceConsumed =>
  ManualPATIssuanceConsumed.make({
    error: { code: "user_action_required", message: issuanceConsumedMessage },
    next: [],
  });

/** Refuses an expiration that was not reviewed recently or does not match its fixed lifetime. */
export const makePATReviewExpired = (): ManualPATReviewExpired =>
  ManualPATReviewExpired.make({
    error: { code: "user_action_required", message: reviewExpiredMessage },
    next: [],
  });

/** Builds the canonical refusal for the current rolling-window retry delay. */
export const makePATRateLimit = (retryAfterSeconds: number): ManualPATIssuanceRateLimited =>
  ManualPATIssuanceRateLimited.make({
    error: {
      code: "rate_limited",
      message: issuanceLimitedMessage,
      retryAfterSeconds,
    },
    next: [],
  });
