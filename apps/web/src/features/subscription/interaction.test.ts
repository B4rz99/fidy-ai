// @vitest-environment jsdom
import { BigDecimal, DateTime, Deferred, Effect, Layer, Option, Schema } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { HttpClient, HttpClientResponse } from "effect/http";
import { UnknownJsonString } from "@/schema-compatibility";
import { type Mock, afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import {
  BillingEmail,
  PaymentEnrollment,
  PaymentEnrollmentId,
  PaymentSubmission as PaymentSubmissionSchema,
  PriceId,
  makeSubscriptionEnrollmentClient,
} from "@/transport/client";
import {
  type EnrollmentGateway,
  type PaymentSubmission,
  type PreparedEnrollment,
  makeEnrollmentGateway,
} from "./enrollment-gateway";
import { type EnrollmentInteraction, makeEnrollmentInteraction } from "./interaction";

type DisclosureContract = PreparedEnrollment["contracts"][keyof PreparedEnrollment["contracts"]];
const contract = (kind: DisclosureContract["kind"]): DisclosureContract => ({
  kind,
  permalink: new URL("https://wompi.co/synthetic"),
  displayedText: "Synthetic disclosure",
  contentSha256: "a".repeat(64),
  providerContentHash: "b".repeat(64),
  observedAt: DateTime.makeUnsafe(0),
});
const prepared = (now: number): PreparedEnrollment => ({
  status: "prepared",
  method: "card",
  enrollmentId: PaymentEnrollmentId.make("23200000-0000-4000-8000-000000000001"),
  price: {
    id: PriceId.make("23200000-0000-4000-8000-000000000002"),
    money: { amount: BigDecimal.fromStringUnsafe("9900"), currency: "COP" },
    billingPeriod: "weekly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms: {
      automaticRenewal: true,
      renewalReminder: "none",
      cancellation: "future-renewals-only",
      paidAccessEnds: "paid-period-end",
    },
    paymentMethods: ["card", "nequi", "daviplata"],
  },
  billingEmail: BillingEmail.make("synthetic@example.invalid"),
  contracts: {
    endUserPolicy: { ...contract("end-user-policy"), kind: "end-user-policy" },
    personalDataAuthorization: {
      ...contract("personal-data-authorization"),
      kind: "personal-data-authorization",
    },
  },
  recurringDisclosure: {
    revision: "wompi-card-enrollment-v1",
    displayedText: "Synthetic recurring disclosure",
    contentSha256: "c".repeat(64),
  },
  wompiPublicKey: "pub_test_synthetic",
  paymentSourceMode: "create",
  expiresAt: DateTime.makeUnsafe(now + 60_000),
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
type Fixture = Readonly<{
  enrollment: PreparedEnrollment;
  submission: PaymentSubmission;
  gateway: { [Method in keyof EnrollmentGateway]: Mock<EnrollmentGateway[Method]> };
  registry: AtomRegistry.AtomRegistry;
  authorizationLock: Atom.Writable<boolean>;
  dispose: () => void;
  view: () => EnrollmentInteraction;
}>;
const fixture = (): Fixture => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const enrollment = prepared(0);
  const submission: PaymentSubmission = {
    status: "source-verifying",
    enrollmentId: enrollment.enrollmentId,
  };
  const gateway = {
    availability: vi.fn<EnrollmentGateway["availability"]>(() =>
      Promise.resolve({ enabledMethods: ["card", "nequi", "daviplata"] })
    ),
    prepare: vi.fn<EnrollmentGateway["prepare"]>(() => Promise.resolve(enrollment)),
    submit: vi.fn<EnrollmentGateway["submit"]>(() => Promise.resolve(submission)),
    continue: vi.fn<EnrollmentGateway["continue"]>(() => Promise.resolve(submission)),
    observeBillingAttempt: vi.fn<EnrollmentGateway["observeBillingAttempt"]>(() =>
      Promise.resolve(submission)
    ),
    status: vi.fn<EnrollmentGateway["status"]>(() => Promise.resolve(enrollment)),
    resume: vi.fn<EnrollmentGateway["resume"]>(() => Promise.resolve(Option.none())),
    startDaviplata: vi.fn<EnrollmentGateway["startDaviplata"]>(),
  };
  const registry = AtomRegistry.make();
  const authorizationLock = Atom.make(false);
  const atom = makeEnrollmentInteraction({
    gateway: Option.some(gateway),
    offers: [enrollment.price, enrollment.price, enrollment.price],
    authorizationLock,
  });
  cleanups.push(() => registry.dispose());
  cleanups.push(registry.mount(atom));
  const dispose = registry.get(atom).mount();
  cleanups.push(dispose);
  return {
    enrollment,
    submission,
    gateway,
    registry,
    authorizationLock,
    dispose,
    view: (): EnrollmentInteraction => registry.get(atom),
  };
};
const advance = Effect.fn(function* (milliseconds: number) {
  yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(milliseconds));
});
const prepareFixture = Effect.fn(function* (input: Fixture) {
  yield* advance(0);
  input.view().selectPrice(input.enrollment.price.id);
  input.view().continueToPayment();
  yield* advance(0);
});

