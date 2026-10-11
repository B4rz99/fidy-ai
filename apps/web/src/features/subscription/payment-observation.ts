import { type Cause, Effect, Option } from "effect";
import type { EnrollmentGateway, PaymentSubmission } from "./enrollment-gateway";
import { isAwaitingPaymentStatus, paymentStatusRefreshDelay } from "./payment-status";

const maximumRefreshes = 65;
const hidden = (): boolean => document.visibilityState === "hidden";
const awaitVisible = (): Effect.Effect<boolean> => {
  if (!hidden()) return Effect.succeed(false);
  return Effect.callback<boolean>((resume) => {
    const changed = (): void => {
      if (hidden()) return;
      document.removeEventListener("visibilitychange", changed);
      resume(Effect.succeed(true));
    };
    document.addEventListener("visibilitychange", changed);
    changed();
    return Effect.sync(() => document.removeEventListener("visibilitychange", changed));
  });
};
const observing = (current: PaymentSubmission, refreshes: number): boolean =>
  isAwaitingPaymentStatus(current) && refreshes < maximumRefreshes;
const nextSubmission = (
  gateway: EnrollmentGateway,
  current: PaymentSubmission,
  email: string
): Effect.Effect<Option.Option<PaymentSubmission>> =>
  Effect.tryPromise((signal) =>
    current.status === "payment-pending"
      ? gateway.observeBillingAttempt(current.enrollmentId, current.billingAttempt.id, signal)
      : gateway.continue(current.enrollmentId, email, signal)
  ).pipe(Effect.option);
/** Observes pending canonical payment work; it never repeats payment-provider authorization. */
export const observePayment = (
  configuration: Readonly<{
    gateway: EnrollmentGateway;
    initial: PaymentSubmission;
    email: string;
    active: () => boolean;
    publish: (submission: PaymentSubmission) => void;
  }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { gateway, email, active, publish } = configuration;
    let current = configuration.initial;
    let refreshes = 0;
    while (active() && observing(current, refreshes)) {
      const resumed = yield* awaitVisible();
      if (!resumed) yield* Effect.sleep(paymentStatusRefreshDelay(refreshes));
      if (hidden()) continue;
      if (!active()) return;
      refreshes += 1;
      const next = yield* nextSubmission(gateway, current, email);
      if (active() && Option.isSome(next)) {
        current = next.value;
        publish(current);
      }
    }
  });
