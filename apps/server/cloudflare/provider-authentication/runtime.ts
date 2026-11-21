import {
  directoryName,
  rejectInvitationSendUrl,
  whatsappBootstrapUrl,
} from "../directory/contract";
import { UserId } from "../../src/core/identity/contract";
import { DateTime, Effect, Option, Predicate, Redacted, Result, Schema } from "effect";
import { makeProviderHandoffSender } from "../../src/shell/provider-authentication/runtime";
import type {
  WhatsAppAuthenticatedInbound,
  WhatsAppIngressEnvironment,
} from "../whatsapp/contract";
import { HttpClient } from "effect/http";

const noContentStatus = 204;

const okStatus = 200;

const sendInvitation = Effect.fn(function* (
  environment: WhatsAppIngressEnvironment,
  event: WhatsAppAuthenticatedInbound["event"],
  { owner, invitation }: { owner: Pick<Fetcher, "fetch">; invitation: string }
) {
  const send = makeProviderHandoffSender({
    apiKey: Redacted.make(environment.KAPSO_API_KEY),
    httpClient: yield* HttpClient.HttpClient,
    sandboxPhoneNumberId: Option.fromNullishOr(environment.WHATSAPP_SANDBOX_PHONE_NUMBER_ID),
  });

  const sent = yield* Effect.result(
    send({
      event,
      text: `¡Hola! Para usar Fidy, acepta la política e inicia sesión con Google o Microsoft:\n${environment.BROWSER_ORIGIN}/login?handoff=${invitation}\nAl terminar, volverás a este chat.`,
    })
  );

  if (Result.isFailure(sent)) {
    if (sent.failure.deliveryCertainty !== "rejected") return new Response(null, { status: 503 });

    const receipt = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      id: invitation,
      message: event.messageEvidence.providerMessageId,
    });

    const settled = yield* Effect.tryPromise((signal) =>
      owner.fetch(rejectInvitationSendUrl, { method: "POST", body: receipt, signal })
    );

    if (!settled.ok) return new Response(null, { status: 503 });
  }

  return new Response(null, { status: 200 });
});

export const routeNativeInvitation = Effect.fn(
  function* (environment: WhatsAppIngressEnvironment, inbound: WhatsAppAuthenticatedInbound) {
    const { event } = inbound;

    if (!Predicate.isTagged(event.content, "Text") || environment.DIRECTORY === undefined) {
      return new Response(null, { status: 503 });
    }

    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      portfolio: event.caller.businessPortfolioId,
      bsuid: event.caller.businessScopedUserId,
      endpoint: event.businessPhoneNumberId,
      message: event.messageEvidence.providerMessageId,
      phone: Option.getOrNull(event.caller.phoneNumber),
      text: event.content.text,
      receivedAt: inbound.receivedAtMs,
      occurredAt: DateTime.toEpochMillis(event.occurredAt),
    });

    const owner = environment.DIRECTORY.getByName(directoryName);

    const response = yield* Effect.tryPromise((signal) =>
      owner.fetch(whatsappBootstrapUrl, { method: "POST", body, signal })
    );

    if (!response.ok || response.status === noContentStatus) {
      return new Response(null, { status: response.ok ? okStatus : response.status });
    }

    const result = yield* Schema.decodeUnknownEffect(
      Schema.Union([
        Schema.Struct({ userId: UserId }),
        Schema.Struct({ invitation: Schema.String }),
      ])
    )(yield* Effect.tryPromise(() => response.json()));

    if ("userId" in result) return result.userId;

    return yield* sendInvitation(environment, event, { owner, invitation: result.invitation });
  },
  Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
);
