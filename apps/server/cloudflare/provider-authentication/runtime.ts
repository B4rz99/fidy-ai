import {
  directoryName,
  rejectInvitationSendUrl,
  whatsappBootstrapUrl,
} from "../directory/contract";
import { UserId } from "../../src/core/identity/contract";
import { DateTime, Effect, Option, Redacted, Schema } from "effect";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { makeProviderHandoffSender } from "../../src/shell/provider-authentication/runtime";
import type {
  WhatsAppAuthenticatedInbound,
  WhatsAppIngressEnvironment,
} from "../whatsapp/contract";
import { HttpClient } from "effect/http";
import { ProviderAuthenticationRetentionUnavailable } from "./contract";

const noContentStatus = 204;
const okStatus = 200;

const admissionWindowMs = 60_000;
const maximumSweepRows = 500;
const retainedAttemptMilliseconds = 86_400_000;
/** Removes expired provider protocol state after one day; durable credentials and Consent remain owned by their records. */
export const sweepProviderAuthentication = ({
  db,
  current,
}: Readonly<{ db: D1Database; current: number }>): Effect.Effect<
  void,
  ProviderAuthenticationRetentionUnavailable
> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(`DELETE FROM resource_admission_events WHERE grant_id IN (
        SELECT id FROM resource_admission_grants WHERE id GLOB 'provider-admission-*'
        AND admitted_at_epoch_ms <= ? ORDER BY admitted_at_epoch_ms,id LIMIT 3000
      ) AND expires_at_epoch_ms <= ?`)
        .bind(current - admissionWindowMs, current),
      db
        .prepare(`DELETE FROM resource_admission_grants WHERE id IN (
        SELECT id FROM resource_admission_grants WHERE id GLOB 'provider-admission-*'
        AND admitted_at_epoch_ms <= ? ORDER BY admitted_at_epoch_ms,id LIMIT 3000
      ) AND NOT EXISTS (SELECT 1 FROM resource_admission_events e WHERE e.grant_id=id)`)
        .bind(current - admissionWindowMs),
      db
        .prepare(
          "DELETE FROM provider_authentication_attempts WHERE id IN (SELECT id FROM provider_authentication_attempts WHERE expires_at_ms<? ORDER BY expires_at_ms,id LIMIT ?)"
        )
        .bind(current - retainedAttemptMilliseconds, maximumSweepRows),
      db
        .prepare(
          "DELETE FROM whatsapp_signup_invitations WHERE id IN(SELECT id FROM whatsapp_signup_invitations WHERE expires_at_ms<? ORDER BY expires_at_ms,id LIMIT ?)"
        )
        .bind(current - retainedAttemptMilliseconds, maximumSweepRows),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new ProviderAuthenticationRetentionUnavailable())
  );

export const makeProviderAuthenticationErasureStores = (
  db: D1Database
): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));

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
  if (sent._tag === "Failure") {
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
/** Send only after the Directory atomically admits the exact authenticated chat and claims its invitation. */
export const routeNativeInvitation = Effect.fn(
  function* (environment: WhatsAppIngressEnvironment, inbound: WhatsAppAuthenticatedInbound) {
    const { event } = inbound;
    if (event.content._tag !== "Text" || environment.DIRECTORY === undefined) {
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
