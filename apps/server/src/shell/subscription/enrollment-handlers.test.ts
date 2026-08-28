import { expect, layer } from "@effect/vitest";
import { Crypto, DateTime, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ConsentRecordId } from "~/core/consent/model";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { WebSessionId } from "~/core/web-session/reference";
import { calculateWebSessionDeadlines } from "~/core/web-session/rules";
import { MigrationSqlClient } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { withSubjectLock } from "~/shell/consent/repo";
import { ApiHarness } from "~/shell/testing/api-harness";
import { revokeCurrentOnboardingConsentForTesting } from "~/shell/testing/consent";
import { CardEnrollment, WompiSourceId } from "~/core/subscription/enrollment-model";
import { reconcileCardEnrollment } from "./card-enrollment";

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
const monthlyPriceId = "22700000-0000-4000-8000-000000000002";
const yearlyPriceId = "22700000-0000-4000-8000-000000000003";

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
    yield* Effect.yieldNow;
  }
  return yield* Effect.die("advisory-lock waiter did not arrive");
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
          body: HttpBody.jsonUnsafe({ paymentSourceMode: "create", unexpected: true }),
        });
        expect(invalidSubmit.status).toBe(400);
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
        expect(yield* expired.json).toMatchObject({ status: "expired" });
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
          ["tok_test_ambiguous", "verifying"],
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
          if (expectedStatus === "verifying") {
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
        expect(yield* first.json).toMatchObject({ status: "available" });
        expect(yield* replay.json).toMatchObject({ status: "available" });

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
            enrollmentId: yearly.enrollmentId,
            billingEmail: "renewal@example.com",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
        });
        expect(yield* reuse.json).toMatchObject({ status: "available", priceId: yearlyPriceId });
        const observedAvailable = yield* HttpClient.execute(yearlyPrepare);
        expect(yield* observedAvailable.json).toMatchObject({
          enrollmentId: yearly.enrollmentId,
          status: "available",
        });

        const sql = yield* MigrationSqlClient;
        for (const status of ["creating", "verifying"] as const) {
          yield* sql`
            UPDATE card_enrollments SET status = ${status}, payment_source_id = NULL
            WHERE id = ${yearly.enrollmentId} AND user_id = ${userId}
          `;
          const observed = yield* HttpClient.get(
            `/web/subscription/card-enrollments/${yearly.enrollmentId}`,
            { headers: { origin: "https://fidyapp.com", cookie: sessionCookie } }
          );
          expect(yield* observed.json).toMatchObject({ status });
        }
      })
    );
  }
);