it.effect(
  "owns selection and synchronously refuses duplicate preparation and payment submission",
  () =>
    Effect.gen(function* () {
      const input = fixture();
      yield* advance(0);
      expect(input.view().canContinue).toBe(false);
      input.view().continueToPayment();
      expect(input.gateway.prepare).not.toHaveBeenCalled();
      input.view().selectPrice(input.enrollment.price.id);
      const selected = input.view();
      selected.continueToPayment();
      selected.continueToPayment();
      selected.selectMethod("nequi");
      yield* advance(0);
      expect(input.gateway.prepare).toHaveBeenCalledTimes(1);
      expect(input.view().method).toBe("card");
      const ready = input.view();
      ready.submit("synthetic@example.invalid");
      ready.submit("synthetic@example.invalid");
      yield* advance(0);
      expect(input.gateway.submit).toHaveBeenCalledTimes(1);
      expect(input.view().disabled).toBe(true);
      expect(input.view().changeSelection()).toBe(false);
    })
);
it.effect(
  "keeps uncertain submission locked through failed recovery without replaying the mutation",
  () =>
    Effect.gen(function* () {
      const input = fixture();
      yield* prepareFixture(input);
      input.gateway.submit.mockRejectedValue(new Error("uncertain"));
      input.view().submit("synthetic@example.invalid");
      yield* advance(0);
      expect(input.view().needsRecovery).toBe(true);
      input.view().submit("synthetic@example.invalid");
      input.view().selectMethod("nequi");
      input.gateway.status.mockRejectedValueOnce(new Error("unavailable"));
      input.view().refresh();
      yield* advance(0);
      expect(input.view().needsRecovery).toBe(true);
      expect(input.view().disabled).toBe(true);
      expect(input.gateway.submit).toHaveBeenCalledTimes(1);
      input.view().refresh();
      yield* advance(0);
      expect(input.view().needsRecovery).toBe(true);
      expect(input.gateway.resume).not.toHaveBeenCalled();
      input.gateway.status.mockResolvedValueOnce({
        status: "expired",
        enrollmentId: input.enrollment.enrollmentId,
        method: "card",
        priceId: input.enrollment.price.id,
      });
      input.view().refresh();
      yield* advance(0);
      expect(input.view().needsRecovery).toBe(false);
      expect(input.view().disabled).toBe(false);
      expect(input.gateway.submit).toHaveBeenCalledTimes(1);
    })
);
it.effect(
  "accepts method replacement only after selection is unlocked and never prepares on selection",
  () =>
    Effect.gen(function* () {
      const input = fixture();
      yield* prepareFixture(input);
      input.registry.set(input.authorizationLock, true);
      input.view().selectMethod("nequi");
      expect(input.view().changeSelection()).toBe(false);
      expect(input.view().method).toBe("card");
      input.registry.set(input.authorizationLock, false);
      expect(input.view().changeSelection()).toBe(true);
      input.view().selectMethod("nequi");
      expect(input.gateway.prepare).toHaveBeenCalledTimes(1);
      input.view().continueToPayment();
      yield* advance(0);
      expect(input.gateway.prepare).toHaveBeenLastCalledWith(
        input.enrollment.price.id,
        "nequi",
        expect.objectContaining({ replaceFailedSource: true })
      );
    })
);
it.effect(
  "fences a late completion and aborts its signal when the mounted lifetime is replaced",
  () =>
    Effect.gen(function* () {
      const input = fixture();
      yield* advance(0);
      const pending = yield* Deferred.make<PreparedEnrollment>();
      const context = yield* Effect.context<never>();
      input.gateway.prepare.mockImplementationOnce(() =>
        Effect.runPromiseWith(context)(Deferred.await(pending))
      );
      input.view().selectPrice(input.enrollment.price.id);
      input.view().continueToPayment();
      yield* advance(0);
      const signal = input.gateway.prepare.mock.calls[0]?.[2]?.signal;
      input.dispose();
      expect(signal?.aborted).toBe(true);
      const stop = input.view().mount();
      cleanups.push(stop);
      yield* Deferred.succeed(pending, input.enrollment);
      yield* advance(0);
      expect(Option.isNone(input.view().enrollment)).toBe(true);
      expect(input.view().busy).toBe(false);
      expect(input.gateway.submit).not.toHaveBeenCalled();
    })
);
it.effect("pauses observation while hidden and stops observation on disposal", () =>
  Effect.gen(function* () {
    const input = fixture();
    yield* prepareFixture(input);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    input.view().submit("synthetic@example.invalid");
    yield* advance(60_000);
    expect(input.gateway.continue).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    yield* advance(0);
    expect(input.gateway.continue).toHaveBeenCalledTimes(1);
    input.dispose();
    yield* advance(60_000);
    expect(input.gateway.continue).toHaveBeenCalledTimes(1);
  })
);
it.effect("ignores DaviPlata submissions for a different mounted enrollment", () =>
  Effect.gen(function* () {
    const input = fixture();
    yield* prepareFixture(input);
    input.view().submittedDaviplata("synthetic@example.invalid", input.submission);
    yield* advance(0);
    expect(Option.map(input.view().enrollment, (flow) => flow._tag)).toEqual(
      Option.some("Enrollment")
    );
    expect(input.gateway.continue).not.toHaveBeenCalled();
  })
);

