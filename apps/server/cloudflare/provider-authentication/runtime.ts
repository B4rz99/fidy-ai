import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { makeProviderHandoffSender } from "../../src/shell/provider-authentication/runtime";
import type {
  WhatsAppAuthenticatedInbound,
  WhatsAppIngressEnvironment,
} from "../whatsapp/contract";
import { HttpClient } from "effect/http";
import { receiveHandoffText } from "./internal/whatsapp-handoff";
import { ProviderAuthenticationRetentionUnavailable } from "./contract";
import { Effect, Option, Redacted } from "effect";

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
          "DELETE FROM completed_provider_authentications WHERE attempt_id IN (SELECT id FROM provider_authentication_attempts WHERE expires_at_ms<? ORDER BY expires_at_ms,id LIMIT ?)"
        )
        .bind(current - retainedAttemptMilliseconds, maximumSweepRows),
      db
        .prepare(
          "DELETE FROM provider_authentication_attempts WHERE id IN (SELECT id FROM provider_authentication_attempts WHERE expires_at_ms<? ORDER BY expires_at_ms,id LIMIT ?)"
        )
        .bind(current - retainedAttemptMilliseconds, maximumSweepRows),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new ProviderAuthenticationRetentionUnavailable())
  );

/** Compose fixed outbound policy with authenticated pre-User channel confirmation; no model or Transcript participates. */
export const receiveWhatsAppProviderHandoff = ({
  environment,
  inbound,
}: Readonly<{
  environment: WhatsAppIngressEnvironment;
  inbound: WhatsAppAuthenticatedInbound;
}>): Effect.Effect<Option.Option<Response>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* receiveHandoffText({
      db: environment.DB,
      browserOrigin: environment.BROWSER_ORIGIN,
      inbound,
      send: makeProviderHandoffSender({
        apiKey: Redacted.make(environment.KAPSO_API_KEY),
        httpClient,
        sandboxPhoneNumberId: Option.fromNullishOr(environment.WHATSAPP_SANDBOX_PHONE_NUMBER_ID),
      }),
    });
  });

export const makeProviderAuthenticationErasureStores = (
  db: D1Database
): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));
