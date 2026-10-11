import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterEach, expect, it } from "vitest";
import { PaymentEnrollment, makeSubscriptionEnrollmentClient } from "@/transport/client";
import { type EnrollmentGateway, makeEnrollmentGateway } from "./enrollment-gateway";
import { preparedEnrollment } from "./testing-fixtures";

const mountedSignal = (): AbortSignal => new AbortController().signal;
const enrollmentId = preparedEnrollment.enrollmentId;
const requestId = "22700000-0000-4000-8000-000000000091";
const paymentKey = `fidy.payment-request.${enrollmentId}`;
const emailKey = `fidy.billing-email.${enrollmentId}`;
const disposers: Array<() => Promise<void>> = [];
afterEach(() => {
  sessionStorage.clear();
  return Promise.all(disposers.splice(0).map((dispose) => dispose()));
});
type Request = Readonly<{ path: string; body: unknown }>;
const setup = (
  respond: (request: Request) => Response
): Readonly<{
  gateway: EnrollmentGateway;
  requests: Request[];
}> => {
  const requests: Request[] = [];
  const client = makeSubscriptionEnrollmentClient({
    apiOrigin: "https://api.test.fidyapp.com",
    httpClient: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const decoded = {
          path: new URL(request.url).pathname,
          body:
            request.body._tag === "Uint8Array"
              ? Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
                  new TextDecoder().decode(request.body.body)
                )
              : null,
        };
        requests.push(decoded);
        return Effect.succeed(HttpClientResponse.fromWeb(request, respond(decoded)));
      })
    ),
  });
  disposers.push(() => client.dispose());
  return { gateway: makeEnrollmentGateway(client), requests };
};
const refused = (): Response =>
  Response.json({ status: "refused", enrollmentId, reason: "provider-declined" });

it.each([
  [null, null],
  [requestId, null],
  [null, "verified@example.com"],
  ["invalid", "verified@example.com"],
  [requestId, "invalid"],
] as const)("refuses to resume without valid persisted identity and email: %s", (id, email) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { gateway, requests } = setup(refused);
      if (id !== null) sessionStorage.setItem(paymentKey, id);
      if (email !== null) sessionStorage.setItem(emailKey, email);
      expect(yield* Effect.tryPromise(() => gateway.resume(enrollmentId))).toEqual(Option.none());
      expect(requests).toEqual([]);
    })
  )
);

it("resumes the same PaymentRequestId and releases persisted facts on terminal rejection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      sessionStorage.setItem(paymentKey, requestId);
      sessionStorage.setItem(emailKey, "verified@example.com");
      const { gateway, requests } = setup(refused);
      const resumed = yield* Effect.tryPromise(() =>
        gateway.resume(enrollmentId, new AbortController().signal)
      );
      expect(Option.isSome(resumed)).toBe(true);
      expect(requests[0]?.body).toMatchObject({
        paymentSourceMode: "reuse",
        paymentRequestId: requestId,
        billingEmail: "verified@example.com",
      });
      expect(sessionStorage.getItem(paymentKey)).toBeNull();
      expect(sessionStorage.getItem(emailKey)).toBeNull();
    })
  ));

it("retains and reuses one request identity while source verification is pending", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      sessionStorage.setItem(paymentKey, requestId);
      const { gateway, requests } = setup(() =>
        Response.json({ status: "source-verifying", enrollmentId })
      );
      const reused = { ...preparedEnrollment, paymentSourceMode: "reuse" as const };
      yield* Effect.tryPromise(() => gateway.submit(reused, "verified@example.com"));
      yield* Effect.tryPromise(() => gateway.continue(enrollmentId, "verified@example.com"));
      expect(requests.map((request) => request.body)).toEqual([
        expect.objectContaining({ paymentRequestId: requestId }),
        expect.objectContaining({ paymentRequestId: requestId }),
      ]);
      expect(sessionStorage.getItem(paymentKey)).toBe(requestId);
      expect(sessionStorage.getItem(emailKey)).toBe("verified@example.com");
    })
  ));

it("loads enabled methods and defaults preparation to card through the decoded API boundary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { gateway, requests } = setup(({ path }) =>
        Response.json(
          path.endsWith("availability")
            ? { enabledMethods: ["card"] }
            : Schema.encodeSync(PaymentEnrollment)(preparedEnrollment)
        )
      );
      expect(yield* Effect.tryPromise(() => gateway.availability())).toEqual({
        enabledMethods: ["card"],
      });
      yield* Effect.tryPromise(() => gateway.prepare(preparedEnrollment.price.id));
      yield* Effect.tryPromise(() => gateway.status(enrollmentId));
      expect(requests[1]?.body).toMatchObject({
        method: "card",
        priceId: preparedEnrollment.price.id,
      });
    })
  ));

it.each(["missing", "wrong-card", "wrong-nequi"] as const)(
  "refuses new source submission with %s fields",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { gateway, requests } = setup(refused);
        const nequi = {
          method: "nequi" as const,
          phoneNumber: Redacted.make("3991111111"),
          signal: mountedSignal(),
          onAwaiting: (): void => {},
        };
        const card = {
          number: "4242424242424242",
          cvc: "123",
          expirationMonth: "12",
          expirationYear: "2030",
          cardholderName: "Synthetic",
        };
        const result = yield* Effect.exit(
          Effect.tryPromise(() =>
            gateway.submit(
              kind === "wrong-nequi"
                ? { ...preparedEnrollment, method: "nequi" }
                : preparedEnrollment,
              "verified@example.com",
              {
                fields:
                  kind === "missing"
                    ? Option.none()
                    : Option.some(kind === "wrong-card" ? nequi : card),
                signal: Option.none(),
              }
            )
          )
        );
        expect(result._tag).toBe("Failure");
        expect(requests).toEqual([]);
        Redacted.wipeUnsafe(nequi.phoneNumber);
      })
    )
);
