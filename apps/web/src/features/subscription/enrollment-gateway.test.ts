import {
  BigDecimal,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { type Mock, afterEach, expect, it, vi } from "vitest";
import {
  BillingEmail,
  PaymentEnrollmentId,
  PriceId,
  makeSubscriptionEnrollmentClient,
} from "@/transport/client";
import { type WompiFetch } from "@/transport/wompi-tokenization";
import { UnknownJsonString } from "@/schema-compatibility";
import { type DaviplataChallenge } from "./daviplata-challenge";
import { type PreparedEnrollment, makeEnrollmentGateway } from "./enrollment-gateway";

const policy = {
  sendUrl: "https://sandbox.wompi.co/synthetic/send",
  confirmUrl: "https://sandbox.wompi.co/synthetic/confirm",
};
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
  method: "daviplata",
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
  daviplataOtpPolicy: policy,
});
const token = "daviplata_devtest_synthetic";
const initial = (): Response =>
  Response.json({
    data: {
      id: token,
      status: "PENDING",
      url_services: {
        token: "synthetic-first-bearer",
        code_otp_send: policy.sendUrl,
        code_otp_validate: policy.confirmUrl,
      },
    },
  });
const otpResponse = (
  status: "PENDING" | "APPROVED",
  bearer = `synthetic-${status}-bearer`
): Response =>
  Response.json({
    data: {
      subscription: { PK: token, status },
      authorization: { access_token: bearer },
      attempts: {
        currentSendCode: 1,
        limitSendCode: 2,
        currentValidateCode: 0,
        limitValidateCode: 2,
      },
    },
  });
const clients: Array<ReturnType<typeof makeSubscriptionEnrollmentClient>> = [];
afterEach(() =>
  Effect.runPromise(
    Effect.forEach(clients.splice(0), (client) => Effect.tryPromise(() => client.dispose())).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.unstubAllGlobals();
          sessionStorage.clear();
        })
      )
    )
  )
);

it.each(["wrong-method", "reused-source"] as const)(
  "refuses DaviPlata authorization for %s and wipes drafts before any external effect",
  (reason) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const enrollment: PreparedEnrollment = {
          ...prepared(yield* Clock.currentTimeMillis),
          ...(reason === "wrong-method" ? { method: "card" } : { paymentSourceMode: "reuse" }),
        };
        const payloads: Array<unknown> = [];
        const client = makeSubscriptionEnrollmentClient({
          apiOrigin: "https://api.test.fidyapp.com",
          httpClient: Layer.succeed(
            HttpClient.HttpClient,
            submissionBoundary(enrollment, payloads)
          ),
        });
        const provider = providerFixture();
        vi.stubGlobal("fetch", provider);
        const documentNumber = Redacted.make("1122233");
        const productNumber = Redacted.make("3991111111");
        try {
          const result = yield* Effect.exit(
            Effect.tryPromise(() =>
              makeEnrollmentGateway(client).startDaviplata(
                enrollment,
                "synthetic@example.invalid",
                {
                  documentNumber,
                  productNumber,
                  signal: mountedSignal(),
                }
              )
            )
          );
          expect(result._tag).toBe("Failure");
          expect(() => Redacted.value(documentNumber)).toThrow();
          expect(() => Redacted.value(productNumber)).toThrow();
          expect(provider).not.toHaveBeenCalled();
          expect(payloads).toEqual([]);
          expect(sessionStorage.length).toBe(0);
        } finally {
          yield* Effect.tryPromise(() => client.dispose());
        }
      })
    )
);

