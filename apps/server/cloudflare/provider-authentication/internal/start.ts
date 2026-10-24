import { providerConfiguration } from "./configuration";
import { type Cause, Clock, Effect, Option, type PlatformError, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import {
  type AuthenticationProvider,
  StartProviderAuthentication,
} from "../../../src/shell/provider-authentication/contract";
import { DisclosureSnapshot } from "../../../src/core/consent/contract";
import { webSignupDisclosure } from "../../../src/shell/consent/operations";
import { provePendingBrowserPairing } from "../../browser-login/operations";
import { digestBytes, newId, newSecret } from "../../secret-material/operations";
import { boundedJsonBody } from "../../http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import type { ProviderEnvironment } from "../contract";

const invalidStatus = 400;
const unavailableStatus = 503;
const successStatus = 200;
const attemptLifetimeMs = 600000;
export const providerBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});
export const providerJson = ({
  body,
  status = 200,
  headers,
}: Readonly<{ body: object }> &
  Partial<Readonly<{ status: number; headers: HeadersInit }>>): Response => {
  const result = new Headers(headers);
  result.set("cache-control", "no-store");
  result.set("referrer-policy", "no-referrer");
  return Response.json(body, { status, headers: result });
};
const authorizationUrl = ({
  environment,
  provider,
  state,
  nonce,
  challenge,
}: Readonly<{
  environment: ProviderEnvironment;
  provider: AuthenticationProvider;
  state: string;
  nonce: string;
  challenge: Uint8Array;
}>): string => {
  const configuration = providerConfiguration({ environment, provider });
  const authorization = new URL(
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
  );
  authorization.search = new URLSearchParams({
    client_id: configuration.clientId,
    redirect_uri: configuration.redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: Base64Url.encode(challenge),
    code_challenge_method: "S256",
  }).toString();
  return authorization.href;
};
const prepareAttempt = (
  disclosure: DisclosureSnapshot
): Effect.Effect<
  Readonly<{
    current: number;
    state: string;
    verifier: string;
    nonce: string;
    challenge: Uint8Array;
    snapshot: string;
  }>,
  Schema.SchemaError | PlatformError.PlatformError
> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const state = Redacted.value(yield* newSecret);
    const verifier = Redacted.value(yield* newSecret);
    const nonce = Redacted.value(yield* newSecret);
    const challenge = yield* digestBytes(new TextEncoder().encode(verifier));
    const snapshot = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
      disclosure
    );
    return { current, state, verifier, nonce, challenge, snapshot };
  });
