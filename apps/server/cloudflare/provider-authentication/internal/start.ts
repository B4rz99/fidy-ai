import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { StartGoogleAuthentication } from "../../../src/shell/provider-authentication/contract";
import { DisclosureSnapshot } from "../../../src/core/consent/contract";
import { webSignupDisclosure } from "../../../src/shell/consent/operations";
import { provePendingBrowserPairing } from "../../browser-login/operations";
import { digestBytes, newSecret } from "../../secret-material/operations";
import { boundedJsonBody } from "../../http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import type { GoogleEnvironment } from "../contract";

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
export const cookieName = "__Host-fidy_google";
const expectedCallback = (origin: string): string => {
  if (origin === "https://app.fidyapp.com") {
    return "https://api.fidyapp.com/providers/google/callback";
  }
  if (origin === "https://127.0.0.1:4173") {
    return "https://127.0.0.1:4174/providers/google/callback";
  }
  return "http://localhost:8787/providers/google/callback";
};
export const configuredGoogle = (environment: GoogleEnvironment): boolean =>
  (environment.GOOGLE_CLIENT_ID ?? "").length > 0 &&
  (environment.GOOGLE_CLIENT_SECRET ?? "").length > 0 &&
  environment.GOOGLE_REDIRECT_URI === expectedCallback(environment.BROWSER_ORIGIN);
const authorizationUrl = ({
  environment,
  state,
  nonce,
  challenge,
}: Readonly<{
  environment: GoogleEnvironment;
  state: string;
  nonce: string;
  challenge: Uint8Array;
}>): string => {
  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: environment.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: environment.GOOGLE_REDIRECT_URI ?? "",
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: Base64Url.encode(challenge),
    code_challenge_method: "S256",
  }).toString();
  return authorization.href;
};
export const startGoogle = ({
  request,
  environment,
}: Readonly<{ request: Request; environment: GoogleEnvironment }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!configuredGoogle(environment)) {
      return providerJson({ body: { status: "unavailable" }, status: unavailableStatus });
    }
    const input = yield* boundedJsonBody({
      request,
      policy: providerBodyPolicy,
      schema: StartGoogleAuthentication,
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
    const current = yield* Clock.currentTimeMillis;
    const state = Redacted.value(yield* newSecret);
    const verifier = Redacted.value(yield* newSecret);
    const nonce = Redacted.value(yield* newSecret);
    const challenge = yield* digestBytes(new TextEncoder().encode(verifier));
    const snapshot = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
      disclosure
    );
    yield* Effect.tryPromise(() =>
      environment.DB.prepare(`INSERT INTO provider_authentication_attempts
      (id,pairing_id,cookie_digest,nonce,intent,disclosure_json,consent_at_ms,created_at_ms,expires_at_ms,state)
      VALUES(?,?,?,?,?,?,?,?,?,'pending')`)
        .bind(
          state,
          input.value.pairingId,
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
    return providerJson({
      body: { authorizationUrl: authorizationUrl({ environment, state, nonce, challenge }) },
      status: successStatus,
      headers: {
        "set-cookie": `${cookieName}=${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  }).pipe(
    Effect.orElseSucceed(() => providerJson({ body: { status: "invalid" }, status: invalidStatus }))
  );
