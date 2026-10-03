import { BigDecimal, Clock, DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { afterEach, expect, it, vi } from "vitest";
import {
  BillingEmail,
  PaymentEnrollmentId,
  PriceId,
  makeSubscriptionEnrollmentClient,
} from "@/transport/client";
import { type WompiFetch } from "@/transport/wompi-tokenization";
import { UnknownJsonString } from "@/schema-compatibility";
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
const otpResponse = (status: "PENDING" | "APPROVED"): Response =>
  Response.json({
    data: {
      subscription: { PK: token, status },
      authorization: { access_token: `synthetic-${status}-bearer` },
      attempts: {
        currentSendCode: 1,
        limitSendCode: 2,
        currentValidateCode: 0,
        limitValidateCode: 2,
      },
    },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

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
              makeEnrollmentGateway(client).submit(
                enrollment,
                "synthetic@example.invalid",
                fieldsKind === "missing-fields"
                  ? undefined
                  : {
                      method: "nequi",
                      phoneNumber: Redacted.make("3991111111"),
                      signal: mountedSignal(),
                      onAwaiting: (): void => {},
                    }
              )
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
  payloads: Array<unknown>
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
          return HttpClientResponse.fromWeb(
            request,
            payloads.length === 1
              ? new Response(null, { status: 503 })
              : Response.json({ status: "source-verifying", enrollmentId: enrollment.enrollmentId })
          );
        })
      ),
    Effect.succeed
  );
const mountedSignal = (): AbortSignal => new AbortController().signal;
const providerFixture = (): WompiFetch =>
  vi
    .fn((_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      Promise.resolve(otpResponse("APPROVED"))
    )
    .mockResolvedValueOnce(initial())
    .mockResolvedValueOnce(otpResponse("PENDING"));

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
