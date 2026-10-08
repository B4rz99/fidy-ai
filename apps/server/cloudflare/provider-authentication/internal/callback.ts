import { Clock, Effect, Option, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { digestBytes } from "../../secret-material/operations";
import type { ProviderEnvironment } from "../contract";
import { providerConfiguration } from "./configuration";
import { validateGoogleToken } from "./google-token";
import { validateMicrosoftToken } from "./microsoft-token";
import type { Validation } from "./token-contract";
import type { AuthenticationProvider } from "../../../src/shell/provider-authentication/contract";

const redirectStatus = 303;
const maximumCodeLength = 4096;
const Attempt = Schema.Struct({
  id: Schema.String,
  nonce: Schema.String,
  expires_at_ms: Schema.Int,
});
const validCode = (query: URLSearchParams): boolean => {
  const code = query.get("code") ?? "";
  return (
    !query.has("error") &&
    code.length > 0 &&
    code.length <= maximumCodeLength &&
    query.getAll("code").length === 1
  );
};
const cookieVerifier = (request: Request, cookieName: string): Option.Option<string> => {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  if (values.length !== 1) return Option.none();
  const value = values[0]?.slice(cookieName.length + 1) ?? "";
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? Option.some(value) : Option.none();
};
const verifyAttempt = (input: Validation): Effect.Effect<void, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (!validCode(input.query)) return yield* Effect.fail("invalid" as const);
    const identity = yield* input.provider === "google"
      ? validateGoogleToken(input)
      : validateMicrosoftToken(input);
    const settled = yield* Clock.currentTimeMillis;
    const changed = yield* Effect.tryPromise(() =>
      input.environment.DB.prepare(
        `UPDATE provider_authentication_attempts SET state='verified',issuer=?,subject=?,contact_email=?,expires_at_ms=MIN(expires_at_ms,?) WHERE id=? AND state='exchanging' AND expires_at_ms>?`
      )
        .bind(
          identity.issuer,
          identity.subject,
          Option.getOrNull(identity.contactEmail),
          identity.expiresAtMs,
          input.attempt.id,
          settled
        )
        .run()
    );
    if (changed.meta.changes !== 1) {
      return yield* Effect.fail("invalid" as const);
    }
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catch(() =>
      Effect.tryPromise(() =>
        input.environment.DB.prepare(
          "UPDATE provider_authentication_attempts SET state='rejected' WHERE id=? AND state='exchanging'"
        )
          .bind(input.attempt.id)
          .run()
      ).pipe(
        Effect.asVoid,
        Effect.orElseSucceed(() => undefined)
      )
    )
  );
const callbackRedirect = (
  environment: ProviderEnvironment,
  provider: AuthenticationProvider,
  clearCookie = false
): Response =>
  new Response(null, {
    status: redirectStatus,
    headers: {
      location: `${environment.BROWSER_ORIGIN}/auth/${provider}-return`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...(clearCookie
        ? {
            "set-cookie": `${providerConfiguration({ environment, provider }).cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          }
        : {}),
    },
  });
export const providerCallback = ({
  request,
  environment,
  provider,
}: Readonly<{
  request: Request;
  environment: ProviderEnvironment;
  provider: AuthenticationProvider;
}>): Effect.Effect<Response, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (!providerConfiguration({ environment, provider }).configured) {
      return callbackRedirect(environment, provider);
    }
    const query = new URL(request.url).searchParams;
    const state = query.get("state") ?? "";
    const cookie = cookieVerifier(
      request,
      providerConfiguration({ environment, provider }).cookieName
    );
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
      Option.isNone(cookie) ||
      query.getAll("state").length !== 1
    ) {
      return callbackRedirect(environment, provider);
    }
    const current = yield* Clock.currentTimeMillis;
    const digest = yield* digestBytes(new TextEncoder().encode(cookie.value));
    const row = yield* Effect.tryPromise(() =>
      environment.DB.prepare(`UPDATE provider_authentication_attempts SET state = 'exchanging'
    WHERE id = ? AND provider = ? AND cookie_digest = ? AND state = 'pending' AND expires_at_ms > ?
    RETURNING id,nonce,expires_at_ms`)
        .bind(state, provider, digest, current)
        .first()
    );
    const attempt = yield* Schema.decodeUnknownEffect(Attempt)(row);
    yield* verifyAttempt({
      environment,
      provider,
      query,
      verifier: cookie.value,
      attempt,
      current,
    });
    return callbackRedirect(environment, provider, true);
  }).pipe(Effect.orElseSucceed(() => callbackRedirect(environment, provider)));
