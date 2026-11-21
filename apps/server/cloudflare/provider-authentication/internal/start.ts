import { providerConfiguration } from "./configuration";
import { Clock, Effect, type PlatformError, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { type AuthenticationProvider } from "../../../src/shell/provider-authentication/contract";
import { DisclosureSnapshot } from "../../../src/core/consent/contract";
import { digestBytes, newSecret } from "../../secret-material/operations";
import type { ProviderConfiguration } from "../contract";

const successStatus = 200;

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
  environment: ProviderConfiguration;
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

export const prepareAttempt = (
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

export const startedResponse = ({
  environment,
  provider,
  state,
  nonce,
  challenge,
  verifier,
}: Readonly<{
  environment: ProviderConfiguration;
  provider: AuthenticationProvider;
  state: string;
  nonce: string;
  challenge: Uint8Array;
  verifier: string;
}>): Response =>
  providerJson({
    body: {
      authorizationUrl: authorizationUrl({
        environment,
        provider,
        state,
        nonce,
        challenge,
      }),
    },
    status: successStatus,
    headers: {
      "set-cookie": `${providerConfiguration({ environment, provider }).cookieName}=${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
