import type { PaymentSubmissionType as PaymentSubmission } from "@/transport/client";

const initialPaymentStatusRefreshes = 3;
const frequentPaymentStatusRefreshes = 9;

export const paymentStatusRefreshDelay = (
  refreshCount: number
): "1 second" | "5 seconds" | "10 seconds" => {
  if (refreshCount < initialPaymentStatusRefreshes) return "1 second";
  return refreshCount < frequentPaymentStatusRefreshes ? "5 seconds" : "10 seconds";
};

/** True permits forgetting the retained browser payment request. */
export const paymentSubmissionIsTerminal = (submission: PaymentSubmission): boolean =>
  submission.status === "refused" ||
  (submission.status === "payment-pending" && submission.billingAttempt.status !== "pending");

export const isAwaitingPaymentStatus = (submission: PaymentSubmission): boolean =>
  submission.status === "source-verifying" ||
  (submission.status === "payment-pending" && submission.billingAttempt.status === "pending");
