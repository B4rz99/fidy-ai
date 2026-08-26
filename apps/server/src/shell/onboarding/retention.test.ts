import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { PendingConsentExchangeId } from "~/core/consent/model";
import { EmailEnrollmentId, EmailVerificationPublicCode } from "~/core/email-authentication/model";
import { E164PhoneNumber, whatsAppCallerReference } from "~/core/identity/reference";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { ApiHarness } from "~/shell/testing/api-harness";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { currentDisclosure } from "~/shell/consent/current-disclosure";
import { findPendingConsentExchange, insertPendingConsentExchange } from "~/shell/consent/repo";
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

    it.effect("removes accepted evidence only when its linked enrollment expires", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const caller = testWhatsAppCaller(E164PhoneNumber.make("+573009998863"));
        const exchangeId = PendingConsentExchangeId.make("f1d1a000-0000-4000-8000-000000000863");
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
              pending_consent_exchange_id, expires_at
            ) VALUES (
              ${EmailEnrollmentId.make("f1d1a000-0000-4000-8000-000000000864")},
              ${EmailVerificationPublicCode.make("JKLM-NPQR")}, ${caller.businessPortfolioId},
              ${caller.businessScopedUserId}, ${exchangeId}, ${expiresAt}
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