it.each(["missing-fields", "nequi-fields"] as const)(
  "refuses direct DaviPlata submission with %s without approved challenge authority",
  (fieldsKind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const enrollment = prepared(yield* Clock.currentTimeMillis);
        const payloads: Array<unknown> = [];
        const client = makeSubscriptionEnrollmentClient({
          apiOrigin: "https://api.test.fidyapp.com",
          httpClient: Layer.succeed(
            HttpClient.HttpClient,
            submissionBoundary(enrollment, payloads)
          ),
        });
        const provider = providerFixture();
        vi.stubGlobal("fetch", provider);
        try {
          const result = yield* Effect.exit(
            Effect.tryPromise(() =>
              makeEnrollmentGateway(client).submit(enrollment, "synthetic@example.invalid", {
                fields:
                  fieldsKind === "missing-fields"
                    ? Option.none()
                    : Option.some({
                        method: "nequi",
                        phoneNumber: Redacted.make("3991111111"),
                        signal: mountedSignal(),
                        onAwaiting: (): void => {},
                      }),
                signal: Option.none(),
              })
            )
          );
          expect(result._tag).toBe("Failure");
          expect(payloads).toEqual([]);
          expect(provider).not.toHaveBeenCalled();
        } finally {
          yield* Effect.tryPromise(() => client.dispose());
        }
      })
    )
);

const submissionBoundary = (
  enrollment: PreparedEnrollment,
  payloads: Array<unknown>,
  respond: (attempt: number) => Effect.Effect<Response> = (attempt) =>
    Effect.succeed(
      attempt === 1
        ? new Response(null, { status: 503 })
        : Response.json({ status: "source-verifying", enrollmentId: enrollment.enrollmentId })
    )
): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (effect) =>
      Effect.flatMap(effect, (request) =>
        Effect.gen(function* () {
          const text =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          payloads.push(yield* Schema.decodeEffect(UnknownJsonString)(text).pipe(Effect.orDie));
          return HttpClientResponse.fromWeb(request, yield* respond(payloads.length));
        })
      ),
    Effect.succeed
  );
const mountedSignal = (): AbortSignal => new AbortController().signal;
const providerFixture = (): Mock<WompiFetch> =>
  vi
    .fn((_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      Promise.resolve(otpResponse("APPROVED"))
    )
    .mockResolvedValueOnce(initial())
    .mockResolvedValueOnce(otpResponse("PENDING"));

type ChallengeFixture = Readonly<{
  payloads: Array<unknown>;
  provider: Mock<WompiFetch>;
  client: ReturnType<typeof makeSubscriptionEnrollmentClient>;
  controller: AbortController;
  start: () => Promise<DaviplataChallenge>;
}>;
const challengeFixture = (
  enrollment: PreparedEnrollment,
  respond?: (attempt: number) => Effect.Effect<Response>
): ChallengeFixture => {
  const payloads: Array<unknown> = [];
  const client = makeSubscriptionEnrollmentClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      submissionBoundary(enrollment, payloads, respond)
    ),
  });
  clients.push(client);
  const provider = providerFixture();
  vi.stubGlobal("fetch", provider);
  const controller = new AbortController();
  return {
    payloads,
    provider,
    client,
    controller,
    start: (): Promise<DaviplataChallenge> =>
      makeEnrollmentGateway(client).startDaviplata(enrollment, "synthetic@example.invalid", {
        documentNumber: Redacted.make("1122233"),
        productNumber: Redacted.make("3991111111"),
        signal: controller.signal,
      }),
  };
};

