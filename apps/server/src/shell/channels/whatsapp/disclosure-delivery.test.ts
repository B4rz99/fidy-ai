import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Option, Ref } from "effect";
import { E164PhoneNumber } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import { handleOnboardingTurn } from "~/shell/onboarding/onboarding";
import { findPendingConsentExchange, removePendingConsentExchange } from "~/shell/consent/repo";
import { ApiHarness } from "~/shell/testing/api-harness";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import {
  performConsentDisclosureAttempt,
  requestConsentDisclosureDelivery,
} from "./disclosure-delivery";
import { DisclosureDeliveryAttemptNumber } from "./disclosure-model";
import { KapsoClient, KapsoSendFailed } from "./kapso-client";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppMessageEvidence,
  WhatsAppProviderMessageId,
} from "./model";

const admit = Effect.fn(function* (phone: string) {
  const now = yield* DateTime.now;
  const caller = testWhatsAppCaller(E164PhoneNumber.make(phone));
  const previous = yield* findPendingConsentExchange(caller);
  if (Option.isSome(previous)) yield* removePendingConsentExchange(previous.value.id);
  const message = WhatsAppMessageEvidence.make({
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: WhatsAppProviderMessageId.make(`wamid.disclosure-${phone}`),
  });
  const admission = yield* handleOnboardingTurn({
    caller,
    content: { _tag: "Text", text: "Hola" },
    message,
    receivedAt: now,
  });
  if (admission._tag !== "SendDisclosure") return yield* Effect.die("expected disclosure");
  return {
    exchangeId: admission.exchangeId,
    event: {
      caller,
      messageEvidence: message,
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789012345"),
      content: { _tag: "Text" as const, text: TranscriptText.make("Hola") },
      occurredAt: now,
      receivedAt: now,
    },
    beforeProviderCall: Effect.void,
  };
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "durable Consent disclosure delivery",
  (it) => {
    it.effect(
      "acknowledges duplicate accepted work without invoking the provider in the request",
      () =>
        Effect.gen(function* () {
          const input = yield* admit("+573007774661");
          const calls = yield* Ref.make(0);
          const request = requestConsentDisclosureDelivery(input).pipe(
            Effect.provideService(KapsoClient, {
              sendText: () =>
                Ref.update(calls, (count) => count + 1).pipe(
                  Effect.andThen(
                    new KapsoSendFailed({
                      deliveryCertainty: "ambiguous",
                      safeReason: "timeout",
                      automaticRetry: false,
                      responseStatus: Option.none(),
                    })
                  )
                ),
            })
          );
          yield* request;
          yield* request;
          expect(yield* Ref.get(calls)).toBe(0);
        })
    );

    it.effect("rejects another pre-User exchange without accepting or sending its disclosure", () =>
      Effect.gen(function* () {
        const alice = yield* admit("+573007774662");
        const bob = yield* admit("+573007774663");
        const failure = yield* requestConsentDisclosureDelivery({
          ...bob,
          exchangeId: alice.exchangeId,
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("ConsentDisclosureDeliveryUnavailable");
        const calls = yield* Ref.make(0);
        yield* performConsentDisclosureAttempt(
          alice.exchangeId,
          DisclosureDeliveryAttemptNumber.make(1)
        ).pipe(
          Effect.provideService(KapsoClient, {
            sendText: () =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(Effect.die("unaccepted disclosure was sent"))
              ),
          })
        );
        expect(yield* Ref.get(calls)).toBe(0);
      })
    );
  }
);
