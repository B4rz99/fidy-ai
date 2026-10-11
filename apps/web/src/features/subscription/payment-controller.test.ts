import { Effect, Fiber, Option, Schema } from "effect";
import { type Mock, afterEach, expect, it, vi } from "vitest";
import { PaymentSubmission as PaymentSubmissionSchema } from "@/transport/client";
import type { Enrollment, EnrollmentGateway, PaymentSubmission } from "./enrollment-gateway";
import type { DaviplataChallenge, DaviplataConfirmation } from "./daviplata-challenge";
import { type PaymentController, makePaymentController } from "./payment-controller";
import type { PaymentAction, PaymentStage } from "./payment-model";
import { enrollmentGateway, offers, preparedEnrollment } from "./testing-fixtures";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
type Fixture = Readonly<{ controller: PaymentController; changed: Mock }>;
const setup = (gateway: EnrollmentGateway = enrollmentGateway): Fixture => {
  const changed = vi.fn();
  const controller = makePaymentController({ gateway, changed });
  disposers.push(controller.dispose);
  return { controller, changed };
};
const preparedDaviplata = {
  ...preparedEnrollment,
  method: "daviplata" as const,
  daviplataOtpPolicy: {
    sendUrl: "https://sandbox.wompi.co/synthetic/send",
    confirmUrl: "https://sandbox.wompi.co/synthetic/confirm",
  },
};
const selection = { price: offers[1].id, method: "card" } as const;
const refused: PaymentSubmission = {
  status: "refused",
  enrollmentId: preparedEnrollment.enrollmentId,
  reason: "provider-declined",
};

it("reuses a reviewed card source without forwarding private card drafts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { controller } = setup({
        ...enrollmentGateway,
        prepare: () => Promise.resolve({ ...preparedEnrollment, paymentSourceMode: "reuse" }),
        submit: (_prepared, _email, options) => {
          expect(options?.fields).toEqual(Option.none());
          return Promise.resolve(refused);
        },
      });
      yield* controller.select(selection);
      expect(controller.view().reuse).toBe(true);
      controller.inputs.set("number", "private-unused-draft");
      yield* controller.execute("Submit");
      expect(controller.inputs.read("number")).toBe("");
      expect(controller.view().stage).toBe("Refused");
    })
  ));

const challenge = (result: DaviplataConfirmation): DaviplataChallenge => ({
  confirm: () => Promise.resolve(result),
  resend: () => Promise.resolve(result),
  retrySubmission: () => Promise.resolve({ status: "submitted", submission: refused }),
  dispose: vi.fn(),
});

it.each([
  [{ status: "retry-allowed" }, "Otp"],
  [{ status: "refused" }, "Refused"],
  [{ status: "uncertain", retrySubmission: false }, "Uncertain"],
  [{ status: "uncertain", retrySubmission: true }, "RetrySubmission"],
  [{ status: "submitted", submission: refused }, "Refused"],
] satisfies ReadonlyArray<readonly [DaviplataConfirmation, PaymentStage]>)(
  "presents each DaviPlata confirmation outcome and permits only its matching action: %s",
  (result, stage) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authorization = challenge(result);
        const { controller } = setup({
          ...enrollmentGateway,
          prepare: () => Promise.resolve(preparedDaviplata),
          startDaviplata: () => Promise.resolve(authorization),
        });
        yield* controller.select({ ...selection, method: "daviplata" });
        yield* controller.execute("Submit");
        expect(controller.view().stage).toBe("Otp");
        yield* controller.execute("RetrySubmission");
        expect(controller.view().stage).toBe("Otp");
        controller.inputs.set("otp", "123456");
        yield* controller.execute("Confirm");
        expect(controller.view().stage).toBe(stage);
        expect(controller.inputs.read("otp")).toBe("");
        if (stage === "RetrySubmission") {
          yield* controller.execute("Confirm");
          expect(controller.view().stage).toBe(stage);
          yield* controller.execute("RetrySubmission");
          expect(controller.view().stage).toBe("Refused");
        }
      })
    )
);

