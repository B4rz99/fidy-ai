import { Effect, Option, Ref, Schema } from "effect";
import type { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import type { PendingConsentExchangeId } from "~/core/consent/model";
import { E164PhoneNumber } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import {
  applyConsentDisclosureLifecycle,
  requestConsentDisclosureDelivery,
} from "~/shell/channels/whatsapp/disclosure-delivery";
import { KapsoClient } from "~/shell/channels/whatsapp/kapso-client";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppMessageEvidence,
} from "~/shell/channels/whatsapp/model";
import { testWhatsAppCaller } from "./whatsapp-caller";

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
    yield* requestConsentDisclosureDelivery({
      exchangeId: input.exchangeId,
      event: {
        messageEvidence,
        caller: testWhatsAppCaller(E164PhoneNumber.make("+573000000001")),
        businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789012345"),
        content: { _tag: "Text", text: TranscriptText.make("test disclosure") },
        occurredAt: input.deliveredAt,
        receivedAt: input.deliveredAt,
      },
      text: TranscriptText.make("test disclosure"),
      beforeProviderCall: Effect.void,
    }).pipe(
      Effect.provideService(KapsoClient, {
        sendText: (send) =>
          Ref.set(correlation, send.opaqueCallbackData).pipe(
            Effect.as({ messageEvidence, sentAt: input.deliveredAt })
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
