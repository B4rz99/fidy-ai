import { Effect, Fiber } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import type { EnrollmentGateway, PaymentSubmission } from "./enrollment-gateway";
import { observePayment } from "./payment-observation";
import {
  isAwaitingPaymentStatus,
  paymentStatusRefreshDelay,
  paymentSubmissionIsTerminal,
} from "./payment-status";
import { enrollmentGateway, preparedEnrollment } from "./testing-fixtures";

const initial: PaymentSubmission = {
  status: "source-verifying",
  enrollmentId: preparedEnrollment.enrollmentId,
};
const terminal: PaymentSubmission = {
  status: "refused",
  reason: "provider-error",
  enrollmentId: preparedEnrollment.enrollmentId,
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("selects bounded cadence and releases only terminal submissions", () => {
  expect([0, 2, 3, 8, 9, 64].map(paymentStatusRefreshDelay)).toEqual([
    "1 second",
    "1 second",
    "5 seconds",
    "5 seconds",
    "10 seconds",
    "10 seconds",
  ]);
  expect(isAwaitingPaymentStatus(initial)).toBe(true);
  expect(paymentSubmissionIsTerminal(initial)).toBe(false);
  expect(isAwaitingPaymentStatus(terminal)).toBe(false);
  expect(paymentSubmissionIsTerminal(terminal)).toBe(true);
});
it("retries observation failures without repeating authorization, and stops at a terminal result", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.useFakeTimers();
      const observe = vi
        .fn<EnrollmentGateway["continue"]>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(terminal);
      const publish = vi.fn();
      const fiber = yield* Effect.forkChild(
        observePayment({
          gateway: { ...enrollmentGateway, continue: observe },
          initial,
          email: "billing@example.com",
          active: () => true,
          publish,
        })
      );
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(2100));
      yield* Fiber.join(fiber);
      expect(observe).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledExactlyOnceWith(terminal);
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(20000));
      expect(observe).toHaveBeenCalledTimes(2);
    })
  ));
it("pauses hidden observation and removes visibility listeners on interruption", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.useFakeTimers();
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      const observe = vi.fn<EnrollmentGateway["continue"]>(() => Promise.resolve(initial));
      const remove = vi.spyOn(document, "removeEventListener");
      const fiber = yield* Effect.forkChild(
        observePayment({
          gateway: { ...enrollmentGateway, continue: observe },
          initial,
          email: "billing@example.com",
          active: () => true,
          publish: vi.fn(),
        })
      );
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(20000));
      expect(observe).not.toHaveBeenCalled();
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect(observe).toHaveBeenCalledTimes(1);
      yield* Fiber.interrupt(fiber);
      expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(20000));
      expect(observe).toHaveBeenCalledTimes(1);
    })
  ));