it("resends OTPs without resubmitting payment and disposes the challenge on cancellation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const authorization = challenge({ status: "retry-allowed" });
      const resend = vi.spyOn(authorization, "resend");
      const { controller } = setup({
        ...enrollmentGateway,
        prepare: () => Promise.resolve(preparedDaviplata),
        startDaviplata: () => Promise.resolve(authorization),
      });
      yield* controller.select({ ...selection, method: "daviplata" });
      yield* controller.execute("Submit");
      yield* controller.execute("Resend");
      expect(resend).toHaveBeenCalledOnce();
      yield* controller.execute("Cancel");
      expect(authorization.dispose).toHaveBeenCalledOnce();
      expect(controller.view().locked).toBe(false);
    })
  ));

it.each(["cancel", "dispose"] as const)("drops a late DaviPlata challenge after %s", (action) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending = Promise.withResolvers<DaviplataChallenge>();
      const authorization = challenge({ status: "retry-allowed" });
      const { controller } = setup({
        ...enrollmentGateway,
        prepare: () => Promise.resolve(preparedDaviplata),
        startDaviplata: () => pending.promise,
      });
      yield* controller.select({ ...selection, method: "daviplata" });
      const work = yield* Effect.forkChild(controller.execute("Submit"));
      yield* Effect.yieldNow;
      if (action === "dispose") controller.dispose();
      else yield* controller.execute("Cancel");
      pending.resolve(authorization);
      yield* Fiber.join(work);
      expect(authorization.dispose).toHaveBeenCalledOnce();
      expect(controller.view().stage).not.toBe("Otp");
    })
  )
);

it.each(["confirm", "resend"] as const)("drops late %s outcomes after cancellation", (action) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending = Promise.withResolvers<DaviplataConfirmation>();
      const authorization: DaviplataChallenge = {
        ...challenge({ status: "retry-allowed" }),
        confirm: () => pending.promise,
        resend: () => pending.promise,
      };
      const { controller } = setup({
        ...enrollmentGateway,
        prepare: () => Promise.resolve(preparedDaviplata),
        startDaviplata: () => Promise.resolve(authorization),
      });
      yield* controller.select({ ...selection, method: "daviplata" });
      yield* controller.execute("Submit");
      const work = yield* Effect.forkChild(
        controller.execute(action === "confirm" ? "Confirm" : "Resend")
      );
      yield* Effect.yieldNow;
      yield* controller.execute("Cancel");
      pending.resolve({ status: "uncertain", retrySubmission: true });
      yield* Fiber.join(work);
      expect(controller.view().stage).toBe("Refused");
    })
  )
);
const enrollment = (
  status: "available" | "creating" | "verifying" | "expired"
): Extract<Enrollment, { status: "available" | "creating" | "verifying" | "expired" }> => ({
  status,
  enrollmentId: preparedEnrollment.enrollmentId,
  method: "card",
  priceId: selection.price,
});

it.each([
  [enrollment("available"), "Available"],
  [enrollment("creating"), "Creating"],
  [enrollment("verifying"), "Verifying"],
  [enrollment("expired"), "Expired"],
  [{ ...enrollment("expired"), status: "refused", reason: "provider-declined" }, "Refused"],
] satisfies ReadonlyArray<readonly [Enrollment, PaymentStage]>)(
  "presents enrollment facts without starting a second authorization: %s",
  (value, stage) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const submit = vi.fn(enrollmentGateway.submit);
        const { controller } = setup({
          ...enrollmentGateway,
          prepare: () => Promise.resolve(value),
          submit,
        });
        yield* controller.select(selection);
        expect(controller.view().stage).toBe(stage);
        expect(controller.view().busy).toBe(false);
        expect(Option.isNone(controller.view().contracts)).toBe(true);
        expect(submit).not.toHaveBeenCalled();
      })
    )
);

