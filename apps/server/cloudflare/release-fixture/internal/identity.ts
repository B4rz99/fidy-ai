import { installedOrigins } from "../../../src/shell/browser-transport/contract";
import { Clock, Effect, Option, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair, importPKCS8 } from "jose";
import type { AcceptanceProviderEnvironment } from "../contract";
import { acceptanceSubject } from "../../release-isolation/operations";

const clients = {
  google: {
    id: "fidy-native-google",
    issuer: "https://accounts.google.com",
    keys: "https://www.googleapis.com/oauth2/v3/certs",
    token: "https://oauth2.googleapis.com/token",
  },
  microsoft: {
    id: "fidy-native-microsoft",
    issuer: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
    keys: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  },
} as const;

const ttlMs = 120_000,
  secondMs = 1000,
  kid = "native-acceptance";

const ascii = /^[a-zA-Z0-9_-]{32,128}$/u;

const KeyPair = Schema.Struct({
  privateKey: Schema.NonEmptyString,
  n: Schema.NonEmptyString,
  e: Schema.NonEmptyString,
});

const storedKeys = Effect.fn(function* (env: AcceptanceProviderEnvironment) {
  const key = `_release-smoke/${env.RELEASE_GIT_SHA}/acceptance/oidc`,
    codec = Schema.fromJsonString(KeyPair);

  const prior = yield* Effect.tryPromise(() => env.SMOKE_BUCKET.get(key));

  if (prior !== null) {
    return yield* Schema.decodeEffect(codec)(yield* Effect.tryPromise(() => prior.text()));
  }

  const pair = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
  const jwk = yield* Effect.tryPromise(() => exportJWK(pair.publicKey));

  const generated = yield* Schema.decodeUnknownEffect(KeyPair)({
    privateKey: yield* Effect.tryPromise(() => exportPKCS8(pair.privateKey)),
    n: jwk.n,
    e: jwk.e,
  });

  const encoded = yield* Schema.encodeEffect(codec)(generated);

  const created = yield* Effect.tryPromise(() =>
    env.SMOKE_BUCKET.put(key, encoded, { onlyIf: { etagDoesNotMatch: "*" } })
  );

  if (created !== null) return generated;
  const winner = yield* Effect.tryPromise(() => env.SMOKE_BUCKET.get(key));

  if (winner === null) return yield* Effect.fail("acceptance-signing-key-missing" as const);

  return yield* Schema.decodeEffect(codec)(yield* Effect.tryPromise(() => winner.text()));
});

const Code = Schema.Tuple([
  Schema.Literals(["google", "microsoft"]),
  Schema.Literals(["acceptance", "production"]),
  Schema.NonEmptyString,
  Schema.String.check(Schema.isPattern(ascii)),
  Schema.String.check(Schema.isPattern(ascii)),
  Schema.String.check(Schema.isPattern(/^\d{13}$/u)),
  Schema.NonEmptyString,
]);

const validLifetime = (deadline: number, now: number): boolean =>
  Number.isSafeInteger(deadline) && deadline > now && deadline <= now + ttlMs;

const validExchange = (
  form: URLSearchParams,
  env: AcceptanceProviderEnvironment,
  { provider, host }: { provider: keyof typeof clients; host: keyof typeof installedOrigins }
): boolean =>
  form.get("client_id") === clients[provider].id &&
  form.get("grant_type") === "authorization_code" &&
  env.ACCEPTANCE_API_ORIGIN === installedOrigins.acceptance.api &&
  form.get("redirect_uri") ===
    installedOrigins[host].api + "/providers/" + provider + "/callback" &&
  form.get("client_secret") ===
    (provider === "google" ? env.ACCEPTANCE_GOOGLE_SECRET : env.ACCEPTANCE_MICROSOFT_SECRET);

const validSignature = Effect.fn(function* (parts: readonly string[], secret: string) {
  const mac = Base64Url.decode(parts.at(-1) ?? "");

  if (Result.isFailure(mac)) return false;

  const key = yield* Effect.tryPromise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    )
  );

  return yield* Effect.tryPromise(() =>
    crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(mac.success),
      new TextEncoder().encode(parts.slice(0, -1).join("."))
    )
  );
});

