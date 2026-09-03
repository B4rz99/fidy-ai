import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { PendingConsentExchangeId } from "~/core/consent/model";
import {
  EmailDeliveryIntentId,
  EmailEnrollmentId,
  EmailVerificationPublicCode,
} from "~/core/email-authentication/model";
import { E164PhoneNumber, whatsAppCallerReference } from "~/core/identity/reference";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { ApiHarness } from "~/shell/testing/api-harness";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { currentDisclosure } from "~/shell/consent/current-disclosure";
import { findPendingConsentExchange, insertPendingConsentExchange } from "~/shell/consent/repo";
import { onboardingEmailDeliveryQueue } from "./delivery-workflow";
import { runOnboardingRetention } from "./retention";

const OnboardingRetentionHarness = Layer.merge(ApiHarness, TelemetryDisabled);

const expiredPhone = E164PhoneNumber.make("+573009998861");
const activePhone = E164PhoneNumber.make("+573009998862");
const now = DateTime.makeUnsafe("2026-08-02T12:00:00Z");

layer(OnboardingRetentionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "onboarding retention",
  (it) => {
    it.effect("deletes exact-boundary expiry without deleting active exchanges", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const expiredCaller = testWhatsAppCaller(expiredPhone);
        const activeCaller = testWhatsAppCaller(activePhone);
        yield* sql`
          DELETE FROM pending_consent_exchanges
          WHERE (business_portfolio_id, business_scoped_user_id) IN (
            (${expiredCaller.businessPortfolioId}, ${expiredCaller.businessScopedUserId}),
            (${activeCaller.businessPortfolioId}, ${activeCaller.businessScopedUserId})
          )
        `;
        const disclosure = yield* currentDisclosure;
        const createdAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");

        yield* insertPendingConsentExchange({
          _tag: "AwaitingDisclosureDelivery",
          id: PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000861"),
          caller: whatsAppCallerReference(expiredCaller),
          disclosure,
          initiatingMessage: {
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "wamid.retention-expired",
          },
          createdAt,
          expiresAt: now,
        });
        yield* insertPendingConsentExchange({
          _tag: "AwaitingDisclosureDelivery",
          id: PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000862"),
          caller: whatsAppCallerReference(activeCaller),
          disclosure,
          initiatingMessage: {
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "wamid.retention-active",
          },
          createdAt: DateTime.addDuration(createdAt, "1 millis"),
          expiresAt: DateTime.addDuration(now, "1 millis"),
        });

        yield* runOnboardingRetention(now);

        expect(
          Option.isNone(yield* findPendingConsentExchange(testWhatsAppCaller(expiredPhone)))
        ).toBe(true);
        expect(
          Option.isSome(yield* findPendingConsentExchange(testWhatsAppCaller(activePhone)))
        ).toBe(true);
      })
    );

    it.effect("preserves expired state while its durable delivery remains incomplete", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const caller = testWhatsAppCaller(E164PhoneNumber.make("+573009998864"));
        const exchangeId = PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000865");
        const enrollmentId = EmailEnrollmentId.make("f1d1a000-0000-4000-8000-000000000866");
        const intentId = EmailDeliveryIntentId.make("f1d1a000-0000-4000-8000-000000000867");
        const createdAt = DateTime.makeUnsafe("2026-08-01T12:00:00Z");
        yield* sql`DELETE FROM fidy_queue
          WHERE queue_name = 'onboarding-email-delivery' AND id = ${intentId}`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM email_enrollments WHERE id = ${enrollmentId}`;
            yield* sql`DELETE FROM pending_consent_exchanges WHERE id = ${exchangeId}`;
          })
        );
        const disclosure = yield* currentDisclosure;
        yield* insertPendingConsentExchange({
          _tag: "AwaitingDisclosureDelivery",
          id: exchangeId,
          caller: whatsAppCallerReference(caller),
          disclosure,
          initiatingMessage: {
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "wamid.retention-incomplete",
          },
          createdAt,
          expiresAt: now,
        });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE pending_consent_exchanges SET
              decision_channel = 'whatsapp', decision_provider = 'kapso',
              decision_provider_message_id = 'wamid.retention-incomplete-decision',
              accepted_at = ${createdAt}
              WHERE id = ${exchangeId}`;
            yield* sql`INSERT INTO email_enrollments (
              id, public_code, business_portfolio_id, business_scoped_user_id,
              pending_consent_exchange_id, expires_at, email_address, delivery_generation,
              resend_available_at
            ) VALUES (
              ${enrollmentId}, ${EmailVerificationPublicCode.make("RSTU-WXYZ")},
              ${caller.businessPortfolioId}, ${caller.businessScopedUserId}, ${exchangeId}, ${now},
              'incomplete@example.com', 1, ${createdAt}
            )`;
            yield* sql`INSERT INTO email_delivery_intents (
              id, enrollment_id, generation, email_address, status, idempotency_key, created_at
            ) VALUES (
              ${intentId}, ${enrollmentId}, 1, 'incomplete@example.com', 'pending',
              'f1d1a000-0000-4000-8000-000000000868', ${createdAt}
            )`;
            const queue = yield* onboardingEmailDeliveryQueue;
            yield* queue.offer({ intentId, revision: 1 }, { id: intentId });
          })
        );

        yield* runOnboardingRetention(now);

        expect(
          yield* sql`SELECT id FROM email_enrollments WHERE id = ${enrollmentId}`
        ).toHaveLength(1);
        expect(
          yield* sql`SELECT id FROM pending_consent_exchanges WHERE id = ${exchangeId}`
        ).toHaveLength(1);
        expect(
          yield* sql`SELECT id FROM fidy_queue
            WHERE queue_name = 'onboarding-email-delivery' AND id = ${intentId}
              AND completed = FALSE`
        ).toHaveLength(1);

        yield* sql`DELETE FROM fidy_queue
          WHERE queue_name = 'onboarding-email-delivery' AND id = ${intentId}`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM email_enrollments WHERE id = ${enrollmentId}`;
            yield* sql`DELETE FROM pending_consent_exchanges WHERE id = ${exchangeId}`;
          })
        );
      })
    );

    it.effect("removes accepted evidence only when its linked enrollment expires", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const caller = testWhatsAppCaller(E164PhoneNumber.make("+573009998863"));
        const exchangeId = PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000863");
        const legacyIntentId = EmailDeliveryIntentId.make("f1d1a000-0000-4000-8000-000000000869");
        const expiresAt = DateTime.makeUnsafe("2026-08-03T12:00:00Z");
        yield* sql`DELETE FROM email_enrollments
          WHERE pending_consent_exchange_id = ${exchangeId}`;
        yield* sql`DELETE FROM pending_consent_exchanges WHERE id = ${exchangeId}`;
        const disclosure = yield* currentDisclosure;
        yield* insertPendingConsentExchange({
          _tag: "AwaitingDisclosureDelivery",
          id: exchangeId,
          caller: whatsAppCallerReference(caller),
          disclosure,
          initiatingMessage: {
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "wamid.retention-accepted",
          },
          createdAt: DateTime.makeUnsafe("2026-08-02T12:00:00Z"),
          expiresAt,
        });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE pending_consent_exchanges SET
              decision_channel = 'whatsapp', decision_provider = 'kapso',
              decision_provider_message_id = 'wamid.retention-accepted-decision',
              accepted_at = ${DateTime.makeUnsafe("2026-08-02T12:00:00Z")}
              WHERE id = ${exchangeId}`;
            yield* sql`INSERT INTO email_enrollments (
              id, public_code, business_portfolio_id, business_scoped_user_id,
              pending_consent_exchange_id, expires_at, email_address, delivery_generation,
              proof_digest, proof_expires_at, resend_available_at
            ) VALUES (
              ${EmailEnrollmentId.make("f1d1a000-0000-4000-8000-000000000864")},
              ${EmailVerificationPublicCode.make("JKLM-NPQR")}, ${caller.businessPortfolioId},
              ${caller.businessScopedUserId}, ${exchangeId}, ${expiresAt},
              'legacy-terminal@example.com', 1, decode(repeat('00', 32), 'hex'), ${expiresAt},
              ${expiresAt}
            )`;
            yield* sql`INSERT INTO email_delivery_intents (
              id, enrollment_id, generation, email_address, status, idempotency_key, created_at
            ) VALUES (
              ${legacyIntentId}, ${EmailEnrollmentId.make("f1d1a000-0000-4000-8000-000000000864")},
              1, 'legacy-terminal@example.com', 'sent',
              'f1d1a000-0000-4000-8000-000000000870', ${expiresAt}
            )`;
          })
        );

        yield* runOnboardingRetention(DateTime.subtract(expiresAt, { milliseconds: 1 }));
        expect(
          yield* sql`SELECT id FROM pending_consent_exchanges WHERE id = ${exchangeId}`
        ).toHaveLength(1);
        yield* runOnboardingRetention(expiresAt);
        expect(
          yield* sql`SELECT id FROM pending_consent_exchanges WHERE id = ${exchangeId}`
        ).toHaveLength(0);
      })
    );
  }
);