it.each(["creating", "verifying"] as const)(
  "resumes %s enrollment using retained canonical work",
  (status) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const resume = vi.fn(() =>
          Promise.resolve(
            Option.some({ submission: refused, billingEmail: "verified@example.com" })
          )
        );
        const { controller } = setup({
          ...enrollmentGateway,
          prepare: () => Promise.resolve(enrollment(status)),
          resume,
        });
        yield* controller.select(selection);
        expect(controller.view().stage).toBe("Refused");
        expect(controller.view().locked).toBe(true);
        expect(resume).toHaveBeenCalledTimes(1);
        yield* controller.execute("Prepare");
        yield* controller.select(selection);
        expect(resume).toHaveBeenCalledTimes(1);
      })
    )
);

it("refreshes pending enrollment facts and does not refresh field-entry state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const status = vi.fn(() => Promise.resolve(preparedEnrollment));
      const { controller } = setup({
        ...enrollmentGateway,
        prepare: () => Promise.resolve(enrollment("creating")),
        status,
      });
      yield* controller.execute("Refresh");
      expect(status).not.toHaveBeenCalled();
      yield* controller.select(selection);
      yield* controller.execute("Refresh");
      expect(controller.view().stage).toBe("Fields");
      yield* controller.execute("Refresh");
      expect(status).toHaveBeenCalledTimes(1);
    })
  ));

it.each(["Submit", "Confirm", "Resend", "RetrySubmission"] satisfies ReadonlyArray<PaymentAction>)(
  "ignores %s before its required workflow state",
  (action) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const submit = vi.fn(enrollmentGateway.submit);
        const { controller, changed } = setup({ ...enrollmentGateway, submit });
        yield* controller.execute(action);
        expect(submit).not.toHaveBeenCalled();
        expect(changed).not.toHaveBeenCalled();
        expect(controller.view().stage).toBe("Idle");
      })
    )
);

it("does not restart an active field workflow and re-prepares only after cancellation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prepare = vi.fn(enrollmentGateway.prepare);
      const { controller } = setup({ ...enrollmentGateway, prepare });
      yield* controller.execute("Prepare");
      expect(prepare).not.toHaveBeenCalled();
      yield* controller.select(selection);
      yield* controller.execute("Prepare");
      expect(prepare).toHaveBeenCalledTimes(1);
      yield* controller.execute("Cancel");
      yield* controller.execute("Prepare");
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(controller.view().stage).toBe("Fields");
    })
  ));

it("ignores duplicate selection and actions during preparation, then drops a late canceled preparation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending = Promise.withResolvers<Enrollment>();
      const prepare = vi.fn(() => pending.promise);
      const { controller } = setup({ ...enrollmentGateway, prepare });
      const work = yield* Effect.forkChild(controller.select(selection));
      yield* Effect.yieldNow;
      yield* controller.select(selection);
      yield* controller.execute("Submit");
      expect(prepare).toHaveBeenCalledTimes(1);
      yield* controller.execute("Cancel");
      pending.resolve(preparedEnrollment);
      yield* Fiber.join(work);
      expect(controller.view().stage).toBe("Refused");
      expect(controller.inputs.read("email")).toBe("");
    })
  ));

it.each(["select", "submit", "resume", "refresh"])(
  "ignores completion after disposal during %s",
  (operation) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const pending = Promise.withResolvers<void>();
        const gateway: EnrollmentGateway = {
          ...enrollmentGateway,
          prepare: () =>
            operation === "select"
              ? pending.promise.then(() => preparedEnrollment)
              : Promise.resolve(
                  operation === "resume" || operation === "refresh"
                    ? enrollment("creating")
                    : preparedEnrollment
                ),
          submit: () => pending.promise.then(() => refused),
          resume: () =>
            operation === "resume"
              ? pending.promise.then(() =>
                  Option.some({ submission: refused, billingEmail: "verified@example.com" })
                )
              : Promise.resolve(Option.none()),
          status: () => pending.promise.then(() => preparedEnrollment),
        };
        const { controller, changed } = setup(gateway);
        const work = yield* Effect.forkChild(
          operation === "select" || operation === "resume"
            ? controller.select(selection)
            : controller
                .select(selection)
                .pipe(
                  Effect.andThen(controller.execute(operation === "refresh" ? "Refresh" : "Submit"))
                )
        );
        yield* Effect.yieldNow;
        controller.dispose();
        const count = changed.mock.calls.length;
        pending.resolve();
        yield* Fiber.join(work);
        yield* controller.select(selection);
        yield* controller.execute("Prepare");
        expect(changed).toHaveBeenCalledTimes(count);
        expect(controller.inputs.read("email")).toBe("");
      })
    )
);

