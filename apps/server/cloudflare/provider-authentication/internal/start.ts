import { providerConfiguration } from "./configuration";
import { Clock, Effect, Option, type PlatformError, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import {
  type AuthenticationProvider,
  StartProviderAuthentication,
} from "../../../src/shell/provider-authentication/contract";
import { DisclosureSnapshot } from "../../../src/core/consent/contract";
import { webSignupDisclosure } from "../../../src/shell/consent/operations";
import { provePendingBrowserPairing } from "../../browser-login/operations";
import { digestBytes, newSecret } from "../../secret-material/operations";
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
    if (input.value.intent === "signup" && input.value.consentRevision !== disclosure.revision) {
      return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    }
    const proven = yield* provePendingBrowserPairing({ db: environment.DB, ...input.value });
    if (Option.isNone(proven)) {
      return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    }
    const { current, state, verifier, nonce, challenge, snapshot } =
      yield* prepareAttempt(disclosure);
    yield* Effect.tryPromise(() =>
      environment.DB.prepare(`INSERT INTO provider_authentication_attempts
      (id,pairing_id,provider,cookie_digest,nonce,intent,disclosure_json,consent_at_ms,created_at_ms,expires_at_ms,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,'pending')`)
        .bind(
          state,
          input.value.pairingId,
          provider,
          challenge,
          nonce,
          input.value.intent,
          input.value.intent === "signup" ? snapshot : null,
          input.value.intent === "signup" ? current : null,
          current,
          Math.min(current + attemptLifetimeMs, proven.value)
        )
        .run()
    );
    return startedResponse({ environment, provider, state, nonce, challenge, verifier });
  }).pipe(
    Effect.orElseSucceed(() => providerJson({ body: { status: "invalid" }, status: invalidStatus }))
  );
