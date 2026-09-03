import { expect, layer } from "@effect/vitest";
import type { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import { EmailDeliveryIntentId } from "~/core/email-authentication/model";
import { Crypto, DateTime, Effect, Exit, Option, Redacted, Ref, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { PersistedQueue } from "effect/unstable/persistence";
import { SqlClient } from "effect/unstable/sql";
import { E164PhoneNumber } from "~/core/identity/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import { EmailDeliveryPort, EmailSendFailed } from "~/shell/email-authentication/delivery";
import {
  armOnboardingEmailDelivery,
  findEmailEnrollmentByCaller,
} from "~/shell/email-authentication/repo";
import {
  deliverOneOnboardingEmailForTesting,
  publishOnboardingEmailDelivery,
} from "./delivery-workflow";
import { type OnboardingTurn, handleOnboardingTurn } from "./onboarding";
import { ApiHarness } from "~/shell/testing/api-harness";
import { deliverConsentDisclosureForTesting } from "~/shell/testing/consent-disclosure";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { DisabledTelemetryResource } from "~/shell/observability/disabled";
import {
  type DeclaredOutcome,
  TelemetrySpanId,
  TelemetryTraceId,
} from "~/shell/observability/protocol";
import { Telemetry, makeTelemetryService } from "~/shell/observability/telemetry";
import { CreatedVerifiedOnboarding } from "~/web-auth-api";

const testTelemetry = makeTelemetryService(DisabledTelemetryResource.adapter);
const phone = E164PhoneNumber.make("+573009993324");
const caller = testWhatsAppCaller(phone);
const message = (providerMessageId: string): ProviderMessageEvidence => ({
  channel: "whatsapp",
  provider: "kapso",
  providerMessageId,
});
const turnFor =
  (targetCaller: typeof caller) =>
  (text: string, providerMessageId: string, receivedAt: DateTime.Utc): OnboardingTurn => ({
    caller: targetCaller,
    content: { _tag: "Text" as const, text },
    message: message(providerMessageId),
    receivedAt,
  });
const turn = turnFor(caller);

const cleanupCaller = Effect.fn("testCleanupOnboardingCaller")(function* (
  targetCaller: typeof caller
) {
  const sql = yield* MigrationSqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM email_delivery_admission_budgets`;
      yield* sql`
        DELETE FROM consent_records WHERE subject_user_id IN (
          SELECT user_id FROM whatsapp_identities
          WHERE business_portfolio_id = ${targetCaller.businessPortfolioId}
            AND business_scoped_user_id = ${targetCaller.businessScopedUserId}
        )
      `;
      yield* sql`
        DELETE FROM users WHERE id IN (
          SELECT user_id FROM whatsapp_identities
          WHERE business_portfolio_id = ${targetCaller.businessPortfolioId}
            AND business_scoped_user_id = ${targetCaller.businessScopedUserId}
        )
      `;
      const [queueTable] = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ available: Schema.Boolean }))
      )(yield* sql`SELECT to_regclass('fidy_durable.fidy_queue') IS NOT NULL AS available`);
      if (queueTable?.available === true) {
        yield* sql`
          DELETE FROM fidy_durable.fidy_queue
          WHERE queue_name = 'onboarding-email-delivery' AND id::uuid IN (
            SELECT intent.id FROM email_delivery_intents AS intent
            JOIN email_enrollments AS enrollment ON enrollment.id = intent.enrollment_id
            WHERE enrollment.business_portfolio_id = ${targetCaller.businessPortfolioId}
              AND enrollment.business_scoped_user_id = ${targetCaller.businessScopedUserId}
          )
        `;
      }
      yield* sql`
        DELETE FROM email_enrollments
        WHERE business_portfolio_id = ${targetCaller.businessPortfolioId}
          AND business_scoped_user_id = ${targetCaller.businessScopedUserId}
      `;
      yield* sql`
        DELETE FROM pending_consent_exchanges
        WHERE business_portfolio_id = ${targetCaller.businessPortfolioId}
          AND business_scoped_user_id = ${targetCaller.businessScopedUserId}
      `;
    })
  );
});
const cleanup = cleanupCaller(caller);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "verified email onboarding",
  (it) => {
    it.effect("publishes onboarding delivery transactionally and converges duplicates in SQL", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const crypto = yield* Crypto.Crypto;
        const intentId = EmailDeliveryIntentId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));

        yield* sql
          .withTransaction(
            publishOnboardingEmailDelivery(intentId).pipe(
              Effect.andThen(Effect.fail("rollback" as const))
            )
          )
          .pipe(Effect.flip);
        expect(
          yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Finite })))(
            yield* sql`SELECT count(*)::int AS count FROM fidy_queue
              WHERE queue_name = 'onboarding-email-delivery' AND id = ${intentId}`
          )
        ).toEqual([{ count: 0 }]);

        yield* publishOnboardingEmailDelivery(intentId);
        yield* publishOnboardingEmailDelivery(intentId);
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ count: Schema.Finite, maximumPayloadBytes: Schema.Finite }))
        )(
          yield* sql`SELECT count(*)::int AS count,
              max(octet_length(element))::int AS "maximumPayloadBytes"
            FROM fidy_queue
            WHERE queue_name = 'onboarding-email-delivery' AND id = ${intentId}`
        );
        expect(rows[0]?.count).toBe(1);
        expect(rows[0]?.maximumPayloadBytes).toBeLessThanOrEqual(128);
        yield* sql`
          DELETE FROM fidy_queue
          WHERE queue_name = 'onboarding-email-delivery' AND id = ${intentId}
        `;
      })
    );

    it.effect("creates every stable owner result atomically and discloses recovery once", () =>
      Effect.gen(function* () {
        yield* cleanup;
        const acceptedAt = yield* DateTime.now;
        const disclosure = yield* handleOnboardingTurn(
          turn("Quiero empezar", "wamid.email-start", acceptedAt)
        );
        expect(disclosure._tag).toBe("SendDisclosure");
        if (disclosure._tag !== "SendDisclosure") return;
        yield* deliverConsentDisclosureForTesting({
          exchangeId: disclosure.exchangeId,
          message: message("wamid.email-disclosure"),
          deliveredAt: DateTime.add(acceptedAt, { seconds: 1 }),
        });

        const accepted = yield* handleOnboardingTurn(
          turn("Acepto", "wamid.email-accept", DateTime.add(acceptedAt, { seconds: 2 }))
        );
        expect(accepted._tag).toBe("AwaitingEmail");
        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`
          SELECT count(*)::int AS count FROM users AS users
          JOIN whatsapp_identities AS identity ON identity.user_id = users.id
          WHERE identity.business_portfolio_id = ${caller.businessPortfolioId}
            AND identity.business_scoped_user_id = ${caller.businessScopedUserId}
        `
        ).toEqual([{ count: 0 }]);

        expect(Option.isSome(yield* findEmailEnrollmentByCaller(caller))).toBe(true);
        const malformed = yield* HttpClient.post("/web/onboarding/email/verify", {
          headers: { origin: "https://fidyapp.com" },
          body: HttpBody.jsonUnsafe({ combinedCode: "not-a-verification-code" }),
        });
        expect(malformed.status).toBe(400);
        const oversized = yield* HttpClient.post("/web/onboarding/email/verify", {
          headers: { origin: "https://fidyapp.com" },
          body: HttpBody.jsonUnsafe({ combinedCode: "A".repeat(30) }),
        });
        expect(oversized.status).toBe(400);
        expect(yield* oversized.json).toEqual(yield* malformed.json);
        const publicCodeRows = yield* sql`
          SELECT public_code FROM email_enrollments
          WHERE business_scoped_user_id = ${caller.businessScopedUserId}
        `;
        const publicCode = (yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ public_code: Schema.String }))
        )(publicCodeRows))[0]?.public_code;
        if (publicCode === undefined) return yield* Effect.die("missing enrollment public code");
        const beforeEmail = yield* HttpClient.post("/web/onboarding/email/verify", {
          headers: { origin: "https://fidyapp.com" },
          body: HttpBody.jsonUnsafe({ combinedCode: `${publicCode}-AAAA-AAAA-AAAA-AAAA` }),
        });
        expect(beforeEmail.status).toBe(400);

        const submitted = yield* handleOnboardingTurn(
          turn(
            "  PERSON.Name+Fidy@Example.COM ",
            "wamid.email-address",
            DateTime.add(acceptedAt, { seconds: 3 })
          )
        );
        expect(submitted._tag).toBe("EmailSubmitted");
        const beforeProof = yield* HttpClient.post("/web/onboarding/email/verify", {
          headers: { origin: "https://fidyapp.com" },
          body: HttpBody.jsonUnsafe({ combinedCode: `${publicCode}-AAAA-AAAA-AAAA-AAAA` }),
        });
        expect(beforeProof.status).toBe(400);

        const deliveryAttempts = yield* Ref.make<
          ReadonlyArray<Readonly<{ combinedCode: string; idempotencyKey: string }>>
        >([]);
        expect(
          yield* deliverOneOnboardingEmailForTesting().pipe(
            Effect.provideService(
              EmailDeliveryPort,
              EmailDeliveryPort.of({
                send: (request) =>
                  Effect.gen(function* () {
                    const previousAttempts = yield* Ref.get(deliveryAttempts);
                    yield* Ref.set(deliveryAttempts, [
                      ...previousAttempts,
                      {
                        combinedCode: request.combinedCode,
                        idempotencyKey: request.idempotencyKey,
                      },
                    ]);
                  }),
              })
            )
          )
        ).toBe(true);
        const attempts = yield* Ref.get(deliveryAttempts);
        expect(attempts).toHaveLength(1);
        expect(new Set(attempts.map((attempt) => attempt.combinedCode)).size).toBe(1);
        expect(new Set(attempts.map((attempt) => attempt.idempotencyKey)).size).toBe(1);
        const supersededCode = Option.getOrThrow(Option.fromUndefinedOr(attempts[0]?.combinedCode));
        yield* handleOnboardingTurn(
          turn("Reenviar", "wamid.email-resend", DateTime.add(acceptedAt, { seconds: 64 }))
        );
        const latestCode = yield* Ref.make(Option.none<string>());
        yield* deliverOneOnboardingEmailForTesting().pipe(
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({
              send: ({ combinedCode }) => Ref.set(latestCode, Option.some(combinedCode)),
            })
          ),
          Effect.provideService(Telemetry, testTelemetry)
        );
        const staleGeneration = yield* HttpClient.post("/web/onboarding/email/verify", {
          headers: { origin: "https://fidyapp.com" },
          body: HttpBody.jsonUnsafe({ combinedCode: supersededCode }),
        });
        expect(staleGeneration.status).toBe(400);
        const combinedCode = Option.getOrThrow(yield* Ref.get(latestCode));
        const excessiveRequest = yield* HttpClient.post("/web/onboarding/email/verify", {
          headers: { origin: "https://fidyapp.com" },
          body: HttpBody.text(
            `{"combinedCode":"${combinedCode}","padding":"${"x".repeat(256)}"}`,
            "application/json"
          ),
        });
        expect(excessiveRequest.status).toBe(400);
        expect(excessiveRequest.headers["cache-control"]).toBe("no-store");

        const concurrentResponses = yield* Effect.all(
          [
            HttpClient.post("/web/onboarding/email/verify", {
              headers: { origin: "https://fidyapp.com" },
              body: HttpBody.jsonUnsafe({ combinedCode }),
            }),
            HttpClient.post("/web/onboarding/email/verify", {
              headers: { origin: "https://fidyapp.com" },
              body: HttpBody.jsonUnsafe({ combinedCode }),
            }),
          ],
          { concurrency: "unbounded" }
        );
        expect(
          concurrentResponses.map(({ status }) => status).sort((left, right) => left - right)
        ).toEqual([200, 400]);
        const response = concurrentResponses.find(({ status }) => status === 200);
        if (response === undefined) return yield* Effect.die("missing successful verification");
        const body = yield* Schema.decodeUnknownEffect(CreatedVerifiedOnboarding)(
          yield* response.json
        );
        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(Redacted.value(body.backupRecoveryCode)).toMatch(
          /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}){4}$/u
        );

        const invariant = yield* sql`
          SELECT
            (SELECT count(*)::int FROM users AS users JOIN whatsapp_identities AS identity
              ON identity.user_id = users.id
              WHERE identity.business_portfolio_id = ${caller.businessPortfolioId}
                AND identity.business_scoped_user_id = ${caller.businessScopedUserId}) AS users,
            (SELECT count(*)::int FROM verified_email_credentials
              WHERE email_address = 'person.name+fidy@example.com') AS emails,
            (SELECT count(*)::int FROM backup_recovery_credentials AS recovery
              JOIN whatsapp_identities AS identity ON identity.user_id = recovery.user_id
              WHERE identity.business_portfolio_id = ${caller.businessPortfolioId}
                AND identity.business_scoped_user_id = ${caller.businessScopedUserId}) AS recovery,
            (SELECT count(*)::int FROM consent_records AS consent
              JOIN whatsapp_identities AS identity ON identity.user_id = consent.subject_user_id
              WHERE identity.business_portfolio_id = ${caller.businessPortfolioId}
                AND identity.business_scoped_user_id = ${caller.businessScopedUserId}
                AND consent.grant_type = 'onboarding') AS consent,
            (SELECT count(*)::int FROM email_enrollments
              WHERE business_portfolio_id = ${caller.businessPortfolioId}
                AND business_scoped_user_id = ${caller.businessScopedUserId}) AS enrollment
        `;
        expect(invariant).toEqual([
          { users: 1, emails: 1, recovery: 1, consent: 1, enrollment: 0 },
        ]);
        expect(
          yield* sql`
          SELECT octet_length(code_digest)::int AS bytes
          FROM backup_recovery_credentials AS recovery
          JOIN whatsapp_identities AS identity ON identity.user_id = recovery.user_id
          WHERE identity.business_scoped_user_id = ${caller.businessScopedUserId}
        `
        ).toEqual([{ bytes: 32 }]);
        expect(
          yield* sql`
          SELECT count(*)::int AS count FROM information_schema.columns
          WHERE table_name = 'backup_recovery_credentials' AND column_name = 'code'
        `
        ).toEqual([{ count: 0 }]);

        const replay = yield* HttpClient.post("/web/onboarding/email/verify", {
          headers: { origin: "https://fidyapp.com" },
          body: HttpBody.jsonUnsafe({ combinedCode }),
        });
        expect(replay.status).toBe(400);
        expect(replay.headers["cache-control"]).toBe("no-store");
        expect(
          yield* deliverOneOnboardingEmailForTesting().pipe(
            Effect.provideService(
              EmailDeliveryPort,
              EmailDeliveryPort.of({
                send: () => Effect.die("no delivery should remain"),
              })
            )
          )
        ).toBe(false);
        yield* cleanup;
      })
    );

    it.effect("settles definitive and ambiguous delivery failures without regenerating", () =>
      Effect.gen(function* () {
        yield* cleanup;
        const startedAt = yield* DateTime.now;
        const disclosure = yield* handleOnboardingTurn(
          turn("Inicio", "wamid.failure-start", startedAt)
        );
        if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
        yield* deliverConsentDisclosureForTesting({
          exchangeId: disclosure.exchangeId,
          message: message("wamid.failure-disclosure"),
          deliveredAt: DateTime.add(startedAt, { seconds: 1 }),
        });
        yield* handleOnboardingTurn(
          turn("Acepto", "wamid.failure-accept", DateTime.add(startedAt, { seconds: 2 }))
        );

        const outcomes = yield* Ref.make<ReadonlyArray<DeclaredOutcome>>([]);
        const recordingTelemetry = makeTelemetryService({
          startSpan: () =>
            Effect.succeed(
              Option.some({
                traceId: TelemetryTraceId.make("0".repeat(32)),
                spanId: TelemetrySpanId.make("0".repeat(16)),
                sampled: true,
                state: undefined,
              })
            ),
          finishSpan: () => Effect.void,
          recordOutcome: (_span, outcome) => Ref.update(outcomes, (values) => [...values, outcome]),
          recordResponseStatus: () => Effect.void,
          captureFailure: () => Effect.void,
          addBreadcrumb: () => Effect.void,
          recordModelUsage: () => Effect.void,
        });
        const processFailure = Effect.fn("testProcessEmailFailure")(function* (
          email: string,
          submittedAfterMinutes: number,
          failure: EmailSendFailed
        ) {
          yield* handleOnboardingTurn(
            turn(
              email,
              `wamid.failure-${email}`,
              DateTime.add(startedAt, { minutes: submittedAfterMinutes })
            )
          );
          return yield* deliverOneOnboardingEmailForTesting().pipe(
            Effect.provideService(EmailDeliveryPort, EmailDeliveryPort.of({ send: () => failure })),
            Effect.provideService(Telemetry, recordingTelemetry)
          );
        });

        expect(
          yield* processFailure(
            "ambiguous@example.com",
            2,
            new EmailSendFailed({ certainty: "ambiguous", retryable: true })
          )
        ).toBe(true);
        expect(
          yield* processFailure(
            "rejected@example.com",
            4,
            new EmailSendFailed({ certainty: "rejected", retryable: false })
          )
        ).toBe(true);
        expect(
          yield* processFailure(
            "exhausted@example.com",
            6,
            new EmailSendFailed({ certainty: "rejected", retryable: true })
          )
        ).toBe(true);

        yield* handleOnboardingTurn(
          turn(
            "unobserved@example.com",
            "wamid.failure-unobserved",
            DateTime.add(startedAt, { minutes: 8 })
          )
        );
        expect(
          yield* deliverOneOnboardingEmailForTesting().pipe(
            Effect.provideService(
              EmailDeliveryPort,
              EmailDeliveryPort.of({
                send: () => new EmailSendFailed({ certainty: "rejected", retryable: false }),
              })
            )
          )
        ).toBe(true);

        expect(yield* Ref.get(outcomes)).toEqual([
          { outcome: "failed", error: Option.some("provider_unavailable"), retryable: true },
          { outcome: "rejected", error: Option.some("invalid_response"), retryable: false },
          { outcome: "failed", error: Option.some("provider_unavailable"), retryable: true },
          { outcome: "failed", error: Option.some("provider_unavailable"), retryable: true },
          { outcome: "failed", error: Option.some("provider_unavailable"), retryable: true },
        ]);
        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`
            SELECT generation, status FROM email_delivery_intents
            WHERE enrollment_id IN (
              SELECT id FROM email_enrollments
              WHERE business_scoped_user_id = ${caller.businessScopedUserId}
            ) ORDER BY generation
          `
        ).toEqual([
          { generation: 1, status: "superseded" },
          { generation: 2, status: "superseded" },
          { generation: 3, status: "superseded" },
          { generation: 4, status: "rejected" },
        ]);
        yield* cleanup;
      })
    );

    it.effect(
      "fences stale settlement, recovers expired claims, and serializes replacement races",
      () =>
        Effect.gen(function* () {
          yield* cleanup;
          const startedAt = yield* DateTime.now;
          const disclosure = yield* handleOnboardingTurn(
            turn("Inicio", "wamid.fence-start", startedAt)
          );
          if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
          yield* deliverConsentDisclosureForTesting({
            exchangeId: disclosure.exchangeId,
            message: message("wamid.fence-disclosure"),
            deliveredAt: DateTime.add(startedAt, { seconds: 1 }),
          });
          yield* handleOnboardingTurn(
            turn("Acepto", "wamid.fence-accept", DateTime.add(startedAt, { seconds: 2 }))
          );
          yield* handleOnboardingTurn(
            turn("first@example.com", "wamid.fence-first", DateTime.add(startedAt, { seconds: 3 }))
          );
          const crypto = yield* Crypto.Crypto;
          const runtimeSql = yield* SqlClient.SqlClient;
          const queueFactory = yield* PersistedQueue.PersistedQueueFactory;
          expect(
            yield* deliverOneOnboardingEmailForTesting().pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({
                  send: () =>
                    handleOnboardingTurn(
                      turn(
                        "second@example.com",
                        "wamid.fence-second",
                        DateTime.add(startedAt, { seconds: 5 })
                      )
                    ).pipe(
                      Effect.provideService(Crypto.Crypto, crypto),
                      Effect.provideService(SqlClient.SqlClient, runtimeSql),
                      Effect.provideService(PersistedQueue.PersistedQueueFactory, queueFactory),
                      Effect.orDie,
                      Effect.asVoid
                    ),
                })
              )
            )
          ).toBe(true);

          const [currentIntent] = yield* runtimeSql<{ readonly id: string }>`
            SELECT id FROM email_delivery_intents WHERE status = 'pending'
            ORDER BY generation DESC LIMIT 1
          `;
          if (currentIntent === undefined) return yield* Effect.die("missing current intent");
          const armed = yield* armOnboardingEmailDelivery(
            EmailDeliveryIntentId.make(currentIntent.id),
            DateTime.subtract(startedAt, { seconds: 2 })
          );
          expect(Option.isSome(armed)).toBe(true);
          const recoveredDelivery = yield* Ref.make(false);
          expect(
            yield* deliverOneOnboardingEmailForTesting().pipe(
              Effect.provideService(
                EmailDeliveryPort,
                EmailDeliveryPort.of({ send: () => Ref.set(recoveredDelivery, true) })
              )
            )
          ).toBe(true);
          expect(yield* Ref.get(recoveredDelivery)).toBe(false);

          yield* Effect.all(
            [
              handleOnboardingTurn(
                turn(
                  "third@example.com",
                  "wamid.fence-third",
                  DateTime.add(startedAt, { seconds: 9 })
                )
              ),
              handleOnboardingTurn(
                turn(
                  "fourth@example.com",
                  "wamid.fence-fourth",
                  DateTime.add(startedAt, { seconds: 9 })
                )
              ),
            ],
            { concurrency: "unbounded" }
          );
          const sql = yield* MigrationSqlClient;
          const intents = yield* sql`
            SELECT id, enrollment_id, generation, status FROM email_delivery_intents
            WHERE enrollment_id IN (
              SELECT id FROM email_enrollments
              WHERE business_scoped_user_id = ${caller.businessScopedUserId}
            ) ORDER BY generation
          `;
          expect(intents.map(({ generation, status }) => ({ generation, status }))).toEqual([
            { generation: 1, status: "superseded" },
            { generation: 2, status: "superseded" },
            { generation: 3, status: "superseded" },
            { generation: 4, status: "pending" },
          ]);
          const enrollmentId = intents[0]?.enrollment_id;
          if (typeof enrollmentId !== "string") return yield* Effect.die("missing enrollment");
          const mismatchedCurrentEmail = yield* Effect.exit(
            sql.withTransaction(
              sql`UPDATE email_delivery_intents
                SET email_address = 'mismatch@example.com'
                WHERE enrollment_id = ${enrollmentId} AND generation = 4`
            )
          );
          expect(Exit.isFailure(mismatchedCurrentEmail)).toBe(true);
          const terminalWithoutProof = yield* Effect.exit(
            sql.withTransaction(
              sql`UPDATE email_delivery_intents SET status = 'sent'
                WHERE enrollment_id = ${enrollmentId} AND generation = 4`
            )
          );
          expect(Exit.isFailure(terminalWithoutProof)).toBe(true);
          yield* sql.withTransaction(
            sql`UPDATE email_enrollments
              SET proof_digest = decode(repeat('00', 32), 'hex'),
                proof_expires_at = ${DateTime.add(startedAt, { minutes: 10 })}
              WHERE id = ${enrollmentId}`
          );
          const futureIntent = yield* Effect.exit(
            sql.withTransaction(
              sql`
                INSERT INTO email_delivery_intents (
                  id, enrollment_id, generation, email_address, status, idempotency_key, created_at
                ) VALUES (
                  ${yield* crypto.randomUUIDv7.pipe(Effect.orDie)}, ${enrollmentId}, 5,
                  'future@example.com', 'sent', ${yield* crypto.randomUUIDv7.pipe(Effect.orDie)},
                  ${DateTime.add(startedAt, { seconds: 10 })}
                )
              `
            )
          );
          expect(Exit.isFailure(futureIntent)).toBe(true);
          yield* cleanup;
        })
    );

    it.effect("rejects cross-caller proofs and rolls back duplicate-email owner writes", () =>
      Effect.gen(function* () {
        const otherCaller = testWhatsAppCaller(E164PhoneNumber.make("+573009993325"));
        yield* cleanup;
        yield* cleanupCaller(otherCaller);
        const startedAt = yield* DateTime.now;

        const enroll = Effect.fn("testEnrollCaller")(function* (
          targetCaller: typeof caller,
          prefix: string
        ) {
          const disclosure = yield* handleOnboardingTurn(
            turnFor(targetCaller)("Inicio", `wamid.${prefix}-start`, startedAt)
          );
          if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
          yield* deliverConsentDisclosureForTesting({
            exchangeId: disclosure.exchangeId,
            message: message(`wamid.${prefix}-disclosure`),
            deliveredAt: DateTime.add(startedAt, { seconds: 1 }),
          });
          yield* handleOnboardingTurn(
            turnFor(targetCaller)(
              "Acepto",
              `wamid.${prefix}-accept`,
              DateTime.add(startedAt, { seconds: 2 })
            )
          );
          yield* handleOnboardingTurn(
            turnFor(targetCaller)(
              "shared@example.com",
              `wamid.${prefix}-email`,
              DateTime.add(startedAt, { seconds: 3 })
            )
          );
          const delivered = yield* Ref.make(Option.none<string>());
          yield* deliverOneOnboardingEmailForTesting().pipe(
            Effect.provideService(
              EmailDeliveryPort,
              EmailDeliveryPort.of({
                send: ({ combinedCode }) => Ref.set(delivered, Option.some(combinedCode)),
              })
            )
          );
          return Option.getOrThrow(yield* Ref.get(delivered));
        });

        const firstCode = yield* enroll(caller, "cross-one");
        const secondCode = yield* enroll(otherCaller, "cross-two");
        const crossCallerCode = `${firstCode.split("-").slice(0, 2).join("-")}-${secondCode
          .split("-")
          .slice(2)
          .join("-")}`;
        const crossCaller = yield* HttpClient.post("/web/onboarding/email/verify", {
          headers: { origin: "https://fidyapp.com" },
          body: HttpBody.jsonUnsafe({ combinedCode: crossCallerCode }),
        });
        expect(crossCaller.status).toBe(400);

        expect(
          (yield* HttpClient.post("/web/onboarding/email/verify", {
            headers: { origin: "https://fidyapp.com" },
            body: HttpBody.jsonUnsafe({ combinedCode: firstCode }),
          })).status
        ).toBe(200);
        expect(
          (yield* HttpClient.post("/web/onboarding/email/verify", {
            headers: { origin: "https://fidyapp.com" },
            body: HttpBody.jsonUnsafe({ combinedCode: secondCode }),
          })).status
        ).toBe(400);

        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`
            SELECT
              (SELECT count(*)::int FROM users AS users
                JOIN whatsapp_identities AS identity ON identity.user_id = users.id
                WHERE identity.business_scoped_user_id = ${otherCaller.businessScopedUserId}) AS users,
              (SELECT count(*)::int FROM email_enrollments
                WHERE business_scoped_user_id = ${otherCaller.businessScopedUserId}) AS enrollment
          `
        ).toEqual([{ users: 0, enrollment: 1 }]);
        yield* cleanup;
        yield* cleanupCaller(otherCaller);
      })
    );

    it.effect("rolls back every owner write when an owner operation fails", () =>
      Effect.gen(function* () {
        const sql = yield* MigrationSqlClient;
        yield* sql`
          CREATE OR REPLACE FUNCTION fidy_test_reject_verified_onboarding_insert()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'forced verified onboarding owner failure'; END
          $$
        `;
        const ownerTables = [
          "users",
          "consent_records",
          "verified_email_credentials",
          "backup_recovery_credentials",
        ] as const;

        for (const [index, table] of ownerTables.entries()) {
          const targetCaller = testWhatsAppCaller(
            E164PhoneNumber.make(`+57300999333${String(index)}`)
          );
          yield* cleanupCaller(targetCaller);
          const startedAt = yield* DateTime.now;
          const prefix = `rollback-${String(index)}`;
          const disclosure = yield* handleOnboardingTurn(
            turnFor(targetCaller)("Inicio", `wamid.${prefix}-start`, startedAt)
          );
          if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
          yield* deliverConsentDisclosureForTesting({
            exchangeId: disclosure.exchangeId,
            message: message(`wamid.${prefix}-disclosure`),
            deliveredAt: DateTime.add(startedAt, { seconds: 1 }),
          });
          yield* handleOnboardingTurn(
            turnFor(targetCaller)(
              "Acepto",
              `wamid.${prefix}-accept`,
              DateTime.add(startedAt, { seconds: 2 })
            )
          );
          yield* handleOnboardingTurn(
            turnFor(targetCaller)(
              `rollback-${String(index)}@example.com`,
              `wamid.${prefix}-email`,
              DateTime.add(startedAt, { seconds: 3 })
            )
          );
          const delivered = yield* Ref.make(Option.none<string>());
          yield* deliverOneOnboardingEmailForTesting().pipe(
            Effect.provideService(
              EmailDeliveryPort,
              EmailDeliveryPort.of({
                send: ({ combinedCode }) => Ref.set(delivered, Option.some(combinedCode)),
              })
            )
          );
          const triggerName = `fidy_test_fail_owner_${String(index)}`;
          yield* sql.unsafe(
            `CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fidy_test_reject_verified_onboarding_insert()`
          );
          const response = yield* HttpClient.post("/web/onboarding/email/verify", {
            headers: { origin: "https://fidyapp.com" },
            body: HttpBody.jsonUnsafe({
              combinedCode: Option.getOrThrow(yield* Ref.get(delivered)),
            }),
          });
          expect(response.status).toBe(500);
          yield* sql.unsafe(`DROP TRIGGER ${triggerName} ON ${table}`);
          expect(
            yield* sql`
              SELECT
                (SELECT count(*)::int FROM users AS users
                  JOIN whatsapp_identities AS identity ON identity.user_id = users.id
                  WHERE identity.business_scoped_user_id = ${targetCaller.businessScopedUserId}) AS users,
                (SELECT count(*)::int FROM email_enrollments
                  WHERE business_scoped_user_id = ${targetCaller.businessScopedUserId}) AS enrollment
            `
          ).toEqual([{ users: 0, enrollment: 1 }]);
          yield* cleanupCaller(targetCaller);
        }
        yield* sql`DROP FUNCTION fidy_test_reject_verified_onboarding_insert()`;
      })
    );

    it.effect("deletes all bounded evidence after the fifth wrong proof", () =>
      Effect.gen(function* () {
        yield* cleanup;
        const startedAt = yield* DateTime.now;
        const disclosure = yield* handleOnboardingTurn(
          turn("Inicio", "wamid.wrong-start", startedAt)
        );
        if (disclosure._tag !== "SendDisclosure") return yield* Effect.die("missing disclosure");
        yield* deliverConsentDisclosureForTesting({
          exchangeId: disclosure.exchangeId,
          message: message("wamid.wrong-disclosure"),
          deliveredAt: DateTime.add(startedAt, { seconds: 1 }),
        });
        yield* handleOnboardingTurn(
          turn("Acepto", "wamid.wrong-accept", DateTime.add(startedAt, { seconds: 2 }))
        );
        yield* handleOnboardingTurn(
          turn(
            "wrong-proof@example.com",
            "wamid.wrong-email",
            DateTime.add(startedAt, { seconds: 3 })
          )
        );
        const deliveredCode = yield* Ref.make(Option.none<string>());
        yield* deliverOneOnboardingEmailForTesting().pipe(
          Effect.provideService(
            EmailDeliveryPort,
            EmailDeliveryPort.of({
              send: ({ combinedCode }) => Ref.set(deliveredCode, Option.some(combinedCode)),
            })
          )
        );
        const validCode = Option.getOrThrow(yield* Ref.get(deliveredCode));
        const wrongCode = `${validCode.slice(0, 9)}-AAAA-AAAA-AAAA-AAAA`;
        for (const expectedAttempts of [1, 2, 3, 4]) {
          const response = yield* HttpClient.post("/web/onboarding/email/verify", {
            headers: { origin: "https://fidyapp.com" },
            body: HttpBody.jsonUnsafe({ combinedCode: wrongCode }),
          });
          expect(response.status).toBe(400);
          expect(response.headers["cache-control"]).toBe("no-store");
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`
              SELECT wrong_proof_attempts AS attempts FROM email_enrollments
              WHERE business_scoped_user_id = ${caller.businessScopedUserId}
            `
          ).toEqual([{ attempts: expectedAttempts }]);
        }
        expect(
          (yield* HttpClient.post("/web/onboarding/email/verify", {
            headers: { origin: "https://fidyapp.com" },
            body: HttpBody.jsonUnsafe({ combinedCode: wrongCode }),
          })).status
        ).toBe(400);
        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`
            SELECT
              (SELECT count(*)::int FROM email_enrollments
                WHERE business_scoped_user_id = ${caller.businessScopedUserId}) AS enrollments,
              (SELECT count(*)::int FROM pending_consent_exchanges
                WHERE business_scoped_user_id = ${caller.businessScopedUserId}) AS pending,
              (SELECT count(*)::int FROM whatsapp_identities
                WHERE business_scoped_user_id = ${caller.businessScopedUserId}) AS identities
          `
        ).toEqual([{ enrollments: 0, pending: 0, identities: 0 }]);
        yield* cleanup;
      })
    );
  }
);
