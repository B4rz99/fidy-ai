import { createHash } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { ConfigProvider, Crypto, DateTime, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SqlSchema } from "effect/unstable/sql";
import { ConsentRecordId } from "~/core/consent/model";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { WebSessionId } from "~/core/web-session/reference";
import { calculateWebSessionDeadlines } from "~/core/web-session/rules";
import { MigrationSqlClient } from "~/shell/db/client";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { withSubjectLock } from "~/shell/consent/repo";
import { ApiHarness } from "~/shell/testing/api-harness";
import { revokeCurrentOnboardingConsentForTesting } from "~/shell/testing/consent";
import {
  BillingAttemptId,
  PaymentRequestId,
  type PriceId,
  WompiTransactionId,
  WompiTransactionReference,
} from "~/core/subscription/model";
import {
  CardEnrollment,
  type CardEnrollmentId,
  CardPaymentSubmission,
  WompiSourceId,
} from "~/core/subscription/enrollment-model";
import { publishBillingAttemptInScope } from "./billing-attempt-execution";
import {
  armBillingAttemptInScope,
  findBillingAttemptByRequestInScope,
  getBillingContextInScope,
  insertPendingBillingAttemptInScope,
} from "./billing-repo";
import { reconcileCardEnrollment } from "./card-enrollment";
import { findPrice } from "./repo";
import { receiveWompiSettlement } from "./wompi-settlement";

