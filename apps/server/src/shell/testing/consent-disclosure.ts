import { Effect, Option, Ref, Schema } from "effect";
import type { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import type { PendingConsentExchangeId } from "~/core/consent/model";
import { findPendingConsentDisclosureRetry } from "~/shell/consent/repo";
import { TranscriptText } from "~/core/transcript/model";
import { okStatus } from "~/shell/_shared/http-status";
import {
  applyConsentDisclosureLifecycle,
  performConsentDisclosureAttempt,
  requestConsentDisclosureDelivery,
} from "~/shell/channels/whatsapp/disclosure-delivery";
import { KapsoClient } from "~/shell/channels/whatsapp/kapso-client";
import { DisclosureDeliveryAttemptNumber } from "~/shell/channels/whatsapp/disclosure-model";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppMessageEvidence,
} from "~/shell/channels/whatsapp/model";

/** Drives verified delivery through the public disclosure module for neighboring-slice tests. */
export const deliverConsentDisclosureForTesting = Effect.fn("Test.deliverConsentDisclosure")(
  function* (input: {
    readonly exchangeId: PendingConsentExchangeId;
    readonly message: ProviderMessageEvidence;
    readonly deliveredAt: Parameters<typeof applyConsentDisclosureLifecycle>[0]["occurredAt"];
  }) {
    const messageEvidence = yield* Schema.decodeUnknownEffect(WhatsAppMessageEvidence)(
      input.message
    );
    const correlation = yield* Ref.make(
      Option.none<Parameters<typeof applyConsentDisclosureLifecycle>[0]["correlationToken"]>()
    );
    const pending = yield* findPendingConsentDisclosureRetry(input.exchangeId).pipe(
      Effect.flatMap(Effect.fromOption)
    );
    yield* requestConsentDisclosureDelivery({
      exchangeId: input.exchangeId,
      event: {
        messageEvidence,
        caller: {
          businessPortfolioId: pending.businessPortfolioId,
          businessScopedUserId: pending.businessScopedUserId,
          phoneNumber: Option.none(),
          parentBusinessScopedUserId: Option.none(),
          username: Option.none(),
        },
        businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789012345"),
        content: { _tag: "Text", text: TranscriptText.make("test disclosure") },
        occurredAt: input.deliveredAt,
        receivedAt: input.deliveredAt,
      },
      beforeProviderCall: Effect.void,
    });
    yield* performConsentDisclosureAttempt(
      input.exchangeId,
      DisclosureDeliveryAttemptNumber.make(1)
    ).pipe(
      Effect.provideService(KapsoClient, {
        sendText: (send) =>
          Ref.set(correlation, send.opaqueCallbackData).pipe(
            Effect.as({
              messageEvidence,
              sentAt: input.deliveredAt,
              responseStatus: TelemetryHttpStatus.make(okStatus),
            })
          ),
      })
    );
    const correlationToken = yield* Ref.get(correlation).pipe(Effect.flatMap(Effect.fromOption));
    const result = yield* applyConsentDisclosureLifecycle({
      outcome: "accepted",
      correlationToken,
      messageEvidence,
      occurredAt: input.deliveredAt,
    });
    return { correlationToken, result } as const;
  }
);