const startedResponse = ({
  environment,
  provider,
  state,
  nonce,
  challenge,
  verifier,
}: Readonly<{
  environment: ProviderEnvironment;
  provider: AuthenticationProvider;
  state: string;
  nonce: string;
  challenge: Uint8Array;
  verifier: string;
}>): Response =>
  providerJson({
    body: {
      authorizationUrl: authorizationUrl({ environment, provider, state, nonce, challenge }),
    },
    status: successStatus,
    headers: {
      "set-cookie": `${providerConfiguration({ environment, provider }).cookieName}=${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
const persistAttempt = ({
  environment,
  provider,
  input,
  proven,
  prepared,
  invitation,
}: Readonly<{
  environment: ProviderEnvironment;
  provider: AuthenticationProvider;
  input: typeof StartProviderAuthentication.Type;
  proven: number;
  invitation: boolean;
  prepared: Effect.Success<ReturnType<typeof prepareAttempt>>;
}>): Effect.Effect<void, Cause.UnknownError> => {
  const { current, state, nonce, challenge, snapshot } = prepared;
  const handoffId = input.handoffReference ?? null;
  const claim =
    handoffId === null
      ? []
      : [
          environment.DB.prepare(
            invitation
              ? "UPDATE whatsapp_signup_invitations SET pairing_id=?,review_code=? WHERE id=? AND pairing_id IS NULL AND expires_at_ms>? AND approved_at_ms IS NULL AND consumed_at_ms IS NULL"
              : "UPDATE whatsapp_provider_handoffs SET pairing_id=?,review_code=? WHERE id=? AND pairing_id IS NULL AND expires_at_ms>? AND decision IS NULL AND consumed_at_ms IS NULL"
          ).bind(input.pairingId, newId(), handoffId, current),
        ];
  return Effect.tryPromise(() =>
    environment.DB.batch([
      ...claim,
      ...(invitation
        ? [
            environment.DB.prepare(
              "DELETE FROM provider_authentication_attempts WHERE pairing_id=? AND invitation_id=? AND completed_at_ms IS NULL"
            ).bind(input.pairingId, handoffId),
          ]
        : []),
      environment.DB.prepare(`INSERT INTO provider_authentication_attempts
      (id,pairing_id,provider,cookie_digest,nonce,intent,disclosure_json,consent_at_ms,created_at_ms,expires_at_ms,state,handoff_id,invitation_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).bind(
        state,
        input.pairingId,
        provider,
        challenge,
        nonce,
        input.intent,
        input.intent === "signup" ? snapshot : null,
        input.intent === "signup" ? current : null,
        current,
        Math.min(current + attemptLifetimeMs, proven),
        invitation ? null : handoffId,
        invitation ? handoffId : null
      ),
    ])
  ).pipe(Effect.asVoid);
};
const findStartSource = ({
  environment,
  reference,
  validationTime,
}: Readonly<{
  environment: ProviderEnvironment;
  reference: Option.Option<string>;
  validationTime: number;
}>): Effect.Effect<
  Option.Option<"invitation" | "legacy">,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    if (Option.isNone(reference)) return Option.none();
    const raw = yield* Effect.tryPromise(() =>
      environment.DB.prepare(`SELECT 'invitation' AS kind FROM whatsapp_signup_invitations WHERE id=? AND expires_at_ms>? AND consumed_at_ms IS NULL
 UNION ALL SELECT 'legacy' AS kind FROM whatsapp_provider_handoffs WHERE id=? AND expires_at_ms>? AND consumed_at_ms IS NULL`)
        .bind(reference.value, validationTime, reference.value, validationTime)
        .first()
    );
    const source = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ kind: Schema.Literals(["invitation", "legacy"]) })
    )(raw);
    return Option.some(source.kind);
  });
export const startProvider = ({
  request,
  environment,
  provider,
}: Readonly<{
  request: Request;
  environment: ProviderEnvironment;
  provider: AuthenticationProvider;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const configuration = providerConfiguration({ environment, provider });
    if (!configuration.configured) {
      return providerJson({ body: { status: "unavailable" }, status: unavailableStatus });
    }
    const input = yield* boundedJsonBody({
      request,
      policy: providerBodyPolicy,
      schema: StartProviderAuthentication,
    });
    if (Option.isNone(input)) {
      return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    }
    const disclosure = webSignupDisclosure();
    const validationTime = yield* Clock.currentTimeMillis;
    const source = yield* findStartSource({
      environment,
      reference: Option.fromUndefinedOr(input.value.handoffReference),
      validationTime,
    });
    const legacyChatConsent = Option.contains(source, "legacy");
    const validConsent =
      legacyChatConsent ||
      input.value.intent !== "signup" ||
      input.value.consentRevision === disclosure.revision;
    if (!validConsent) return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    const proven = yield* provePendingBrowserPairing({ db: environment.DB, ...input.value });
    if (Option.isNone(proven)) {
      return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    }
    const { current, state, verifier, nonce, challenge, snapshot } =
      yield* prepareAttempt(disclosure);
    yield* persistAttempt({
      environment,
      provider,
      input: input.value,
      proven: proven.value,
      invitation: Option.contains(source, "invitation"),
      prepared: { current, state, verifier, nonce, challenge, snapshot },
    });
    return startedResponse({ environment, provider, state, nonce, challenge, verifier });
  }).pipe(
    Effect.orElseSucceed(() => providerJson({ body: { status: "invalid" }, status: invalidStatus }))
  );