const userId = UserId.make("22800000-0000-4000-8000-000000000001");
const sessionId = WebSessionId.make("22800000-0000-4000-8000-000000000002");
const sessionBearer = "6".repeat(43);
const seedBearer = TokenBearer.make("fin_wompise1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const sessionCookie = `__Host-fidy_session=${sessionBearer}`;
const outcomeUserId = UserId.make("22800000-0000-4000-8000-000000000011");
const outcomeSessionId = WebSessionId.make("22800000-0000-4000-8000-000000000012");
const outcomeSeedBearer = TokenBearer.make("fin_wompise2_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const outcomeBearer = "7".repeat(43);
const outcomeCookie = `__Host-fidy_session=${outcomeBearer}`;
const limitedUserId = UserId.make("22800000-0000-4000-8000-000000000021");
const limitedSessionId = WebSessionId.make("22800000-0000-4000-8000-000000000022");
const limitedSeedBearer = TokenBearer.make("fin_wompise3_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const limitedBearer = `wompi_rl_${"3".repeat(34)}`;
const limitedCookie = `__Host-fidy_session=${limitedBearer}`;
const weeklyPriceId = "22700000-0000-4000-8000-000000000001";
const monthlyPriceId = "22700000-0000-4000-8000-000000000002";
const yearlyPriceId = "22700000-0000-4000-8000-000000000003";
const testWompiEventSecret = "test_events_subscription_settlement";
const WompiEventConfig = ConfigProvider.fromUnknown({
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_EVENT_SECRET: testWompiEventSecret,
});

const signedWompiEvent = (
  transaction: {
    id: string;
    reference: string;
    status: "APPROVED" | "DECLINED";
    amountInCents: number;
    sourceId: number;
    finalizedAt: Option.Option<string>;
  },
  validChecksum = true,
  completeSignature = true
): unknown => {
  const timestamp = 1_772_323_200;
  const completeProperties = [
    "transaction.id",
    "transaction.status",
    "transaction.amount_in_cents",
  ];
  const properties = completeSignature ? completeProperties : completeProperties.slice(0, 2);
  const signedValues = completeSignature
    ? `${transaction.id}${transaction.status}${transaction.amountInCents}`
    : `${transaction.id}${transaction.status}`;
  const checksum = createHash("sha256")
    .update(`${signedValues}${timestamp}${testWompiEventSecret}`)
    .digest("hex");
  return {
    event: "transaction.updated",
    data: {
      transaction: {
        id: transaction.id,
        reference: transaction.reference,
        status: transaction.status,
        amount_in_cents: transaction.amountInCents,
        currency: "COP",
        payment_source_id: transaction.sourceId,
        finalized_at: Option.getOrNull(transaction.finalizedAt),
      },
    },
    timestamp,
    signature: { checksum: validChecksum ? checksum : "0".repeat(64), properties },
  };
};

const prepareRequest = (origin?: string, cookie?: string): HttpClientRequest.HttpClientRequest => {
  const request = HttpClientRequest.post("/web/subscription/card-enrollments/prepare").pipe(
    HttpClientRequest.setBody(HttpBody.jsonUnsafe({ priceId: monthlyPriceId }))
  );
  return HttpClientRequest.setHeaders(request, {
    ...(origin === undefined ? {} : { origin }),
    ...(cookie === undefined ? {} : { cookie }),
  });
};

const seedWebSessionFor = Effect.fn("Test.seedEnrollmentWebSession")(function* ({
  targetUserId,
  targetSessionId,
  targetBearer,
  targetSeedBearer,
  targetEmail,
  targetPairedAt,
}: Readonly<{
  targetUserId: UserId;
  targetSessionId: WebSessionId;
  targetBearer: string;
  targetSeedBearer: TokenBearer;
  targetEmail: string;
  targetPairedAt: Option.Option<DateTime.Utc>;
}>) {
  yield* seedConsentedPatIdentity({ userId: targetUserId, bearer: targetSeedBearer });
  const currentTime = yield* DateTime.now;
  const now = Option.getOrElse(targetPairedAt, () => currentTime);
  const deadlines = calculateWebSessionDeadlines(now);
  const crypto = yield* Crypto.Crypto;
  const bearerDigest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(targetBearer))
    .pipe(Effect.orDie);
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM card_enrollments WHERE user_id = ${targetUserId}`;
  yield* sql`DELETE FROM card_payment_sources WHERE user_id = ${targetUserId}`;
  yield* sql`DELETE FROM web_sessions WHERE user_id = ${targetUserId}`;
  yield* sql`
    INSERT INTO verified_email_credentials (user_id, email_address, verified_at)
    VALUES (${targetUserId}, ${targetEmail}, ${now})
    ON CONFLICT (user_id) DO UPDATE SET
      email_address = EXCLUDED.email_address, verified_at = EXCLUDED.verified_at
  `;
  yield* sql`
    INSERT INTO web_sessions (
      id, user_id, bearer_digest, paired_at, fresh_until, idle_expires_at, hard_expires_at
    ) VALUES (
      ${targetSessionId}, ${targetUserId}, ${bearerDigest}, ${now}, ${deadlines.freshUntil},
      ${deadlines.idleExpiresAt}, ${deadlines.hardExpiresAt}
    )
  `;
});

const seedWebSession = seedWebSessionFor({
  targetUserId: userId,
  targetSessionId: sessionId,
  targetBearer: sessionBearer,
  targetSeedBearer: seedBearer,
  targetEmail: "verified@example.com",
  targetPairedAt: Option.none(),
});

const waitForBlockedAdvisoryLocks = Effect.fn("Test.waitForBlockedAdvisoryLocks")(function* (
  expected: number
) {
  const sql = yield* MigrationSqlClient;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [result] = yield* sql`
      SELECT COUNT(*)::int AS count FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
    `;
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Int }))(result);
    if (decoded.count >= expected) return;
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die("advisory-lock waiter did not arrive");
});

const assertArmedRedeliveryCannotRearm = Effect.fn(function* (input: {
  userId: UserId;
  billingAttemptId: BillingAttemptId;
}) {
  const redeliveryArm = yield* withUserTransaction(
    input.userId,
    armBillingAttemptInScope(
      input.userId,
      input.billingAttemptId,
      DateTime.makeUnsafe("2026-03-01T11:59:58Z")
    )
  );
  expect(Option.isNone(redeliveryArm)).toBe(true);
});

const assertBillingAttemptVisibilityBoundaries = Effect.fn(function* (
  billingAttemptId: BillingAttemptId
) {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    UPDATE web_sessions SET paired_at = now() - interval '1 hour',
      fresh_until = now() - interval '50 minutes',
      hard_expires_at = now() + interval '89 days 23 hours'
    WHERE id = ${sessionId}
  `;
  const ownerObservation = yield* HttpClient.get(
    `/web/subscription/billing-attempts/${billingAttemptId}`,
    { headers: { origin: "https://fidyapp.com", cookie: sessionCookie } }
  );
  expect(ownerObservation.status).toBe(200);
  expect(yield* ownerObservation.json).toMatchObject({ id: billingAttemptId, status: "succeeded" });
  const crossUserObservation = yield* HttpClient.get(
    `/web/subscription/billing-attempts/${billingAttemptId}`,
    { headers: { origin: "https://fidyapp.com", cookie: outcomeCookie } }
  );
  expect(crossUserObservation.status).toBe(400);
});

const assertEnrollmentLifecycleStatuses = Effect.fn(function* (enrollmentId: CardEnrollmentId) {
  const sql = yield* MigrationSqlClient;
  for (const status of ["creating", "verifying"] as const) {
    yield* sql`
      UPDATE card_enrollments SET status = ${status}, payment_source_id = NULL
      WHERE id = ${enrollmentId} AND user_id = ${userId}
    `;
    const observed = yield* HttpClient.get(`/web/subscription/card-enrollments/${enrollmentId}`, {
      headers: { origin: "https://fidyapp.com", cookie: sessionCookie },
    });
    expect(yield* observed.json).toMatchObject({ status });
  }
});

const assertPublicationRollsBack = Effect.fn(function* (input: {
  userId: UserId;
  enrollmentId: CardEnrollmentId;
  priceId: PriceId;
}) {
  const rollbackAttemptId = BillingAttemptId.make("22900000-0000-4000-8000-000000000090");
  const rollback = yield* Effect.result(
    withUserTransaction(
      input.userId,
      Effect.gen(function* () {
        const context = yield* getBillingContextInScope(input.userId, input.enrollmentId);
        const price = yield* findPrice(input.priceId);
        if (Option.isNone(context) || Option.isNone(price)) {
          return yield* Effect.die("rollback fixture context is missing");
        }
        yield* insertPendingBillingAttemptInScope({
          userId: input.userId,
          billingAttemptId: rollbackAttemptId,
          subscriptionId: context.value.subscriptionId,
          paymentRequestId: PaymentRequestId.make("22900000-0000-4000-8000-000000000090"),
          enrollmentId: input.enrollmentId,
          paymentSourceId: context.value.paymentSourceId,
          price: price.value,
          timeZone: context.value.timeZone,
          wompiEnvironment: "sandbox",
          reference: WompiTransactionReference.make("fidy-22900000-0000-4000-8000-000000000090"),
          createdAt: DateTime.makeUnsafe("2026-03-01T12:00:02Z"),
        });
        yield* publishBillingAttemptInScope({
          userId: input.userId,
          billingAttemptId: rollbackAttemptId,
        });
        return yield* Effect.fail("force publication rollback" as const);
      })
    )
  );
  expect(rollback._tag).toBe("Failure");
  const sql = yield* MigrationSqlClient;
  const rolledBack = yield* SqlSchema.findOne({
    Request: Schema.Struct({ id: BillingAttemptId }),
    Result: Schema.Struct({ count: Schema.Int }),
    execute: ({ id }) => sql`
      SELECT count(*)::int AS count FROM billing_attempts WHERE id = ${id}
    `,
  })({ id: rollbackAttemptId }).pipe(Effect.orDie);
  expect(rolledBack.count).toBe(0);
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "subscription enrollment HTTP boundary",
  (it) => {
    it.effect("rejects a missing browser Origin before reading enrollment input", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(prepareRequest());
        expect(response.status).toBe(403);
        expect(response.headers["cache-control"]).toBe("no-store");
      })
    );

    it.effect("rejects a cross origin before reading enrollment input", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(prepareRequest("https://attacker.example"));
        expect(response.status).toBe(403);
        expect(response.headers["cache-control"]).toBe("no-store");
      })
    );

    it.effect("requires WebSession authority at the configured exact Origin", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(prepareRequest("https://fidyapp.com"));
        expect(response.status).toBe(401);
        expect(response.headers["cache-control"]).toBe("no-store");
      })
    );

    it.effect("requires a fresh WebSession without retaining enrollment state", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* seedWebSessionFor({
          targetUserId: userId,
          targetSessionId: sessionId,
          targetBearer: sessionBearer,
          targetSeedBearer: seedBearer,
          targetEmail: "verified@example.com",
          targetPairedAt: Option.some(DateTime.subtract(now, { hours: 2 })),
        });
        const sql = yield* MigrationSqlClient;
        const response = yield* HttpClient.execute(
          prepareRequest("https://fidyapp.com", sessionCookie)
        );
        expect(response.status).toBe(401);
        const staleSubmit = yield* HttpClient.post("/web/subscription/card-enrollments/submit", {
          headers: { origin: "https://fidyapp.com", cookie: sessionCookie },
          body: HttpBody.jsonUnsafe({
            paymentSourceMode: "reuse",
            paymentRequestId: "22900000-0000-4000-8000-000000000001",
            enrollmentId: "22800000-0000-4000-8000-000000000088",
            billingEmail: "verified@example.com",
          }),
        });
        expect(staleSubmit.status).toBe(401);
        const staleStatus = yield* HttpClient.get(
          "/web/subscription/card-enrollments/22800000-0000-4000-8000-000000000088",
          { headers: { origin: "https://fidyapp.com", cookie: sessionCookie } }
        );
        expect(staleStatus.status).toBe(401);
        const [count] = yield* sql`
          SELECT COUNT(*)::int AS count FROM card_enrollments WHERE user_id = ${userId}
        `;
        expect(count?.count).toBe(0);
      })
    );

    it.effect("rejects revoked Consent without retaining enrollment state", () =>
      Effect.gen(function* () {
        yield* seedWebSession;
        yield* revokeCurrentOnboardingConsentForTesting(
          userId,
          ConsentRecordId.make("22800000-0000-4000-8000-000000000099")
        );

        const response = yield* HttpClient.execute(
          prepareRequest("https://fidyapp.com", sessionCookie)
        );
        expect(response.status).toBe(403);
        const sql = yield* MigrationSqlClient;
        const [count] = yield* sql`
          SELECT COUNT(*)::int AS count FROM card_enrollments WHERE user_id = ${userId}
        `;
        expect(count?.count).toBe(0);
      })
    );

    it.effect("serializes Consent revocation ahead of source creation", () =>
      Effect.gen(function* () {
        yield* seedWebSession;
        const preparedResponse = yield* HttpClient.execute(
          prepareRequest("https://fidyapp.com", sessionCookie)
        );
        const prepared = yield* Schema.decodeUnknownEffect(CardEnrollment)(
          yield* preparedResponse.json
        );
        if (prepared.status !== "prepared") return yield* Effect.die("expected preparation");

        const lockAcquired = yield* Deferred.make<void>();
        const releaseLock = yield* Deferred.make<void>();
        const holder = yield* withSubjectLock(
          userId,
          Deferred.succeed(lockAcquired, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLock))
          )
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(lockAcquired);
        const revocation = yield* revokeCurrentOnboardingConsentForTesting(
          userId,
          ConsentRecordId.make("22800000-0000-4000-8000-000000000098")
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* waitForBlockedAdvisoryLocks(1);
        const submission = yield* HttpClient.post("/web/subscription/card-enrollments/submit", {
          headers: { origin: "https://fidyapp.com", cookie: sessionCookie },
          body: HttpBody.jsonUnsafe({
            paymentSourceMode: "create",
            paymentRequestId: "22900000-0000-4000-8000-000000000001",
            enrollmentId: prepared.enrollmentId,
            billingEmail: "verified@example.com",
            cardToken: "tok_test_consent_race",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
        }).pipe(Effect.forkChild({ startImmediately: true }));
        yield* waitForBlockedAdvisoryLocks(2);
        yield* Deferred.succeed(releaseLock, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(revocation);
        expect((yield* Fiber.join(submission)).status).toBe(403);

        const sql = yield* MigrationSqlClient;
        const [enrollment] = yield* sql`
          SELECT status, accepted_at FROM card_enrollments
          WHERE user_id = ${userId} AND id = ${prepared.enrollmentId}
        `;
        expect(enrollment).toMatchObject({ status: "prepared", accepted_at: null });
        const [sources] = yield* sql`
          SELECT COUNT(*)::int AS count FROM card_payment_sources WHERE user_id = ${userId}
        `;
        expect(sources?.count).toBe(0);
      })
    );

    it.effect("keeps Wompi event secrets out of authentication failures", () =>
      Effect.gen(function* () {
        const signed = signedWompiEvent(
          {
            id: "event-secret-test",
            reference: "fidy-22900000-0000-4000-8000-000000000099",
            status: "APPROVED",
            amountInCents: 1_000,
            sourceId: 3891,
            finalizedAt: Option.some("2026-03-01T00:00:00.000Z"),
          },
          false
        );
        const failure = yield* Effect.flip(
          receiveWompiSettlement({
            payload: signed,
            observedAt: DateTime.makeUnsafe("2026-03-01T00:00:01Z"),
          }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, WompiEventConfig))
        );
        expect(failure).toMatchObject({ _tag: "InvalidWompiEvent" });
        expect(String(failure)).not.toContain(testWompiEventSecret);
      })
    );

    it.effect("rejects unsupported, oversized, and structurally invalid JSON", () =>
      Effect.gen(function* () {
        yield* seedWebSession;
        const headers = { origin: "https://fidyapp.com", cookie: sessionCookie };
        const missingContentType = yield* HttpClient.execute(
          HttpClientRequest.post("/web/subscription/card-enrollments/prepare").pipe(
            HttpClientRequest.setHeaders(headers)
          )
        );
        expect(missingContentType.status).toBe(415);
        const unsupported = yield* HttpClient.post("/web/subscription/card-enrollments/prepare", {
          headers,
          body: HttpBody.text("{}", "text/plain"),
        });
        expect(unsupported.status).toBe(415);
        const oversized = yield* HttpClient.post("/web/subscription/card-enrollments/prepare", {
          headers: { ...headers, "content-type": "application/json" },
          body: HttpBody.text(`{"priceId":"${"x".repeat(7000)}"}`, "application/json"),
        });
        expect(oversized.status).toBe(413);
        const invalid = yield* HttpClient.post("/web/subscription/card-enrollments/prepare", {
          headers: { ...headers, "content-type": "application/json" },
          body: HttpBody.jsonUnsafe({ priceId: monthlyPriceId, unexpected: true }),
        });
        expect(invalid.status).toBe(400);
        const invalidSubmit = yield* HttpClient.post("/web/subscription/card-enrollments/submit", {
          headers: { ...headers, "content-type": "application/json" },
          body: HttpBody.jsonUnsafe({
            paymentSourceMode: "create",
            paymentRequestId: "22900000-0000-4000-8000-000000000001",
            unexpected: true,
          }),
        });
        expect(invalidSubmit.status).toBe(400);
        const malformedWebhook = yield* HttpClient.post("/webhooks/wompi", {
          body: HttpBody.text("{", "application/json"),
        });
        expect(malformedWebhook.status).toBe(400);
        const unauthenticatedWebhook = yield* HttpClient.post("/webhooks/wompi", {
          body: HttpBody.jsonUnsafe({ event: "transaction.updated" }),
        });
        expect(unauthenticatedWebhook.status).toBe(401);
        const partiallySignedWebhook = yield* HttpClient.post("/webhooks/wompi", {
          body: HttpBody.jsonUnsafe(
            signedWompiEvent(
              {
                id: "partially-signed",
                reference: "fidy-22900000-0000-4000-8000-000000000099",
                status: "APPROVED",
                amountInCents: 1_000,
                sourceId: 3891,
                finalizedAt: Option.some("2026-03-01T00:00:00.000Z"),
              },
              true,
              false
            )
          ),
        });
        expect(partiallySignedWebhook.status).toBe(401);
        const oversizedWebhook = yield* HttpClient.post("/webhooks/wompi", {
          body: HttpBody.text("x".repeat(33_000), "application/json"),
        });
        expect(oversizedWebhook.status).toBe(413);
      })
    );

    it.effect("rejects an unknown Price and enrollment without enumeration", () =>
      Effect.gen(function* () {
        yield* seedWebSession;
        const unknownPrice = HttpClientRequest.post(
          "/web/subscription/card-enrollments/prepare"
        ).pipe(
          HttpClientRequest.setHeaders({ origin: "https://fidyapp.com", cookie: sessionCookie }),
          HttpClientRequest.setBody(
            HttpBody.jsonUnsafe({ priceId: "22700000-0000-4000-8000-999999999999" })
          )
        );
        expect((yield* HttpClient.execute(unknownPrice)).status).toBe(400);
        const unknownStatus = yield* HttpClient.get(
          "/web/subscription/card-enrollments/22700000-0000-4000-8000-999999999999",
          { headers: { origin: "https://fidyapp.com", cookie: sessionCookie } }
        );
        expect(unknownStatus.status).toBe(400);
      })
    );

    it.effect("expires a stale intent and rejects a mismatched source mode", () =>
      Effect.gen(function* () {
        yield* seedWebSession;
        const preparedResponse = yield* HttpClient.execute(
          prepareRequest("https://fidyapp.com", sessionCookie)
        );
        const prepared = yield* Schema.decodeUnknownEffect(CardEnrollment)(
          yield* preparedResponse.json
        );
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") return;
        const replacementRequest = HttpClientRequest.post(
          "/web/subscription/card-enrollments/prepare"
        ).pipe(
          HttpClientRequest.setHeaders({ origin: "https://fidyapp.com", cookie: sessionCookie }),
          HttpClientRequest.setBody(HttpBody.jsonUnsafe({ priceId: yearlyPriceId }))
        );
        const replacementResponse = yield* HttpClient.execute(replacementRequest);
        const replacement = yield* Schema.decodeUnknownEffect(CardEnrollment)(
          yield* replacementResponse.json
        );
        expect(replacement).toMatchObject({ status: "prepared", price: { id: yearlyPriceId } });
        if (replacement.status !== "prepared") return;
        const headers = {
          origin: "https://fidyapp.com",
          cookie: sessionCookie,
          "content-type": "application/json",
        };
        const mismatched = yield* HttpClient.post("/web/subscription/card-enrollments/submit", {
          headers,
          body: HttpBody.jsonUnsafe({
            paymentSourceMode: "reuse",
            paymentRequestId: "22900000-0000-4000-8000-000000000001",
            enrollmentId: replacement.enrollmentId,
            billingEmail: "payer@example.com",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
        });
        expect(mismatched.status).toBe(400);
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE card_enrollments SET
            prepared_at = prepared_at - interval '1 hour',
            expires_at = expires_at - interval '1 hour'
          WHERE id = ${replacement.enrollmentId} AND user_id = ${userId}
        `;
        const expired = yield* HttpClient.post("/web/subscription/card-enrollments/submit", {
          headers,
          body: HttpBody.jsonUnsafe({
            paymentSourceMode: "create",
            paymentRequestId: "22900000-0000-4000-8000-000000000001",
            enrollmentId: replacement.enrollmentId,
            billingEmail: "payer@example.com",
            cardToken: "tok_test_expired",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
        });
        expect(yield* expired.json).toMatchObject({ status: "refused", reason: "expired" });
      })
    );

    it.effect("settles definitive and ambiguous provider outcomes without replay", () =>
      Effect.gen(function* () {
        yield* seedWebSessionFor({
          targetUserId: outcomeUserId,
          targetSessionId: outcomeSessionId,
          targetBearer: outcomeBearer,
          targetSeedBearer: outcomeSeedBearer,
          targetEmail: "outcomes@example.com",
          targetPairedAt: Option.none(),
        });
        for (const [cardToken, expectedStatus] of [
          ["tok_test_declined", "refused"],
          ["tok_test_rejected", "refused"],
          ["tok_test_ambiguous", "source-verifying"],
        ] as const) {
          const preparedResponse = yield* HttpClient.execute(
            prepareRequest("https://fidyapp.com", outcomeCookie)
          );
          const prepared = yield* Schema.decodeUnknownEffect(CardEnrollment)(
            yield* preparedResponse.json
          );
          expect(prepared.status).toBe("prepared");
          if (prepared.status !== "prepared") return;
          const submitted = yield* HttpClient.post("/web/subscription/card-enrollments/submit", {
            headers: {
              origin: "https://fidyapp.com",
              cookie: outcomeCookie,
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe({
              paymentSourceMode: "create",
              paymentRequestId: "22900000-0000-4000-8000-000000000001",
              enrollmentId: prepared.enrollmentId,
              billingEmail: "outcome@example.com",
              cardToken,
              decisions: {
                acceptedEndUserPolicy: true,
                acceptedPersonalDataAuthorization: true,
                authorizedRecurringCharges: true,
              },
            }),
          });
          const outcome = yield* submitted.json;
          expect(outcome).toMatchObject({ status: expectedStatus });
          if (expectedStatus === "source-verifying") {
            const replayedPrepare = yield* HttpClient.execute(
              prepareRequest("https://fidyapp.com", outcomeCookie)
            );
            expect(yield* replayedPrepare.json).toMatchObject({
              enrollmentId: prepared.enrollmentId,
              status: "verifying",
            });
            const mismatchedSource = yield* Effect.flip(
              reconcileCardEnrollment({
                userId: outcomeUserId,
                enrollmentId: prepared.enrollmentId,
                outcome: { _tag: "Available", sourceId: WompiSourceId.make(4992) },
                reconciledAt: yield* DateTime.now,
              })
            );
            expect(mismatchedSource._tag).toBe("CardEnrollmentInvalid");
            yield* reconcileCardEnrollment({
              userId: outcomeUserId,
              enrollmentId: prepared.enrollmentId,
              outcome: { _tag: "Available", sourceId: WompiSourceId.make(4991) },
              reconciledAt: yield* DateTime.now,
            });
            const reconciled = yield* HttpClient.get(
              `/web/subscription/card-enrollments/${prepared.enrollmentId}`,
              { headers: { origin: "https://fidyapp.com", cookie: outcomeCookie } }
            );
            expect(yield* reconciled.json).toMatchObject({ status: "available" });
          }
        }
      })
    );

    it.effect("bounds repeated source-creation failures by stable User", () =>
      Effect.gen(function* () {
        yield* seedWebSessionFor({
          targetUserId: limitedUserId,
          targetSessionId: limitedSessionId,
          targetBearer: limitedBearer,
          targetSeedBearer: limitedSeedBearer,
          targetEmail: "limited@example.com",
          targetPairedAt: Option.none(),
        });
        const submitPrepared = (enrollmentId: string): ReturnType<typeof HttpClient.post> =>
          HttpClient.post("/web/subscription/card-enrollments/submit", {
            headers: {
              origin: "https://fidyapp.com",
              cookie: limitedCookie,
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe({
              paymentSourceMode: "create",
              paymentRequestId: "22900000-0000-4000-8000-000000000001",
              enrollmentId,
              billingEmail: "limited@example.com",
              cardToken: "tok_test_declined",
              decisions: {
                acceptedEndUserPolicy: true,
                acceptedPersonalDataAuthorization: true,
                authorizedRecurringCharges: true,
              },
            }),
          });

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const preparedResponse = yield* HttpClient.execute(
            prepareRequest("https://fidyapp.com", limitedCookie)
          );
          const prepared = yield* Schema.decodeUnknownEffect(CardEnrollment)(
            yield* preparedResponse.json
          );
          if (prepared.status !== "prepared") return yield* Effect.die("expected preparation");
          expect((yield* submitPrepared(prepared.enrollmentId)).status).toBe(200);
        }

        const limitedPreparation = yield* HttpClient.execute(
          prepareRequest("https://fidyapp.com", limitedCookie)
        );
        const limited = yield* Schema.decodeUnknownEffect(CardEnrollment)(
          yield* limitedPreparation.json
        );
        if (limited.status !== "prepared") return yield* Effect.die("expected preparation");
        expect((yield* submitPrepared(limited.enrollmentId)).status).toBe(503);
        const sql = yield* MigrationSqlClient;
        const [count] = yield* sql`
          SELECT COUNT(*)::int AS count FROM card_enrollments
          WHERE user_id = ${limitedUserId} AND accepted_at IS NOT NULL
        `;
        expect(count?.count).toBe(5);

        for (let replacement = 0; replacement < 6; replacement += 1) {
          const priceId = replacement % 2 === 0 ? yearlyPriceId : monthlyPriceId;
          const response = yield* HttpClient.post("/web/subscription/card-enrollments/prepare", {
            headers: { origin: "https://fidyapp.com", cookie: limitedCookie },
            body: HttpBody.jsonUnsafe({ priceId }),
          });
          expect(response.status).toBe(200);
        }
        const preparationLimited = yield* HttpClient.post(
          "/web/subscription/card-enrollments/prepare",
          {
            headers: { origin: "https://fidyapp.com", cookie: limitedCookie },
            body: HttpBody.jsonUnsafe({ priceId: yearlyPriceId }),
          }
        );
        expect(preparationLimited.status).toBe(503);
      })
    );

    it.effect("claims one prepared enrollment and observes submit replay without duplication", () =>
      Effect.gen(function* () {
        yield* seedWebSession;
        const fixtureSql = yield* MigrationSqlClient;
        yield* fixtureSql`DELETE FROM wompi_billing_observations WHERE user_id = ${userId}`;
        yield* fixtureSql`DELETE FROM paid_subscription_periods WHERE user_id = ${userId}`;
        yield* fixtureSql`DELETE FROM billing_attempts WHERE user_id = ${userId}`;
        yield* fixtureSql`UPDATE subscriptions SET paid_pro_active = false WHERE user_id = ${userId}`;
        const preparedResponse = yield* HttpClient.execute(
          prepareRequest("https://fidyapp.com", sessionCookie)
        );
        expect(preparedResponse.status).toBe(200);
        const prepared = yield* Schema.decodeUnknownEffect(CardEnrollment)(
          yield* preparedResponse.json
        );
        expect(prepared.status).toBe("prepared");
        if (prepared.status !== "prepared") return;
        const repeatedPrepare = yield* HttpClient.execute(
          prepareRequest("https://fidyapp.com", sessionCookie)
        );
        expect(yield* repeatedPrepare.json).toMatchObject({
          enrollmentId: prepared.enrollmentId,
          status: "prepared",
        });

        const submitRequest = HttpClientRequest.post(
          "/web/subscription/card-enrollments/submit"
        ).pipe(
          HttpClientRequest.setHeaders({
            origin: "https://fidyapp.com",
            cookie: sessionCookie,
            "content-type": "application/json",
          }),
          HttpClientRequest.setBody(
            HttpBody.jsonUnsafe({
              paymentSourceMode: "create",
              paymentRequestId: "22900000-0000-4000-8000-000000000001",
              enrollmentId: prepared.enrollmentId,
              billingEmail: "billing@example.com",
              cardToken: "tok_test_browser_only",
              decisions: {
                acceptedEndUserPolicy: true,
                acceptedPersonalDataAuthorization: true,
                authorizedRecurringCharges: true,
              },
            })
          )
        );
        const first = yield* HttpClient.execute(submitRequest);
        const replay = yield* HttpClient.execute(submitRequest);
        expect(first.status).toBe(200);
        expect(replay.status).toBe(200);
        const firstPayment = yield* Schema.decodeUnknownEffect(CardPaymentSubmission)(
          yield* first.json
        );
        const replayedPayment = yield* Schema.decodeUnknownEffect(CardPaymentSubmission)(
          yield* replay.json
        );
        if (
          firstPayment.status !== "payment-pending" ||
          replayedPayment.status !== "payment-pending"
        ) {
          return yield* Effect.die("payment fixture did not start");
        }
        expect(replayedPayment).toMatchObject({
          status: "payment-pending",
          billingAttempt: { id: firstPayment.billingAttempt.id },
        });
        const distinctRequest = yield* HttpClient.post(
          "/web/subscription/card-enrollments/submit",
          {
            headers: {
              origin: "https://fidyapp.com",
              cookie: sessionCookie,
              "content-type": "application/json",
            },
            body: HttpBody.jsonUnsafe({
              paymentSourceMode: "reuse",
              paymentRequestId: "22900000-0000-4000-8000-000000000099",
              enrollmentId: prepared.enrollmentId,
              billingEmail: "billing@example.com",
              decisions: {
                acceptedEndUserPolicy: true,
                acceptedPersonalDataAuthorization: true,
                authorizedRecurringCharges: true,
              },
            }),
          }
        );
        expect(yield* distinctRequest.json).toMatchObject({
          status: "payment-pending",
          billingAttempt: { id: firstPayment.billingAttempt.id },
        });
        const crossUserAttempt = yield* withUserTransaction(
          outcomeUserId,
          findBillingAttemptByRequestInScope(
            outcomeUserId,
            PaymentRequestId.make("22900000-0000-4000-8000-000000000001")
          )
        );
        expect(Option.isNone(crossUserAttempt)).toBe(true);
        const sql = yield* MigrationSqlClient;
        const providerAttempt = yield* SqlSchema.findOne({
          Request: Schema.Struct({ id: Schema.String }),
          Result: Schema.Struct({
            reference: WompiTransactionReference,
            transactionId: Schema.OptionFromNullOr(WompiTransactionId),
            amount: Schema.String,
            sourceId: Schema.String,
          }),
          execute: ({ id }) => sql`
            SELECT attempt.wompi_transaction_reference AS reference,
              attempt.wompi_transaction_id AS "transactionId", attempt.amount::text AS amount,
              source.wompi_source_id::text AS "sourceId"
            FROM billing_attempts AS attempt
            INNER JOIN card_payment_sources AS source ON source.id = attempt.payment_source_id
            WHERE attempt.id = ${id}
          `,
        })({ id: firstPayment.billingAttempt.id }).pipe(Effect.orDie);
        let providerAttemptWithTransaction = providerAttempt;
        while (Option.isNone(providerAttemptWithTransaction.transactionId)) {
          yield* Effect.sleep("10 millis");
          providerAttemptWithTransaction = yield* SqlSchema.findOne({
            Request: Schema.Struct({ id: Schema.String }),
            Result: Schema.Struct({
              reference: WompiTransactionReference,
              transactionId: Schema.OptionFromNullOr(WompiTransactionId),
              amount: Schema.String,
              sourceId: Schema.String,
            }),
            execute: ({ id }) => sql`
              SELECT attempt.wompi_transaction_reference AS reference,
                attempt.wompi_transaction_id AS "transactionId", attempt.amount::text AS amount,
                source.wompi_source_id::text AS "sourceId"
              FROM billing_attempts AS attempt
              INNER JOIN card_payment_sources AS source ON source.id = attempt.payment_source_id
              WHERE attempt.id = ${id}
            `,
          })({ id: firstPayment.billingAttempt.id }).pipe(Effect.orDie);
        }
        const provider = {
          ...providerAttemptWithTransaction,
          transactionId: providerAttemptWithTransaction.transactionId.value,
        };
        yield* assertArmedRedeliveryCannotRearm({
          userId,
          billingAttemptId: firstPayment.billingAttempt.id,
        });
        const finalizedAt = "2026-03-01T12:00:00.000Z";
        const approvedEvent = signedWompiEvent({
          id: provider.transactionId,
          reference: provider.reference,
          status: "APPROVED",
          amountInCents: Number(provider.amount) * 100,
          sourceId: Number(provider.sourceId),
          finalizedAt: Option.some(finalizedAt),
        });
        const invalidSignature = yield* HttpClient.post("/webhooks/wompi", {
          body: HttpBody.jsonUnsafe(
            signedWompiEvent(
              {
                id: provider.transactionId,
                reference: provider.reference,
                status: "APPROVED",
                amountInCents: Number(provider.amount) * 100,
                sourceId: Number(provider.sourceId),
                finalizedAt: Option.some(finalizedAt),
              },
              false
            )
          ),
        });
        expect(invalidSignature.status).toBe(401);
        const mismatchedAmount = yield* HttpClient.post("/webhooks/wompi", {
          body: HttpBody.jsonUnsafe(
            signedWompiEvent({
              id: provider.transactionId,
              reference: provider.reference,
              status: "APPROVED",
              amountInCents: Number(provider.amount) * 100 + 1,
              sourceId: Number(provider.sourceId),
              finalizedAt: Option.some(finalizedAt),
            })
          ),
        });
        expect(mismatchedAmount.status).toBe(400);
        const rejectedEvidenceState = yield* SqlSchema.findOne({
          Request: Schema.Struct({ id: Schema.String }),
          Result: Schema.Struct({
            status: Schema.String,
            paid: Schema.Boolean,
            observations: Schema.Int,
          }),
          execute: ({ id }) => sql`
            SELECT attempt.status, subscription.paid_pro_active AS paid,
              count(observation.id)::int AS observations
            FROM billing_attempts AS attempt
            INNER JOIN subscriptions AS subscription ON subscription.id = attempt.subscription_id
            LEFT JOIN wompi_billing_observations AS observation
              ON observation.billing_attempt_id = attempt.id
            WHERE attempt.id = ${id}
            GROUP BY attempt.status, subscription.paid_pro_active
          `,
        })({ id: firstPayment.billingAttempt.id }).pipe(Effect.orDie);
        expect(rejectedEvidenceState).toEqual({ status: "pending", paid: false, observations: 0 });
        yield* receiveWompiSettlement({
          payload: signedWompiEvent({
            id: provider.transactionId,
            reference: provider.reference,
            status: "DECLINED",
            amountInCents: Number(provider.amount) * 100,
            sourceId: Number(provider.sourceId),
            finalizedAt: Option.none(),
          }),
          observedAt: DateTime.makeUnsafe("2026-03-01T12:00:00Z"),
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, WompiEventConfig));
        const failedBeforeApproval = yield* SqlSchema.findOne({
          Request: Schema.Struct({ id: Schema.String }),
          Result: Schema.Struct({ status: Schema.String, paid: Schema.Boolean }),
          execute: ({ id }) => sql`
            SELECT attempt.status, subscription.paid_pro_active AS paid
            FROM billing_attempts AS attempt
            INNER JOIN subscriptions AS subscription ON subscription.id = attempt.subscription_id
            WHERE attempt.id = ${id}
          `,
        })({ id: firstPayment.billingAttempt.id }).pipe(Effect.orDie);
        expect(failedBeforeApproval).toEqual({ status: "failed", paid: false });
        yield* receiveWompiSettlement({
          payload: approvedEvent,
          observedAt: DateTime.makeUnsafe("2026-03-01T12:00:01Z"),
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, WompiEventConfig));
        yield* receiveWompiSettlement({
          payload: signedWompiEvent({
            id: provider.transactionId,
            reference: provider.reference,
            status: "DECLINED",
            amountInCents: Number(provider.amount) * 100,
            sourceId: Number(provider.sourceId),
            finalizedAt: Option.none(),
          }),
          observedAt: DateTime.makeUnsafe("2026-03-01T12:00:02Z"),
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, WompiEventConfig));
        yield* receiveWompiSettlement({
          payload: approvedEvent,
          observedAt: DateTime.makeUnsafe("2026-03-01T12:00:03Z"),
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, WompiEventConfig));
        const settled = yield* SqlSchema.findOne({
          Request: Schema.Struct({ id: Schema.String }),
          Result: Schema.Struct({
            status: Schema.String,
            paid: Schema.Boolean,
            periods: Schema.Int,
          }),
          execute: ({ id }) => sql`
            SELECT attempt.status, subscription.paid_pro_active AS paid,
              (SELECT COUNT(*)::int FROM paid_subscription_periods AS period
               WHERE period.billing_attempt_id = attempt.id) AS periods
            FROM billing_attempts AS attempt
            INNER JOIN subscriptions AS subscription ON subscription.id = attempt.subscription_id
            WHERE attempt.id = ${id}
          `,
        })({ id: firstPayment.billingAttempt.id }).pipe(Effect.orDie);
        expect(settled).toEqual({ status: "succeeded", paid: true, periods: 1 });

        yield* assertPublicationRollsBack({
          userId,
          enrollmentId: prepared.enrollmentId,
          priceId: firstPayment.billingAttempt.priceId,
        });

        const yearlyPrepare = HttpClientRequest.post(
          "/web/subscription/card-enrollments/prepare"
        ).pipe(
          HttpClientRequest.setHeaders({ origin: "https://fidyapp.com", cookie: sessionCookie }),
          HttpClientRequest.setBody(HttpBody.jsonUnsafe({ priceId: yearlyPriceId }))
        );
        const yearlyResponse = yield* HttpClient.execute(yearlyPrepare);
        const yearly = yield* Schema.decodeUnknownEffect(CardEnrollment)(
          yield* yearlyResponse.json
        );
        expect(yearly).toMatchObject({ status: "prepared", paymentSourceMode: "reuse" });
        if (yearly.status !== "prepared") return;
        const reuse = yield* HttpClient.post("/web/subscription/card-enrollments/submit", {
          headers: {
            origin: "https://fidyapp.com",
            cookie: sessionCookie,
            "content-type": "application/json",
          },
          body: HttpBody.jsonUnsafe({
            paymentSourceMode: "reuse",
            paymentRequestId: "22900000-0000-4000-8000-000000000002",
            enrollmentId: yearly.enrollmentId,
            billingEmail: "renewal@example.com",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
        });
        expect(yield* reuse.json).toMatchObject({
          status: "payment-pending",
          billingAttempt: { priceId: yearlyPriceId },
        });
        const observedAvailable = yield* HttpClient.execute(yearlyPrepare);
        expect(yield* observedAvailable.json).toMatchObject({
          enrollmentId: yearly.enrollmentId,
          status: "available",
        });

        const weeklyResponse = yield* HttpClient.post(
          "/web/subscription/card-enrollments/prepare",
          {
            headers: { origin: "https://fidyapp.com", cookie: sessionCookie },
            body: HttpBody.jsonUnsafe({ priceId: weeklyPriceId }),
          }
        );
        const weekly = yield* Schema.decodeUnknownEffect(CardEnrollment)(
          yield* weeklyResponse.json
        );
        if (weekly.status !== "prepared") return yield* Effect.die("weekly Price not prepared");
        const weeklyPayment = yield* HttpClient.post("/web/subscription/card-enrollments/submit", {
          headers: {
            origin: "https://fidyapp.com",
            cookie: sessionCookie,
            "content-type": "application/json",
          },
          body: HttpBody.jsonUnsafe({
            paymentSourceMode: "reuse",
            paymentRequestId: "22900000-0000-4000-8000-000000000003",
            enrollmentId: weekly.enrollmentId,
            billingEmail: "renewal@example.com",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
        });
        expect(yield* weeklyPayment.json).toMatchObject({
          status: "payment-pending",
          billingAttempt: {
            priceId: weeklyPriceId,
            money: { currency: "COP" },
            billingPeriod: "weekly",
          },
        });

        yield* assertEnrollmentLifecycleStatuses(yearly.enrollmentId);
        yield* assertBillingAttemptVisibilityBoundaries(firstPayment.billingAttempt.id);
      })
    );
  }
);