it.effect(
  "ignores foreign observation results and retains the exact enrollment until terminal recovery",
  () =>
    Effect.gen(function* () {
      const input = fixture();
      yield* prepareFixture(input);
      input.view().submit("synthetic@example.invalid");
      input.gateway.continue.mockResolvedValueOnce({
        status: "refused",
        reason: "provider-declined",
        enrollmentId: PaymentEnrollmentId.make("23200000-0000-4000-8000-000000000099"),
      });
      yield* advance(1_000);
      expect(input.view().disabled).toBe(true);
      input.gateway.continue.mockResolvedValueOnce({
        status: "refused",
        reason: "provider-declined",
        enrollmentId: input.enrollment.enrollmentId,
      });
      yield* advance(1_000);
      expect(input.gateway.continue.mock.calls.map((call) => call[0])).toEqual([
        input.enrollment.enrollmentId,
        input.enrollment.enrollmentId,
      ]);
      expect(input.view().disabled).toBe(false);
      expect(input.view().changeSelection()).toBe(true);
    })
);

const SubmissionRequest = Schema.Struct({
  paymentSourceMode: Schema.Literals(["create", "reuse"]),
  enrollmentId: Schema.String,
  paymentRequestId: Schema.String,
  cardToken: Schema.optional(Schema.String),
});
type RecoveryFixture = {
  enrollment: PreparedEnrollment;
  submission: Extract<PaymentSubmission, { status: "payment-pending" }>;
  status: "available" | "verifying";
  requests: Array<typeof SubmissionRequest.Type>;
  failResume: boolean;
  reads: number;
};
const recoveryFixture = (status: RecoveryFixture["status"]): RecoveryFixture => {
  const enrollment = prepared(DateTime.nowUnsafe().epochMilliseconds);
  return {
    enrollment,
    status,
    requests: [],
    failResume: true,
    reads: 0,
    submission: Schema.decodeSync(PaymentSubmissionSchema.members[0])({
      status: "payment-pending",
      enrollmentId: enrollment.enrollmentId,
      billingAttempt: {
        id: "23200000-0000-4000-8000-000000000050",
        priceId: enrollment.price.id,
        money: { amount: "9900", currency: "COP" },
        billingPeriod: "weekly",
        serviceMarket: "CO",
        taxTreatment: "not-taxable",
        timeZone: "America/Bogota",
        createdAt: "2026-10-27T00:00:00Z",
        status: "pending",
      },
    }),
  };
};
const recoverySubmission = (
  fixture: RecoveryFixture,
  submission: typeof SubmissionRequest.Type
): Response =>
  submission.paymentSourceMode === "create" ||
  fixture.failResume ||
  submission.paymentRequestId !== fixture.requests[0]?.paymentRequestId
    ? new Response(null, { status: 503 })
    : Response.json(Schema.encodeSync(PaymentSubmissionSchema)(fixture.submission));
const recoveryHttp = (fixture: RecoveryFixture): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      let response: Response;
      if (path.endsWith("/availability")) response = Response.json({ enabledMethods: ["card"] });
      else if (path.endsWith("/prepare")) {
        response = Response.json(yield* Schema.encodeEffect(PaymentEnrollment)(fixture.enrollment));
      } else if (path.endsWith("/submit")) {
        const text =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const body = yield* Schema.decodeEffect(UnknownJsonString)(text);
        const submission = yield* Schema.decodeUnknownEffect(SubmissionRequest)(body);
        fixture.requests.push(submission);
        response = recoverySubmission(fixture, submission);
      } else if (path.includes("/billing-attempts/")) {
        fixture.reads += 1;
        response = Response.json(
          (yield* Schema.encodeEffect(PaymentSubmissionSchema.members[0])(fixture.submission))
            .billingAttempt
        );
      } else {
        response = Response.json({
          status: fixture.status,
          enrollmentId: fixture.enrollment.enrollmentId,
          method: "card",
          priceId: fixture.enrollment.price.id,
        });
      }
      return HttpClientResponse.fromWeb(request, response);
    }).pipe(Effect.orDie)
  );