it("serializes OTP confirmation and permits a resend after a retryable provider refusal without submitting authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = challengeFixture(prepared(yield* Clock.currentTimeMillis));
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<Response>();
      input.provider.mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      const challenge = yield* Effect.tryPromise(input.start);
      const firstOtp = Redacted.make("574829");
      const first = challenge.confirm(firstOtp);
      yield* Effect.tryPromise(() => started.promise);
      const duplicateOtp = Redacted.make("574829");
      expect(yield* Effect.tryPromise(() => challenge.confirm(duplicateOtp))).toEqual({
        status: "retry-allowed",
      });
      expect(() => Redacted.value(duplicateOtp)).toThrow();
      expect(yield* Effect.tryPromise(() => challenge.resend())).toEqual({
        status: "retry-allowed",
      });
      expect(input.provider).toHaveBeenCalledTimes(3);
      pending.resolve(otpResponse("PENDING", "synthetic-retry-bearer"));
      expect(yield* Effect.tryPromise(() => first)).toEqual({ status: "retry-allowed" });
      expect(() => Redacted.value(firstOtp)).toThrow();
      input.provider.mockResolvedValueOnce(otpResponse("PENDING", "synthetic-resend-bearer"));
      expect(yield* Effect.tryPromise(() => challenge.resend())).toEqual({
        status: "retry-allowed",
      });
      expect(yield* Effect.tryPromise(() => challenge.retrySubmission())).toEqual({
        status: "refused",
      });
      expect(input.payloads).toEqual([]);
      expect(input.provider).toHaveBeenCalledTimes(4);
      challenge.dispose();
    })
  ));

it("stops ambiguous provider authorization without offering Fidy submission recovery or replaying an OTP", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = challengeFixture(prepared(yield* Clock.currentTimeMillis));
      input.provider.mockResolvedValueOnce(new Response(null, { status: 503 }));
      const challenge = yield* Effect.tryPromise(input.start);
      const otp = Redacted.make("574829");
      expect(yield* Effect.tryPromise(() => challenge.confirm(otp))).toEqual({
        status: "uncertain",
        retrySubmission: false,
      });
      expect(() => Redacted.value(otp)).toThrow();
      expect(yield* Effect.tryPromise(() => challenge.retrySubmission())).toEqual({
        status: "refused",
      });
      expect(yield* Effect.tryPromise(() => challenge.confirm(Redacted.make("574829")))).toEqual({
        status: "refused",
      });
      expect(yield* Effect.tryPromise(() => challenge.resend())).toEqual({ status: "refused" });
      expect(input.provider).toHaveBeenCalledTimes(3);
      expect(input.payloads).toEqual([]);
      challenge.dispose();
    })
  ));

it.each(["completed", "cancelled"] as const)(
  "keeps pending approved submission exclusive and handles its %s lifetime without another OTP or submission",
  (outcome) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const enrollment = prepared(yield* Clock.currentTimeMillis);
        const started = yield* Deferred.make<void>();
        const pending = yield* Deferred.make<Response>();
        const input = challengeFixture(enrollment, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(pending)))
        );
        const challenge = yield* Effect.tryPromise(input.start);
        const otp = Redacted.make("574829");
        const first = challenge.confirm(otp);
        yield* Deferred.await(started);
        expect(yield* Effect.tryPromise(() => challenge.retrySubmission())).toEqual({
          status: "uncertain",
          retrySubmission: true,
        });
        const duplicateOtp = Redacted.make("574829");
        expect(yield* Effect.tryPromise(() => challenge.confirm(duplicateOtp))).toEqual({
          status: "refused",
        });
        expect(() => Redacted.value(duplicateOtp)).toThrow();
        expect(yield* Effect.tryPromise(() => challenge.resend())).toEqual({ status: "refused" });
        expect(input.payloads).toHaveLength(1);
        expect(input.provider).toHaveBeenCalledTimes(3);
        if (outcome === "cancelled") input.controller.abort();
        yield* Deferred.succeed(
          pending,
          Response.json({
            status: "source-verifying",
            enrollmentId: enrollment.enrollmentId,
          })
        );
        expect(yield* Effect.tryPromise(() => first)).toEqual(
          outcome === "cancelled"
            ? { status: "uncertain", retrySubmission: false }
            : {
                status: "submitted",
                submission: { status: "source-verifying", enrollmentId: enrollment.enrollmentId },
              }
        );
        expect(() => Redacted.value(otp)).toThrow();
        expect(yield* Effect.tryPromise(() => challenge.retrySubmission())).toEqual({
          status: "refused",
        });
        expect(input.payloads).toHaveLength(1);
        expect(input.provider).toHaveBeenCalledTimes(3);
        challenge.dispose();
      })
    )
);