const belongsToProvider = (
  { kind, subject }: { kind: string; subject: string },
  provider: keyof typeof clients,
  env: AcceptanceProviderEnvironment
): boolean =>
  kind === provider &&
  acceptanceSubject({ revision: env.RELEASE_GIT_SHA, issuer: clients[provider].issuer, subject });

const readCode = (
  form: URLSearchParams
): ReturnType<ReturnType<typeof Schema.decodeUnknownOption<typeof Code>>> =>
  Schema.decodeUnknownOption(Code)((form.get("code") ?? "").split("."));

const codeSubject = Effect.fn(function* (
  request: Request,
  env: AcceptanceProviderEnvironment,
  provider: keyof typeof clients
) {
  const form = new URLSearchParams(yield* Effect.tryPromise(() => request.text()));
  const parsed = readCode(form);

  if (Option.isNone(parsed) || !validExchange(form, env, { provider, host: parsed.value[1] })) {
    return;
  }

  const [kind, , subject, nonce, challenge, deadline] = parsed.value,
    now = yield* Clock.currentTimeMillis;

  if (
    !validLifetime(Number(deadline), now) ||
    !belongsToProvider({ kind, subject }, provider, env)
  ) {
    return;
  }

  const digest = yield* Effect.tryPromise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""))
  );

  if (Base64Url.encode(new Uint8Array(digest)) !== challenge) return;

  return (yield* validSignature(parsed.value, env.ACCEPTANCE_CODE_KEY ?? ""))
    ? { subject, nonce, now }
    : undefined;
});

const exchange = Effect.fn(function* (
  request: Request,
  env: AcceptanceProviderEnvironment,
  provider: keyof typeof clients
) {
  const code = yield* codeSubject(request, env, provider);

  if (code === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });

  const keys = yield* storedKeys(env),
    key = yield* Effect.tryPromise(() => importPKCS8(keys.privateKey, "RS256"));

  const subjectClaims = {
    nonce: code.nonce,
    email: code.subject + "@example.test",
    email_verified: true,
  };

  const claims =
    provider === "microsoft"
      ? { ...subjectClaims, ver: "2.0", tid: "9188040d-6c67-4c5b-b112-36a304b66dad" }
      : subjectClaims;

  const issued = Math.floor(code.now / secondMs);

  const token = yield* Effect.tryPromise(() =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject(code.subject)
      .setIssuer(clients[provider].issuer)
      .setAudience(clients[provider].id)
      .setIssuedAt(issued)
      .setExpirationTime(issued + ttlMs / secondMs)
      .sign(key)
  );

  return Response.json({ id_token: token }, { headers: { "cache-control": "no-store" } });
});

const publicKeys = Effect.fn(function* (
  env: AcceptanceProviderEnvironment,
  provider: keyof typeof clients
) {
  const { n, e } = yield* storedKeys(env);
  const signingKey = { kty: "RSA", alg: "RS256", use: "sig", kid, n, e };

  return Response.json(
    {
      keys: [
        provider === "microsoft"
          ? { ...signingKey, issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" }
          : signingKey,
      ],
    },
    { headers: { "cache-control": "no-store" } }
  );
});

export const answerFixtureIdentity = Effect.fn(function* (
  request: Request,
  env: AcceptanceProviderEnvironment
) {
  if ((env.ACCEPTANCE_CODE_KEY ?? "").length === 0) return new Response(null, { status: 503 });

  const [answer] = (["google", "microsoft"] as const).flatMap((provider) => {
    if (request.url === clients[provider].keys && request.method === "GET") {
      return [publicKeys(env, provider)];
    }

    if (request.url === clients[provider].token && request.method === "POST") {
      return [exchange(request, env, provider)];
    }

    return [];
  });

  if (answer === undefined) return new Response(null, { status: 404 });

  return yield* answer;
});