const mountRecovery = (
  gateway: EnrollmentGateway,
  enrollment: PreparedEnrollment
): (() => EnrollmentInteraction) => {
  const registry = AtomRegistry.make();
  const atom = makeEnrollmentInteraction({
    gateway: Option.some(gateway),
    offers: [enrollment.price, enrollment.price, enrollment.price],
    authorizationLock: Atom.make(false),
  });
  cleanups.push(() => registry.dispose());
  cleanups.push(registry.mount(atom));
  cleanups.push(registry.get(atom).mount());
  return () => registry.get(atom);
};
for (const status of ["available", "verifying"] as const) {
  it.effect(
    `recovers a lost submission acknowledgment from ${status} with the original request and BillingAttempt`,
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers();
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        const input = recoveryFixture(status);
        const provider = vi.fn(() =>
          Promise.resolve(Response.json({ data: { id: "tok_test_synthetic", brand: "VISA" } }))
        );
        vi.stubGlobal("fetch", provider);
        const client = yield* Effect.acquireRelease(
          Effect.sync(() =>
            makeSubscriptionEnrollmentClient({
              apiOrigin: "https://api.test.fidyapp.com",
              httpClient: Layer.succeed(HttpClient.HttpClient, recoveryHttp(input)),
            })
          ),
          (client) => Effect.tryPromise(() => client.dispose()).pipe(Effect.orDie)
        );
        const view = mountRecovery(makeEnrollmentGateway(client), input.enrollment);
        yield* advance(0);
        view().selectPrice(input.enrollment.price.id);
        view().continueToPayment();
        yield* advance(0);
        view().submit("synthetic@example.invalid", {
          number: "4242424242424242",
          cvc: "123",
          expirationMonth: "12",
          expirationYear: "2030",
          cardholderName: "Synthetic Person",
        });
        yield* advance(0);
        expect(view().needsRecovery).toBe(true);
        view().refresh();
        yield* advance(0);
        expect(view().needsRecovery).toBe(true);
        expect(view().disabled).toBe(true);
        input.failResume = false;
        view().refresh();
        yield* advance(0);
        expect(view().needsRecovery).toBe(false);
        expect(view().disabled).toBe(true);
        expect(Option.map(view().enrollment, (flow) => flow.value)).toEqual(
          Option.some(input.submission)
        );
        yield* advance(1_000);
        expect(input.reads).toBe(1);
        expect(provider).toHaveBeenCalledTimes(1);
        expect(input.requests.map((request) => request.paymentSourceMode)).toEqual([
          "create",
          "reuse",
          "reuse",
        ]);
        expect(new Set(input.requests.map((request) => request.paymentRequestId)).size).toBe(1);
        expect(input.requests.slice(1).every((request) => request.cardToken === undefined)).toBe(
          true
        );
      })
  );
}

it.effect(
  "retains uncertainty when admitted enrollment recovery is missing or addresses another enrollment",
  () =>
    Effect.gen(function* () {
      const input = fixture();
      yield* prepareFixture(input);
      input.gateway.submit.mockRejectedValueOnce(new Error("acknowledgment lost"));
      input.view().submit("synthetic@example.invalid");
      yield* advance(0);
      input.gateway.status.mockResolvedValue({
        status: "available",
        enrollmentId: input.enrollment.enrollmentId,
        method: "card",
        priceId: input.enrollment.price.id,
      });
      input.view().refresh();
      yield* advance(0);
      expect(input.view().needsRecovery).toBe(true);
      expect(input.view().changeSelection()).toBe(false);
      input.gateway.resume.mockResolvedValueOnce(
        Option.some({
          billingEmail: "synthetic@example.invalid",
          submission: {
            status: "source-verifying",
            enrollmentId: PaymentEnrollmentId.make("23200000-0000-4000-8000-000000000099"),
          },
        })
      );
      input.view().refresh();
      yield* advance(0);
      expect(input.view().needsRecovery).toBe(true);
      expect(input.view().disabled).toBe(true);
      expect(input.gateway.submit).toHaveBeenCalledTimes(1);
      expect(input.gateway.continue).not.toHaveBeenCalled();
    })
);