it("refuses actions and consumes OTPs after the mounted challenge is disposed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = challengeFixture(prepared(yield* Clock.currentTimeMillis));
      const challenge = yield* Effect.tryPromise(input.start);
      challenge.dispose();
      const otp = Redacted.make("574829");
      expect(yield* Effect.tryPromise(() => challenge.confirm(otp))).toEqual({ status: "refused" });
      expect(() => Redacted.value(otp)).toThrow();
      expect(yield* Effect.tryPromise(() => challenge.resend())).toEqual({ status: "refused" });
      expect(yield* Effect.tryPromise(() => challenge.retrySubmission())).toEqual({
        status: "refused",
      });
      expect(input.provider).toHaveBeenCalledTimes(2);
      expect(input.payloads).toEqual([]);
      challenge.dispose();
    })
  ));

it("rejects duplicate authorization, never recovers an unapproved token, and revokes idle authority on auth disposal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const enrollment = prepared(yield* Clock.currentTimeMillis);
      const payloads: Array<unknown> = [];
      const client = makeSubscriptionEnrollmentClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, submissionBoundary(enrollment, payloads)),
      });
      const provider = providerFixture();
      vi.stubGlobal("fetch", provider);
      const gateway = makeEnrollmentGateway(client);
      const challenge = yield* Effect.tryPromise(() =>
        gateway.startDaviplata(enrollment, "synthetic@example.invalid", {
          documentNumber: Redacted.make("1122233"),
          productNumber: Redacted.make("3991111111"),
          signal: mountedSignal(),
        })
      );
      expect(yield* Effect.tryPromise(() => challenge.retrySubmission())).toEqual({
        status: "refused",
      });
      const documentNumber = Redacted.make("1122233");
      const productNumber = Redacted.make("3991111111");
      const duplicate = yield* Effect.exit(
        Effect.tryPromise(() =>
          gateway.startDaviplata(enrollment, "synthetic@example.invalid", {
            documentNumber,
            productNumber,
            signal: mountedSignal(),
          })
        )
      );
      expect(duplicate._tag).toBe("Failure");
      expect(() => Redacted.value(documentNumber)).toThrow();
      expect(() => Redacted.value(productNumber)).toThrow();
      yield* Effect.tryPromise(() => client.dispose());
      expect(client.signal.aborted).toBe(true);
      const revokedDocument = Redacted.make("1122233");
      const revokedProduct = Redacted.make("3991111111");
      yield* Effect.exit(
        Effect.tryPromise(() =>
          gateway.startDaviplata(enrollment, "synthetic@example.invalid", {
            documentNumber: revokedDocument,
            productNumber: revokedProduct,
            signal: mountedSignal(),
          })
        )
      );
      expect(() => Redacted.value(revokedDocument)).toThrow();
      expect(() => Redacted.value(revokedProduct)).toThrow();
      const otp = Redacted.make("574829");
      expect(yield* Effect.tryPromise(() => challenge.confirm(otp))).toEqual({ status: "refused" });
      expect(() => Redacted.value(otp)).toThrow();
      expect(yield* Effect.tryPromise(() => challenge.retrySubmission())).toEqual({
        status: "refused",
      });
      expect(payloads).toEqual([]);
      expect(provider).toHaveBeenCalledTimes(2);
      challenge.dispose();
    })
  ));

