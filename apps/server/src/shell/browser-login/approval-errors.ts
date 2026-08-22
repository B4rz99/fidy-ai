import {
  BrowserLoginPairingApprovalRateLimited,
  BrowserLoginPairingApprovalRejected,
  browserLoginApprovalGenericMessage,
} from "./operations";

/** Constructs a non-enumerating approval rejection with no suggested follow-up operation. */
export const browserLoginApprovalRejected = (): BrowserLoginPairingApprovalRejected =>
  BrowserLoginPairingApprovalRejected.make({
    error: { code: "validation_failed", message: browserLoginApprovalGenericMessage },
    next: [],
  });

/** Constructs a non-enumerating approval limit response with its retry delay. */
export const browserLoginApprovalRateLimited = (
  retryAfterSeconds: number
): BrowserLoginPairingApprovalRateLimited =>
  BrowserLoginPairingApprovalRateLimited.make({
    error: {
      code: "rate_limited",
      message: browserLoginApprovalGenericMessage,
      retryAfterSeconds,
    },
    next: [],
  });
