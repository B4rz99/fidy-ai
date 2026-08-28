import { expect, layer } from "@effect/vitest";
import {
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import {
  EmailAddress,
  EmailVerificationCode,
  maximumEmailDeliveryGenerations,
} from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { withSubjectLock } from "~/shell/consent/repo";
import { MigrationSqlClient } from "~/shell/db/client";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { ApiHarness } from "~/shell/testing/api-harness";
import { BrowserPairingEmailDeliveryWorkerLive } from "./authentication-delivery-worker";
import { browserPairingEmailAuthentication } from "./pairing-authentication";
import { emailAuthenticationHmacKey, emailCredentialLookupKey } from "./admission";
import {
  purgeBrowserPairingEmailAdmissionEvidence,
  purgeOneExpiredBrowserPairingEmailWorkflow,
} from "./authentication-retention";
import { EmailDeliveryPort, type EmailDeliveryPortService } from "./delivery";

const processNextBackgroundStep = browserPairingEmailAuthentication.processNextBackgroundStep;
const countingEmailDelivery = (sends: Ref.Ref<number>): EmailDeliveryPortService =>
  EmailDeliveryPort.of({ send: () => Ref.update(sends, (count) => count + 1) });

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000326");
const bearer = TokenBearer.make("fin_login326_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const knownEmail = "login-326@example.com";
const otherUserId = UserId.make("f1d1a000-0000-4000-8000-000000000327");
const otherBearer = TokenBearer.make("fin_login327_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const otherEmail = "login-327@example.com";

const resetAuthentication = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM browser_pairing_email_start_requests`;
  yield* sql`DELETE FROM browser_pairing_email_workflows`;
  yield* sql`DELETE FROM email_pairing_login_admission_attempts`;
  yield* sql`DELETE FROM email_pairing_login_admission_scopes`;
  yield* sql`DELETE FROM email_delivery_admission_budgets`;
  yield* sql`DELETE FROM browser_login_start_attempts`;
  yield* sql`DELETE FROM browser_login_pairings`;
  yield* sql`DELETE FROM web_sessions WHERE user_id IN (${userId}, ${otherUserId})`;
  yield* seedConsentedPatIdentity({ userId, bearer });
  const lookupKey = yield* emailCredentialLookupKey(EmailAddress.make(knownEmail)).pipe(
    Effect.orDie
  );
  yield* sql`
    UPDATE verified_email_credentials SET email_address = ${knownEmail},
      verified_at = ${yield* DateTime.now} WHERE user_id = ${userId}
  `;
  yield* sql`
    INSERT INTO verified_email_credential_authentication_lookups (
      user_id, authentication_lookup_key
    ) VALUES (${userId}, ${lookupKey})
    ON CONFLICT (user_id) DO UPDATE
      SET authentication_lookup_key = EXCLUDED.authentication_lookup_key
  `;
});

const startPairing = Effect.gen(function* () {
  const response = yield* HttpClient.post("/web/pairings");
  return yield* Schema.decodeUnknownEffect(StartedBrowserLoginPairing)(yield* response.json);
});
const startBudgetPairing = Effect.gen(function* () {
  const pairing = yield* startPairing;
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM browser_login_start_attempts`;
  return pairing;
});
const clearEmailSourceAttempts = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    DELETE FROM email_pairing_login_admission_attempts attempt USING
      email_pairing_login_admission_scopes scope
    WHERE attempt.scope_key = scope.scope_key AND scope.scope_kind = 'source'
  `;
});

const completeEmail = (
  pairing: StartedBrowserLoginPairing,
  combinedCode: string,
  privateVerifier: string = Redacted.value(pairing.privateVerifier)
): ReturnType<typeof HttpClient.post> =>
  HttpClient.post("/web/email/authentication/complete", {
    headers: { origin: "https://fidyapp.com", "content-type": "application/json" },
    body: HttpBody.jsonUnsafe({ pairingId: pairing.pairingId, privateVerifier, combinedCode }),
  });

const deliverCode = Effect.gen(function* () {
  const deliveredCode = yield* Ref.make(Option.none<EmailVerificationCode>());
  expect(
    yield* processNextBackgroundStep().pipe(
      Effect.provideService(
        EmailDeliveryPort,
        EmailDeliveryPort.of({
          send: ({ combinedCode }) => Ref.set(deliveredCode, Option.some(combinedCode)),
        })
      )
    )
  ).toEqual({ _tag: "Progressed" });
  return Option.getOrThrow(yield* Ref.get(deliveredCode));
});

const requestCompletion = (): ReturnType<typeof HttpClient.post> =>
  HttpClient.post("/web/email/authentication/complete", {
    headers: {
      origin: "https://fidyapp.com",
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.203",
    },
    body: HttpBody.jsonUnsafe({
      pairingId: "f1d1a000-0000-4000-8000-000000000399",
      privateVerifier: "A".repeat(43),
      combinedCode: "ABCD-EFGH-JKLM-NPQR-STVW-XYZ2",
    }),
  });

const requestEmail = (
  pairing: StartedBrowserLoginPairing,
  email: string,
  sourceAddress = "198.51.100.249"
): ReturnType<typeof HttpClient.post> =>
  HttpClient.post("/web/email/authentication/start", {
    headers: {
      origin: "https://fidyapp.com",
      "content-type": "application/json",
      "x-forwarded-for": sourceAddress,
    },
    body: HttpBody.jsonUnsafe({
      pairingId: pairing.pairingId,
      privateVerifier: Redacted.value(pairing.privateVerifier),
      email,
    }),
  });

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "verified email browser-pairing authentication",
  (it) => {
    it.effect("gives known and unknown addresses the same pending start response", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const known = yield* requestEmail(yield* startPairing, knownEmail);
        const unknown = yield* requestEmail(yield* startPairing, "unknown-326@example.com");

        expect(known.status).toBe(202);
        expect(unknown.status).toBe(202);
        expect(known.headers["retry-after"]).toBe("60");
        expect(unknown.headers["retry-after"]).toBe("60");
        expect(yield* known.json).toEqual({ status: "pending", retryAfterSeconds: 60 });
        expect(yield* unknown.json).toEqual({ status: "pending", retryAfterSeconds: 60 });
        expect(known.headers["cache-control"]).toBe("no-store");
        expect(unknown.headers["cache-control"]).toBe("no-store");

        const sql = yield* MigrationSqlClient;
        expect(yield* sql`SELECT id FROM browser_pairing_email_workflows`).toEqual([]);
        expect(
          yield* sql`
            SELECT pairing_id, address_lookup_key FROM browser_pairing_email_start_requests
            ORDER BY requested_at, id
          `
        ).toHaveLength(2);
        expect(
          yield* sql`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'browser_pairing_email_start_requests'
              AND column_name IN ('email', 'email_address')
          `
        ).toEqual([]);
        expect(yield* sql`SELECT id FROM users WHERE id = ${userId}`).toHaveLength(1);
      })
    );

    it.effect("atomically enforces address, pairing, and source start budgets", () =>
      Effect.gen(function* () {
        const indexes = Array.from({ length: 6 }, (_, index) => index + 1);
        const sql = yield* MigrationSqlClient;

        yield* resetAuthentication;
        for (const index of indexes) {
          yield* requestEmail(
            yield* startBudgetPairing,
            "address-budget-326@example.com",
            `198.51.100.${index}`
          );
          yield* clearEmailSourceAttempts;
        }
        expect(yield* sql`SELECT id FROM browser_pairing_email_start_requests`).toHaveLength(5);

        yield* resetAuthentication;
        const pairing = yield* startPairing;
        for (const index of indexes) {
          yield* requestEmail(
            pairing,
            `pairing-budget-${index}-326@example.com`,
            `198.51.100.${index}`
          );
          yield* clearEmailSourceAttempts;
        }
        expect(yield* sql`SELECT id FROM browser_pairing_email_start_requests`).toHaveLength(5);

        yield* resetAuthentication;
        for (const index of indexes) {
          yield* requestEmail(
            yield* startBudgetPairing,
            `source-budget-${index}-326@example.com`,
            "198.51.100.200"
          );
        }
        expect(yield* sql`SELECT id FROM browser_pairing_email_start_requests`).toHaveLength(5);
      })
    );

    it.effect("bounds concurrent public starts without provider work", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const indexes = Array.from({ length: 8 }, (_, index) => index + 1);
        const pairings = yield* Effect.forEach(indexes, () => startBudgetPairing);
        const responses = yield* Effect.all(
          pairings.map((pairing, index) =>
            requestEmail(
              pairing,
              `concurrent-budget-${index + 1}-326@example.com`,
              "198.51.100.201"
            )
          ),
          { concurrency: "unbounded" }
        );
        expect(responses.every(({ status }) => status === 202)).toBe(true);
        const sql = yield* MigrationSqlClient;
        const requests = yield* sql`SELECT id FROM browser_pairing_email_start_requests`;
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.length).toBeLessThanOrEqual(5);
        const sends = yield* Ref.make(0);
        yield* Effect.forEach(indexes, () =>
          processNextBackgroundStep().pipe(
            Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
          )
        );
        expect(yield* Ref.get(sends)).toBe(0);
      })
    );

    it.effect("suppresses starts when global evidence lacks atomic capacity", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          INSERT INTO email_pairing_login_admission_scopes (scope_key, scope_kind, expires_at)
          SELECT encode(sha256(number::text::bytea), 'hex'), 'address', now() + interval '1 hour'
          FROM generate_series(1, 149999) number
        `;
        yield* requestEmail(yield* startPairing, knownEmail, "198.51.100.202");
        expect(yield* sql`SELECT id FROM browser_pairing_email_start_requests`).toEqual([]);
        expect(
          yield* sql`
            SELECT count(*)::int AS count FROM email_pairing_login_admission_scopes
          `
        ).toEqual([{ count: 149_999 }]);
      })
    );

    it.effect("never arms delivery after the BrowserLogin pairing becomes terminal", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        expect((yield* requestEmail(pairing, knownEmail)).status).toBe(202);
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_login_pairings SET lifecycle = 'expired', expired_at = now()
          WHERE id = ${pairing.pairingId}
        `;
        const sends = yield* Ref.make(0);
        expect(
          yield* processNextBackgroundStep().pipe(
            Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
          )
        ).toEqual({ _tag: "Progressed" });
        expect(yield* Ref.get(sends)).toBe(0);
      })
    );

    it.effect("rejects stale start work and delivery continuations before provider I/O", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        const sends = yield* Ref.make(0);

        yield* resetAuthentication;
        const expiredDeliveryPairing = yield* startPairing;
        yield* requestEmail(expiredDeliveryPairing, knownEmail);
        yield* processNextBackgroundStep().pipe(
          Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
        );
        yield* sql`
          UPDATE browser_pairing_email_delivery_intents SET status = 'pending'
        `;
        yield* sql`
          UPDATE browser_login_pairings SET lifecycle = 'expired', expired_at = now()
          WHERE id = ${expiredDeliveryPairing.pairingId}
        `;
        expect(
          yield* processNextBackgroundStep().pipe(
            Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
          )
        ).toEqual({ _tag: "Idle" });
        expect(yield* sql`SELECT status FROM browser_pairing_email_delivery_intents`).toEqual([
          { status: "rejected" },
        ]);

        yield* resetAuthentication;
        const staleDeliveryPairing = yield* startPairing;
        yield* requestEmail(staleDeliveryPairing, knownEmail);
        yield* processNextBackgroundStep().pipe(
          Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
        );
        yield* sql`
          UPDATE browser_pairing_email_delivery_intents SET status = 'pending'
        `;
        yield* sql`
          UPDATE verified_email_credentials SET verified_at = verified_at + interval '1 second'
          WHERE user_id = ${userId}
        `;
        expect(
          yield* processNextBackgroundStep().pipe(
            Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
          )
        ).toEqual({ _tag: "Idle" });
        expect(yield* sql`SELECT status FROM browser_pairing_email_delivery_intents`).toEqual([
          { status: "rejected" },
        ]);

        yield* resetAuthentication;
        const deliveryBudgetPairing = yield* startPairing;
        yield* requestEmail(deliveryBudgetPairing, knownEmail);
        const requesterBudgetKey = yield* emailAuthenticationHmacKey(`user:${userId}`).pipe(
          Effect.orDie
        );
        const recipientBudgetKey = yield* emailAuthenticationHmacKey(
          `recipient:${knownEmail}`
        ).pipe(Effect.orDie);
        yield* sql`
          INSERT INTO email_delivery_admission_budgets (scope_key, delivery_count, expires_at)
          VALUES
            (${requesterBudgetKey}, ${maximumEmailDeliveryGenerations}, now() + interval '1 hour'),
            (${recipientBudgetKey}, ${maximumEmailDeliveryGenerations}, now() + interval '1 hour')
          ON CONFLICT (scope_key) DO UPDATE SET
            delivery_count = EXCLUDED.delivery_count, expires_at = EXCLUDED.expires_at
        `;
        expect(
          yield* processNextBackgroundStep().pipe(
            Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
          )
        ).toEqual({ _tag: "Progressed" });
        expect(yield* sql`SELECT id FROM browser_pairing_email_workflows`).toEqual([]);
      })
    );

    it.effect("discards an immediate duplicate request before a second delivery", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        yield* requestEmail(pairing, knownEmail, "198.51.100.205");
        yield* requestEmail(pairing, knownEmail, "198.51.100.206");
        const sends = yield* Ref.make(0);
        expect(
          yield* processNextBackgroundStep().pipe(
            Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
          )
        ).toEqual({ _tag: "Progressed" });
        expect(
          yield* processNextBackgroundStep().pipe(
            Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
          )
        ).toEqual({ _tag: "Progressed" });
        expect(yield* Ref.get(sends)).toBe(1);
      })
    );

    it.effect("rejects completion when the delivery proof is no longer armed", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        yield* requestEmail(pairing, knownEmail);
        const combinedCode = yield* deliverCode;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_pairing_email_workflows SET proof_digest = NULL, proof_expires_at = NULL
        `;
        expect((yield* completeEmail(pairing, combinedCode)).status).toBe(400);
        expect(
          yield* sql`SELECT lifecycle FROM browser_login_pairings WHERE id = ${pairing.pairingId}`
        ).toEqual([{ lifecycle: "pending_approval" }]);
      })
    );

    it.effect("rejects completion when transaction capacity or owner admission is exhausted", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const capacityPairing = yield* startPairing;
        yield* requestEmail(capacityPairing, knownEmail);
        const capacityCode = yield* deliverCode;
        const sql = yield* MigrationSqlClient;
        const slotsLocked = yield* Deferred.make<void>();
        const releaseSlots = yield* Deferred.make<void>();
        const slotHolder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT slot FROM email_verification_admission_slots FOR UPDATE`;
              yield* Deferred.succeed(slotsLocked, undefined);
              yield* Deferred.await(releaseSlots);
            })
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(slotsLocked);
        expect((yield* completeEmail(capacityPairing, capacityCode)).status).toBe(400);
        yield* Deferred.succeed(releaseSlots, undefined);
        yield* Fiber.join(slotHolder);

        yield* resetAuthentication;
        const ownerPairing = yield* startPairing;
        yield* requestEmail(ownerPairing, knownEmail);
        const ownerCode = yield* deliverCode;
        const wrongCode = `${ownerCode.slice(0, 10)}BCDF-GHJK-MNPQ-RSTW`;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const response = yield* HttpClient.post("/web/email/authentication/complete", {
            headers: {
              origin: "https://fidyapp.com",
              "content-type": "application/json",
              "x-forwarded-for": `198.51.100.${210 + attempt}`,
            },
            body: HttpBody.jsonUnsafe({
              pairingId: ownerPairing.pairingId,
              privateVerifier: Redacted.value(ownerPairing.privateVerifier),
              combinedCode: wrongCode,
            }),
          });
          expect(response.status).toBe(400);
          yield* sql`
            DELETE FROM email_pairing_login_admission_attempts attempt USING
              email_pairing_login_admission_scopes scope
            WHERE attempt.scope_key = scope.scope_key
              AND (
                scope.scope_kind IN ('pairing', 'source')
                OR (scope.scope_kind = 'address' AND scope.expires_at < now() + interval '1 hour')
              )
          `;
          yield* sql`
            UPDATE browser_pairing_email_workflows SET wrong_proof_attempts = 0
          `;
        }
        expect(
          yield* sql`
            SELECT count(*)::int AS count FROM email_pairing_login_admission_attempts attempt
            JOIN email_pairing_login_admission_scopes scope ON scope.scope_key = attempt.scope_key
            WHERE scope.scope_kind = 'address'
          `
        ).toEqual([{ count: 6 }]);
      })
    );

    it.effect("rejects completion if its workflow disappears while waiting for the User lock", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        yield* requestEmail(pairing, knownEmail);
        const combinedCode = yield* deliverCode;
        const sql = yield* MigrationSqlClient;
        const lockAcquired = yield* Deferred.make<void>();
        const releaseLock = yield* Deferred.make<void>();
        const lockHolder = yield* withUserTransaction(
          userId,
          withSubjectLock(
            userId,
            Effect.gen(function* () {
              yield* Deferred.succeed(lockAcquired, undefined);
              yield* Deferred.await(releaseLock);
            })
          )
        ).pipe(Effect.forkChild);
        yield* Deferred.await(lockAcquired);
        const completion = yield* completeEmail(pairing, combinedCode).pipe(Effect.forkChild);
        for (let poll = 0; poll < 100; poll += 1) {
          const attempts = yield* sql`
            SELECT count(*)::int AS count FROM email_pairing_login_admission_attempts attempt
            JOIN email_pairing_login_admission_scopes scope ON scope.scope_key = attempt.scope_key
            WHERE scope.scope_kind = 'address'
          `;
          if (attempts[0]?.count === 3) break;
          yield* Effect.sleep("10 millis");
        }
        yield* sql`DELETE FROM browser_pairing_email_workflows`;
        yield* Deferred.succeed(releaseLock, undefined);
        yield* Fiber.join(lockHolder);
        expect((yield* Fiber.join(completion)).status).toBe(400);
      })
    );

    it.effect("launches the delivery loop only in a production runtime", () =>
      Effect.gen(function* () {
        const delivery = Layer.succeed(
          EmailDeliveryPort,
          EmailDeliveryPort.of({ send: () => Effect.void })
        );
        yield* Effect.scoped(
          Layer.build(BrowserPairingEmailDeliveryWorkerLive.pipe(Layer.provide(delivery)))
        );
        yield* Effect.scoped(
          Layer.build(
            BrowserPairingEmailDeliveryWorkerLive.pipe(
              Layer.provide(delivery),
              Layer.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown({ NODE_ENV: "production" }))
              )
            )
          )
        );
      }).pipe(Effect.asVoid)
    );

    it.effect("keeps malformed direct requests inside generic closed outcomes", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        expect(
          yield* browserPairingEmailAuthentication.requestCode({
            pairingId: pairing.pairingId,
            privateVerifier: Redacted.value(pairing.privateVerifier),
            email: { malformed: true },
            sourceAddress: "198.51.100.204",
          })
        ).toEqual({ status: "pending", retryAfterSeconds: 60 });
        expect(
          yield* browserPairingEmailAuthentication.submitCode({
            pairingId: "not-a-pairing-id",
            privateVerifier: Redacted.value(pairing.privateVerifier),
            combinedCode: Redacted.make(
              EmailVerificationCode.make("ABCD-EFGH-JKLM-NPQR-STVW-XYZ2")
            ),
            sourceAddress: "198.51.100.204",
          })
        ).toBe(false);
        const sql = yield* MigrationSqlClient;
        expect(yield* sql`SELECT id FROM browser_pairing_email_start_requests`).toEqual([]);
      })
    );

    it.effect("enforces the raw protocol and refuses invalid browser proof generically", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        const request = (
          headers: Record<string, string>,
          body: unknown
        ): ReturnType<typeof HttpClient.post> =>
          HttpClient.post("/web/email/authentication/start", {
            headers,
            body: HttpBody.text(JSON.stringify(body), headers["content-type"]),
          });
        const wrongOrigin = yield* request(
          { origin: "https://example.com", "content-type": "application/json" },
          { email: knownEmail }
        );
        const wrongMedia = yield* request(
          { origin: "https://fidyapp.com", "content-type": "text/plain" },
          { email: knownEmail }
        );
        const excess = yield* request(
          { origin: "https://fidyapp.com", "content-type": "application/json" },
          {
            pairingId: pairing.pairingId,
            privateVerifier: Redacted.value(pairing.privateVerifier),
            email: knownEmail,
            extra: true,
          }
        );
        const wrongVerifier = yield* request(
          { origin: "https://fidyapp.com", "content-type": "application/json" },
          {
            pairingId: pairing.pairingId,
            privateVerifier: "A".repeat(43),
            email: knownEmail,
          }
        );

        expect(wrongOrigin.status).toBe(403);
        expect(wrongMedia.status).toBe(415);
        expect(excess.status).toBe(400);
        expect(wrongVerifier.status).toBe(400);
        expect(yield* wrongOrigin.json).toEqual(yield* wrongMedia.json);
        expect(yield* wrongMedia.json).toEqual(yield* excess.json);
        expect(yield* wrongVerifier.json).toEqual({
          error: {
            code: "pairing_invalid",
            message: "Esta vinculación ya no es válida. Inicia de nuevo.",
          },
        });
        for (const response of [wrongOrigin, wrongMedia, excess, wrongVerifier]) {
          expect(response.headers["cache-control"]).toBe("no-store");
        }
        const sql = yield* MigrationSqlClient;
        expect(yield* sql`SELECT id FROM browser_pairing_email_start_requests`).toEqual([]);
        expect(yield* sql`SELECT id FROM browser_pairing_email_workflows`).toEqual([]);
        expect(yield* sql`SELECT id FROM browser_pairing_email_delivery_intents`).toEqual([]);
        const sends = yield* Ref.make(0);
        expect(
          yield* processNextBackgroundStep().pipe(
            Effect.provideService(EmailDeliveryPort, countingEmailDelivery(sends))
          )
        ).toEqual({ _tag: "Idle" });
        expect(yield* Ref.get(sends)).toBe(0);
      })
    );

    it.effect("durably source-bounds sequential and concurrent completion traffic", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        const attempts = Array.from({ length: 8 }, () => requestCompletion());

        yield* resetAuthentication;
        const sequential = yield* Effect.all(attempts, { concurrency: 1 });
        expect(sequential.every(({ status }) => status === 400)).toBe(true);
        expect(
          yield* sql`
            SELECT attempt.attempted_at FROM email_pairing_login_admission_attempts attempt
            JOIN email_pairing_login_admission_scopes scope
              ON scope.scope_key = attempt.scope_key
            WHERE scope.scope_kind = 'source'
          `
        ).toHaveLength(5);
        expect(yield* sql`SELECT id FROM browser_pairing_email_workflows`).toEqual([]);
        expect(yield* sql`SELECT id FROM web_sessions WHERE user_id = ${userId}`).toEqual([]);

        yield* resetAuthentication;
        yield* Effect.all(attempts, { concurrency: "unbounded" });
        const concurrentEvidence = yield* sql`
          SELECT attempt.attempted_at FROM email_pairing_login_admission_attempts attempt
          JOIN email_pairing_login_admission_scopes scope
            ON scope.scope_key = attempt.scope_key
          WHERE scope.scope_kind = 'source'
        `;
        expect(concurrentEvidence.length).toBeGreaterThan(0);
        expect(concurrentEvidence.length).toBeLessThanOrEqual(5);
        expect(yield* sql`SELECT id FROM browser_pairing_email_workflows`).toEqual([]);
        expect(yield* sql`SELECT id FROM web_sessions WHERE user_id = ${userId}`).toEqual([]);
      })
    );

    it.effect("resends only through the same bounded request interface", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        expect((yield* requestEmail(pairing, knownEmail)).status).toBe(202);
        const firstCode = yield* deliverCode;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_pairing_email_workflows SET resend_available_at = now() - interval '1 second'
          WHERE pairing_id = ${pairing.pairingId}
        `;
        expect((yield* requestEmail(pairing, knownEmail)).status).toBe(202);
        const replacementCode = yield* deliverCode;
        expect(replacementCode).not.toBe(firstCode);
        expect((yield* completeEmail(pairing, firstCode)).status).toBe(400);
        expect((yield* completeEmail(pairing, replacementCode)).status).toBe(200);
      })
    );

    it.effect("refuses a stale credential revision without approving or creating a session", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        expect((yield* requestEmail(pairing, knownEmail)).status).toBe(202);
        const combinedCode = yield* deliverCode;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE verified_email_credentials SET verified_at = verified_at + interval '1 second'
          WHERE user_id = ${userId}
        `;
        expect((yield* completeEmail(pairing, combinedCode)).status).toBe(400);
        expect(
          yield* sql`SELECT lifecycle, user_id FROM browser_login_pairings WHERE id = ${pairing.pairingId}`
        ).toEqual([{ lifecycle: "pending_approval", user_id: null }]);
        expect(yield* sql`SELECT id FROM browser_pairing_email_workflows`).toEqual([]);
        expect(yield* sql`SELECT id FROM web_sessions WHERE user_id = ${userId}`).toEqual([]);
      })
    );

    it.effect("refuses an expired mailbox proof without approving or creating a session", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        expect((yield* requestEmail(pairing, knownEmail)).status).toBe(202);
        const combinedCode = yield* deliverCode;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_pairing_email_workflows SET proof_expires_at = now() - interval '1 second'
          WHERE pairing_id = ${pairing.pairingId}
        `;
        expect((yield* completeEmail(pairing, combinedCode)).status).toBe(400);
        expect(
          yield* sql`SELECT lifecycle, user_id FROM browser_login_pairings WHERE id = ${pairing.pairingId}`
        ).toEqual([{ lifecycle: "pending_approval", user_id: null }]);
        expect(yield* sql`SELECT id FROM web_sessions WHERE user_id = ${userId}`).toEqual([]);
      })
    );

    it.effect("domain-separates mailbox proof digests by purpose and pairing", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const firstPairing = yield* startPairing;
        yield* requestEmail(firstPairing, knownEmail);
        const firstCode = yield* deliverCode;
        const secondPairing = yield* startPairing;
        yield* requestEmail(secondPairing, knownEmail);
        yield* deliverCode;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_pairing_email_workflows target SET
            public_code = source.public_code, proof_digest = source.proof_digest,
            proof_expires_at = source.proof_expires_at
          FROM browser_pairing_email_workflows source
          WHERE target.pairing_id = ${secondPairing.pairingId}
            AND source.pairing_id = ${firstPairing.pairingId}
        `;
        expect((yield* completeEmail(secondPairing, firstCode)).status).toBe(400);
        expect(
          yield* sql`
            SELECT wrong_proof_attempts FROM browser_pairing_email_workflows
            WHERE pairing_id = ${secondPairing.pairingId}
          `
        ).toEqual([{ wrong_proof_attempts: 1 }]);
        expect(
          yield* sql`
            SELECT lifecycle, user_id FROM browser_login_pairings
            WHERE id = ${secondPairing.pairingId}
          `
        ).toEqual([{ lifecycle: "pending_approval", user_id: null }]);
      })
    );

    it.effect(
      "binds completion to both proofs and remains atomic under replay and concurrency",
      () =>
        Effect.gen(function* () {
          yield* resetAuthentication;
          yield* seedConsentedPatIdentity({ userId: otherUserId, bearer: otherBearer });
          const sql = yield* MigrationSqlClient;
          yield* sql`
            UPDATE verified_email_credentials
            SET email_address = ${otherEmail}, verified_at = ${yield* DateTime.now}
            WHERE user_id = ${otherUserId}
          `;
          yield* sql`
            INSERT INTO verified_email_credential_authentication_lookups (
              user_id, authentication_lookup_key
            ) VALUES (
              ${otherUserId},
              ${yield* emailCredentialLookupKey(EmailAddress.make(otherEmail)).pipe(Effect.orDie)}
            ) ON CONFLICT (user_id) DO UPDATE
              SET authentication_lookup_key = EXCLUDED.authentication_lookup_key
          `;

          const pairing = yield* startPairing;
          expect((yield* requestEmail(pairing, knownEmail)).status).toBe(202);
          const combinedCode = yield* deliverCode;
          const otherPairing = yield* startPairing;
          expect((yield* requestEmail(otherPairing, otherEmail)).status).toBe(202);
          const otherCode = yield* deliverCode;

          expect((yield* completeEmail(pairing, otherCode)).status).toBe(400);
          expect((yield* completeEmail(pairing, combinedCode, "A".repeat(43))).status).toBe(400);
          expect(
            (yield* completeEmail(otherPairing, otherCode, Redacted.value(pairing.privateVerifier)))
              .status
          ).toBe(400);
          expect(
            yield* sql`
            SELECT wrong_proof_attempts FROM browser_pairing_email_workflows
            WHERE pairing_id = ${otherPairing.pairingId}
          `
          ).toEqual([{ wrong_proof_attempts: 0 }]);
          expect(
            yield* sql`SELECT id FROM web_sessions WHERE user_id IN (${userId}, ${otherUserId})`
          ).toEqual([]);
          yield* sql`DELETE FROM email_pairing_login_admission_attempts`;
          yield* sql`DELETE FROM email_pairing_login_admission_scopes`;
          const wrongPublicAttempts = yield* Effect.forEach(
            Array.from({ length: 5 }),
            () => completeEmail(otherPairing, combinedCode),
            { concurrency: 1 }
          );
          expect(wrongPublicAttempts.map(({ status }) => status)).toEqual([
            400, 400, 400, 400, 400,
          ]);
          expect(
            yield* sql`
              SELECT id FROM browser_pairing_email_workflows
              WHERE pairing_id = ${otherPairing.pairingId}
            `
          ).toEqual([]);

          expect(
            yield* sql`
              SELECT scope.scope_kind, count(*)::int AS count
              FROM email_pairing_login_admission_attempts attempt
              JOIN email_pairing_login_admission_scopes scope
                ON scope.scope_key = attempt.scope_key
              GROUP BY scope.scope_kind ORDER BY scope.scope_kind
            `
          ).toEqual([
            { scope_kind: "address", count: 10 },
            { scope_kind: "pairing", count: 5 },
            { scope_kind: "source", count: 5 },
          ]);
          yield* sql`DELETE FROM email_pairing_login_admission_attempts`;
          yield* sql`DELETE FROM email_pairing_login_admission_scopes`;
          const concurrent = yield* Effect.all(
            [completeEmail(pairing, combinedCode), completeEmail(pairing, combinedCode)],
            { concurrency: "unbounded" }
          );
          expect(
            concurrent.map(({ status }) => status).sort((left, right) => left - right)
          ).toEqual([200, 400]);
          expect((yield* completeEmail(pairing, combinedCode)).status).toBe(400);
          expect(
            yield* sql`SELECT lifecycle, user_id FROM browser_login_pairings WHERE id = ${pairing.pairingId}`
          ).toEqual([{ lifecycle: "ready", user_id: userId }]);
          expect(
            yield* sql`SELECT lifecycle, user_id FROM browser_login_pairings WHERE id = ${otherPairing.pairingId}`
          ).toEqual([{ lifecycle: "pending_approval", user_id: null }]);
          expect(
            yield* sql`SELECT id FROM web_sessions WHERE user_id IN (${userId}, ${otherUserId})`
          ).toEqual([]);
        })
    );

    it.effect("retains expired workflows and admission evidence through bounded gateways", () =>
      Effect.gen(function* () {
        yield* resetAuthentication;
        const pairing = yield* startPairing;
        yield* requestEmail(pairing, knownEmail);
        yield* processNextBackgroundStep().pipe(
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({ send: () => Effect.void })
          )
        );
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE browser_pairing_email_workflows SET started_at = now() - interval '2 hours',
            expires_at = now() - interval '1 hour', resend_available_at = now() - interval '1 hour',
            proof_digest = NULL, proof_expires_at = NULL
        `;
        yield* sql`
          INSERT INTO email_pairing_login_admission_scopes (scope_key, scope_kind, expires_at)
          VALUES (${"f".repeat(64)}, 'source', now() - interval '1 second')
          ON CONFLICT (scope_key) DO UPDATE SET expires_at = EXCLUDED.expires_at
        `;

        expect(yield* purgeOneExpiredBrowserPairingEmailWorkflow()).toBe(true);
        expect(yield* purgeOneExpiredBrowserPairingEmailWorkflow()).toBe(false);
        yield* purgeBrowserPairingEmailAdmissionEvidence();
        expect(yield* sql`SELECT id FROM browser_pairing_email_workflows`).toEqual([]);
        expect(
          yield* sql`
            SELECT scope_key FROM email_pairing_login_admission_scopes
            WHERE scope_key = ${"f".repeat(64)}
          `
        ).toEqual([]);
      })
    );

    it.effect(
      "authenticates after Consent revocation while canonical work requires User action",
      () =>
        Effect.gen(function* () {
          yield* resetAuthentication;
          const sql = yield* MigrationSqlClient;
          const usersBeforeAuthentication = yield* sql`SELECT count(*)::int AS count FROM users`;
          const transactionsBeforeAuthentication =
            yield* sql`SELECT * FROM transactions ORDER BY id`;
          yield* sql`
          INSERT INTO consent_records (
            id, subject_user_id, event_type, revoked_grant_id, service_market, locale,
            disclosure_revision, disclosure_sha256, disclosure_text, policy_url,
            policy_revision, policy_sha256, purposes, data_categories, duration,
            revocation_method, decision_origin, disclosure_channel, disclosure_provider,
            disclosure_provider_message_id, decision_channel, decision_provider,
            decision_provider_message_id, occurred_at
          ) SELECT
            'f1d1a000-0000-4000-8000-000000000328', subject_user_id, 'revoked', id,
            service_market, locale, disclosure_revision, disclosure_sha256, disclosure_text,
            policy_url, policy_revision, policy_sha256, purposes, data_categories, duration,
            revocation_method, 'provider-qualified-messages', disclosure_channel,
            disclosure_provider, disclosure_provider_message_id, decision_channel,
            decision_provider, 'email-login-consent-revocation-326', now()
          FROM consent_records WHERE subject_user_id = ${userId} AND event_type = 'granted'
            AND grant_type = 'onboarding' ORDER BY occurred_at DESC LIMIT 1
        `;
          const pairing = yield* startPairing;
          expect((yield* requestEmail(pairing, knownEmail)).status).toBe(202);

          const deliveredCode = yield* Ref.make(Option.none<EmailVerificationCode>());
          expect(
            yield* processNextBackgroundStep().pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({
                  send: ({ combinedCode, purpose }) =>
                    Effect.gen(function* () {
                      expect(purpose).toBe("browser-pairing-approval");
                      yield* Ref.set(deliveredCode, Option.some(combinedCode));
                    }),
                })
              )
            )
          ).toEqual({ _tag: "Progressed" });
          const combinedCode = Option.getOrThrow(yield* Ref.get(deliveredCode));

          const completed = yield* HttpClient.post("/web/email/authentication/complete", {
            headers: { origin: "https://fidyapp.com", "content-type": "application/json" },
            body: HttpBody.jsonUnsafe({
              pairingId: pairing.pairingId,
              privateVerifier: Redacted.value(pairing.privateVerifier),
              combinedCode,
            }),
          });
          expect(completed.status).toBe(200);
          expect(yield* completed.json).toEqual({ status: "pairing_approved" });

          yield* sql`
          UPDATE browser_login_pairings SET last_accepted_poll_at = now() - interval '5 seconds'
          WHERE id = ${pairing.pairingId}
        `;
          const redeemed = yield* HttpClient.post("/web/pairings/redeem", {
            body: HttpBody.jsonUnsafe({
              pairingId: pairing.pairingId,
              privateVerifier: Redacted.value(pairing.privateVerifier),
            }),
          });
          expect(redeemed.status).toBe(200);
          expect(yield* redeemed.json).toMatchObject({ status: "authenticated" });
          const sessionCookie = redeemed.headers["set-cookie"]?.split(";", 1)[0];
          expect(sessionCookie).toBeDefined();
          const canonical = yield* HttpClient.get("/transactions", {
            headers: { cookie: Option.getOrThrow(Option.fromNullishOr(sessionCookie)) },
          });
          expect(canonical.status).toBe(403);
          expect(yield* canonical.json).toMatchObject({ error: { code: "user_action_required" } });

          expect(
            yield* sql`SELECT user_id FROM web_sessions WHERE user_id = ${userId}`
          ).toHaveLength(1);
          expect(yield* sql`SELECT id FROM browser_pairing_email_workflows`).toEqual([]);
          expect(yield* sql`SELECT count(*)::int AS count FROM users`).toEqual(
            usersBeforeAuthentication
          );
          expect(yield* sql`SELECT * FROM transactions ORDER BY id`).toEqual(
            transactionsBeforeAuthentication
          );
        })
    );
  }
);
