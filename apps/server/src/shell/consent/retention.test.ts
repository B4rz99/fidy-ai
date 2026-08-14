import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { PendingConsentExchangeId } from "~/core/consent/model";
import { E164PhoneNumber, whatsAppCallerReference } from "~/core/identity/reference";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { ApiHarness } from "~/shell/testing/api-harness";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { currentDisclosure } from "./current-disclosure";
import { findPendingConsentExchange, insertPendingConsentExchange } from "./repo";
import { runPendingConsentRetention } from "./retention";

const PendingRetentionHarness = Layer.merge(ApiHarness, TelemetryDisabled);

const expiredPhone = E164PhoneNumber.make("+573009998861");
const activePhone = E164PhoneNumber.make("+573009998862");
const now = DateTime.makeUnsafe("2026-08-02T12:00:00Z");

layer(PendingRetentionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "pending Consent retention",
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

        yield* runPendingConsentRetention(now);

        expect(
          Option.isNone(yield* findPendingConsentExchange(testWhatsAppCaller(expiredPhone)))
        ).toBe(true);
        expect(
          Option.isSome(yield* findPendingConsentExchange(testWhatsAppCaller(activePhone)))
        ).toBe(true);
      })
    );
  }
);
