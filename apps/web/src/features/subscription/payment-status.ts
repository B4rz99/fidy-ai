import type { CardPaymentSubmissionType as PaymentSubmission } from "@/transport/client";

const initialPaymentStatusRefreshes = 3;
const frequentPaymentStatusRefreshes = 9;

/** Selects the bounded polling cadence for a pending browser payment. */
export const paymentStatusRefreshDelay = (
  refreshCount: number
): "1 second" | "5 seconds" | "10 seconds" => {
  if (refreshCount < initialPaymentStatusRefreshes) return "1 second";
  return refreshCount < frequentPaymentStatusRefreshes ? "5 seconds" : "10 seconds";
};

/** Decides whether a submission can release its retained browser payment request. */
export const paymentSubmissionIsTerminal = (submission: PaymentSubmission): boolean =>
  submission.status === "refused" ||
  (submission.status === "payment-pending" && submission.billingAttempt.status !== "pending");

/** Decides whether browser feedback still needs authoritative server observations. */
export const isAwaitingPaymentStatus = (submission: PaymentSubmission): boolean =>
  submission.status === "source-verifying" ||
  (submission.status === "payment-pending" && submission.billingAttempt.status === "pending");