it.each(["prepare", "submit"])(
  "recovers %s errors with retryable presentation and private fields",
  (operation) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { controller } = setup({
          ...enrollmentGateway,
          prepare: () =>
            operation === "prepare"
              ? Promise.reject(new Error("private-provider-failure"))
              : Promise.resolve(preparedEnrollment),
          submit: () => Promise.reject(new Error("private-provider-failure")),
        });
        yield* controller.select(selection);
        if (operation === "submit") yield* controller.execute("Submit");
        expect(controller.view().failed).toBe(true);
        expect(controller.view().busy).toBe(false);
        expect(controller.view().stage).toBe(operation === "prepare" ? "Idle" : "Fields");
        expect(Object.values(controller.view())).not.toContain("private-provider-failure");
      })
    )
);

const billingSubmission = (status: "pending" | "failed" | "succeeded"): PaymentSubmission =>
  Schema.decodeSync(PaymentSubmissionSchema)({
    status: "payment-pending",
    enrollmentId: preparedEnrollment.enrollmentId,
    billingAttempt: {
      id: "22700000-0000-4000-8000-000000000092",
      priceId: selection.price,
      money: { amount: "28900", currency: "COP" },
      billingPeriod: "monthly",
      serviceMarket: "CO",
      taxTreatment: "not-taxable",
      timeZone: "America/Bogota",
      createdAt: "2026-10-01T12:00:00Z",
      status,
      failedAt: "2026-10-01T12:00:00Z",
      finalizedAt: "2026-10-01T12:00:00Z",
      paidPeriodEndsAt: "2026-11-01T12:00:00Z",
      renewalAnchor: "2026-10-01T12:00:00Z",
    },
  });

it.each(["pending", "failed", "succeeded"] as const)(
  "presents canonical %s BillingAttempt results without repeating authorization",
  (status) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const submit = vi.fn(() => Promise.resolve(billingSubmission(status)));
        const { controller } = setup({
          ...enrollmentGateway,
          submit,
          observeBillingAttempt: () => Promise.resolve(billingSubmission("failed")),
        });
        yield* controller.select(selection);
        yield* controller.execute("Submit");
        expect(controller.view().stage).toBe(
          status === "succeeded" ? "PaymentSucceeded" : "PaymentFailed"
        );
        expect(controller.view().locked).toBe(true);
        expect(submit).toHaveBeenCalledOnce();
      })
    )
);

it("passes normalized Nequi authorization fields privately and wipes the phone on awaiting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { controller, changed } = setup({
        ...enrollmentGateway,
        prepare: () => Promise.resolve({ ...preparedEnrollment, method: "nequi" }),
        submit: (_prepared, _email, options) => {
          if (
            options === undefined ||
            Option.isNone(options.fields) ||
            !("method" in options.fields.value)
          ) {
            throw new Error("Missing Nequi fields");
          }
          options.fields.value.onAwaiting();
          return Promise.resolve(refused);
        },
      });
      yield* controller.select({ ...selection, method: "nequi" });
      controller.inputs.set("nequi", "3991111111");
      yield* controller.execute("Submit");
      expect(controller.inputs.read("nequi")).toBe("");
      expect(changed).toHaveBeenCalledWith(expect.objectContaining({ stage: "AwaitingNequi" }));
      expect(controller.view().stage).toBe("Refused");
    })
  ));
