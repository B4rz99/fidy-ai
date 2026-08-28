import { DateTime, Function } from "effect";
import type { PriceId } from "./reference";

/**
 * Persisted enrollment lifecycle: prepared waits for submission; creating has been claimed;
 * available has a reusable payment source; refused is a definitive provider rejection; expired
 * exceeded its preparation window; verifying awaits operator resolution of an uncertain outcome.
 */
export type EnrollmentCheckpoint =
  | Readonly<{ status: "prepared"; priceId: PriceId; expiresAt: DateTime.Utc }>
  | Readonly<{
      status: "creating" | "available" | "refused" | "expired" | "verifying";
      priceId: PriceId;
    }>;

/** Closed action for one replay-safe submission attempt. */
export const decideEnrollmentSubmission: {
  (
    now: DateTime.Utc
  ): (
    checkpoint: EnrollmentCheckpoint
  ) => Readonly<{ _tag: "BeginSubmission" | "RecordExpiration" | "ReturnCurrentStatus" }>;
  (
    checkpoint: EnrollmentCheckpoint,
    now: DateTime.Utc
  ): Readonly<{ _tag: "BeginSubmission" | "RecordExpiration" | "ReturnCurrentStatus" }>;
} = Function.dual(
  2,
  (
    checkpoint: EnrollmentCheckpoint,
    now: DateTime.Utc
  ): Readonly<{ _tag: "BeginSubmission" | "RecordExpiration" | "ReturnCurrentStatus" }> => {
    if (checkpoint.status !== "prepared") return { _tag: "ReturnCurrentStatus" };
    return DateTime.Order(now, checkpoint.expiresAt) < 0
      ? { _tag: "BeginSubmission" }
      : { _tag: "RecordExpiration" };
  }
);

/** Decides whether Price selection can reuse an intent or an already-available source. */
export const decideEnrollmentPreparation: {
  (requestedPriceId: PriceId): (
    checkpoint: Readonly<Pick<EnrollmentCheckpoint, "status" | "priceId">>
  ) => Readonly<{
    _tag: "Observe" | "ReplaceIntent" | "ReauthorizeSource" | "RestartRequired";
  }>;
  (
    checkpoint: Readonly<Pick<EnrollmentCheckpoint, "status" | "priceId">>,
    requestedPriceId: PriceId
  ): Readonly<{
    _tag: "Observe" | "ReplaceIntent" | "ReauthorizeSource" | "RestartRequired";
  }>;
} = Function.dual(
  2,
  (
    checkpoint: Readonly<Pick<EnrollmentCheckpoint, "status" | "priceId">>,
    requestedPriceId: PriceId
  ): Readonly<{
    _tag: "Observe" | "ReplaceIntent" | "ReauthorizeSource" | "RestartRequired";
  }> => {
    if (checkpoint.status === "refused" || checkpoint.status === "expired") {
      return { _tag: "RestartRequired" };
    }
    if (checkpoint.priceId === requestedPriceId) return { _tag: "Observe" };
    if (checkpoint.status === "prepared") return { _tag: "ReplaceIntent" };
    if (checkpoint.status === "available") return { _tag: "ReauthorizeSource" };
    return { _tag: "Observe" };
  }
);