it("submits only approved authority and reuses one PaymentRequestId after an ambiguous Fidy response", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const enrollment = prepared(yield* Clock.currentTimeMillis);
      const payloads: Array<unknown> = [];
      const http = submissionBoundary(enrollment, payloads);
      const client = makeSubscriptionEnrollmentClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });
      const provider = vi
        .fn((_url: RequestInfo | URL, _init?: RequestInit) =>
          Promise.resolve(otpResponse("APPROVED"))
        )
        .mockResolvedValueOnce(initial())
        .mockResolvedValueOnce(otpResponse("PENDING"));
      vi.stubGlobal("fetch", provider);
      const gateway = makeEnrollmentGateway(client);
      const challenge = yield* Effect.tryPromise(() =>
        gateway.startDaviplata(enrollment, "synthetic@example.invalid", {
          documentNumber: Redacted.make("1122233"),
          productNumber: Redacted.make("3991111111"),
          signal: new AbortController().signal,
        })
      );
      expect(yield* Effect.tryPromise(() => challenge.confirm(Redacted.make("574829")))).toEqual({
        status: "uncertain",
        retrySubmission: true,
      });
      const rejectedOtp = Redacted.make("574829");
      expect(yield* Effect.tryPromise(() => challenge.confirm(rejectedOtp))).toEqual({
        status: "refused",
      });
      expect(() => Redacted.value(rejectedOtp)).toThrow();
      expect(yield* Effect.tryPromise(() => challenge.resend())).toEqual({ status: "refused" });
      const result = yield* Effect.tryPromise(() => challenge.retrySubmission());
      expect(result.status).toBe("submitted");
      expect(yield* Effect.tryPromise(() => challenge.retrySubmission())).toEqual({
        status: "refused",
      });
      const Payload = Schema.Struct({
        method: Schema.Literal("daviplata"),
        paymentSourceMode: Schema.Literal("create"),
        daviplataToken: Schema.String,
        paymentRequestId: Schema.String,
      });
      const first = yield* Schema.decodeUnknownEffect(Payload)(payloads[0]);
      const second = yield* Schema.decodeUnknownEffect(Payload)(payloads[1]);
      expect(first.paymentRequestId).toBe(second.paymentRequestId);
      expect(first.daviplataToken).toBe(token);
      expect(provider).toHaveBeenCalledTimes(3);
      expect(
        payloads.every((payload) => !Schema.is(Schema.Struct({ code: Schema.String }))(payload))
      ).toBe(true);
      challenge.dispose();
      yield* Effect.tryPromise(() => client.dispose());
    })
  ));

it("aborts card tokenization and prevents Fidy submission when its caller cancels", () => {
  const controller = new AbortController();
  return Effect.runPromise(
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<Response>();
      let nativeSignal = Option.none<AbortSignal>();
      let submissions = 0;
      vi.stubGlobal("fetch", (_url: RequestInfo | URL, options?: RequestInit) => {
        nativeSignal = Option.fromNullishOr(options?.signal);
        started.resolve();
        return pending.promise;
      });
      const client = makeSubscriptionEnrollmentClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => {
            submissions += 1;
            return Effect.never;
          })
        ),
      });
      const request = makeEnrollmentGateway(client).submit(
        { ...prepared(yield* Clock.currentTimeMillis), method: "card" },
        "synthetic@example.invalid",
        {
          fields: Option.some({
            number: "4242424242424242",
            cvc: "123",
            expirationMonth: "12",
            expirationYear: "2030",
            cardholderName: "Synthetic",
          }),
          signal: Option.some(controller.signal),
        }
      );
      const outcome = request.then(
        () => "submitted",
        () => "interrupted"
      );
      try {
        yield* Effect.tryPromise(() => started.promise);
        controller.abort();
        yield* Effect.yieldNow;
        expect(Option.exists(nativeSignal, (signal) => signal.aborted)).toBe(true);
        expect(yield* Effect.tryPromise(() => outcome)).toBe("interrupted");
        pending.resolve(Response.json({ data: { id: "tok_test_synthetic", brand: "VISA" } }));
        yield* Effect.yieldNow;
        expect(submissions).toBe(0);
      } finally {
        yield* Effect.tryPromise(() => client.dispose());
      }
    })
  );
});
