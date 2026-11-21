import { WorkerEntrypoint } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Clock, Effect, Option, Schema } from "effect";

const millisecondsPerSecond = 1000;

const tokenLifetimeSeconds = 600;

const keyId = "browser-bootstrap-fixture";

const tokens = new Set([
  "https://oauth2.googleapis.com/token",
  "https://login.microsoftonline.com/common/oauth2/v2.0/token",
]);

const redirectedKeyTarget = "https://fixture.cloudflareaccess.com/followed-keys";

const certs = new Set([
  redirectedKeyTarget,
  "https://fixture.cloudflareaccess.com/cdn-cgi/access/certs",
  "https://www.googleapis.com/oauth2/v3/certs",
  "https://login.microsoftonline.com/common/discovery/v2.0/keys",
]);

const tenant = "9188040d-6c67-4c5b-b112-36a304b66dad";

const enterpriseTenant = "aabbccdd-eeff-4567-8123-1234567890ab";

let stalledLookup = false;

let redirectedKeys = 0;

let jwksTenant = "{tenantid}";

const messages = new Map<string, Array<string>>();

const keyCache = new Map<string, ReturnType<typeof generateKeyPair>>();

const signingKeys = (id: string): ReturnType<typeof generateKeyPair> => {
  const existing = keyCache.get(id);

  if (existing !== undefined) return existing;
  const generated = generateKeyPair("RS256", { extractable: true });
  keyCache.set(id, generated);

  return generated;
};

const issuerOf = (company: string): string => `https://login.microsoftonline.com/${company}/v2.0`;

const futureIssuedAt = 4102444800;

const tenantClaims = new Map([
  ["invalidTenant", "not-a-guid"],
  ["foreignTenant", enterpriseTenant],
]);

type BaseClaims = Readonly<{ nonce: string; ver: string; tid: string }>;

type ProviderClaims = BaseClaims | (BaseClaims & Readonly<{ email: string }>);

const providerClaims = (nonce: string, tid: string, scenario: string): ProviderClaims => {
  const claims = {
    nonce: scenario === "nonce" ? "wrong" : nonce,
    ver: scenario === "version" ? "1.0" : "2.0",
    tid: tenantClaims.get(scenario) ?? tid,
  };

  if (scenario === "missingEmail") return claims;

  return {
    ...claims,
    email: scenario === "changedEmail" ? "changed@example.test" : "shared@example.test",
  };
};

const issuedToken = ({
  claims,
  issuer,
  subject,
  now,
  scenario,
}: Readonly<{
  claims: ProviderClaims;
  issuer: string;
  subject: string;
  now: number;
  scenario: string;
}>): SignJWT =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(scenario === "issuer" ? "https://invalid.example" : issuer)
    .setAudience(scenario === "audience" ? "another-client" : "test-browser-client")
    .setSubject(scenario === "emptySubject" ? "" : subject)
    .setIssuedAt(scenario === "future" ? futureIssuedAt : now)
    .setExpirationTime(scenario === "expiry" ? now - 100 : now + tokenLifetimeSeconds);

const makeToken = Effect.fn(function* (request: Request) {
  const form = new URLSearchParams(yield* Effect.tryPromise(() => request.text()));
  const [nonce, subject, scenario = "valid"] = (form.get("code") ?? "").split(".");

  if (nonce === undefined || subject === undefined) return new Response(null, { status: 400 });

  if (scenario === "deny") return Response.json({ error: "invalid_grant" }, { status: 400 });
  stalledLookup = scenario === "timeout";
  jwksTenant = scenario === "keyIssuer" ? enterpriseTenant : "{tenantid}";

  const issuerFor = (company: string): string =>
    new URL(request.url).hostname === "login.microsoftonline.com"
      ? issuerOf(company)
      : "https://accounts.google.com";

  const tid = scenario === "enterprise" ? enterpriseTenant : tenant;
  const issuer = issuerFor(tid);
  const claims = providerClaims(nonce, tid, scenario);
  const now = Math.floor((yield* Clock.currentTimeMillis) / millisecondsPerSecond);

  const keys = yield* Effect.tryPromise(() =>
    signingKeys(scenario === "signature" ? "other" : keyId)
  );

  const jwt = yield* Effect.tryPromise(() =>
    issuedToken({ claims, issuer, subject, now, scenario }).sign(keys.privateKey)
  );

  return Response.json({ id_token: jwt });
});

const acceptMail = Effect.fn(function* (request: Request) {
  const body = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ to: Schema.Array(Schema.String), text: Schema.String })
  )(yield* Effect.tryPromise(() => request.json()));

  for (const address of body.to) {
    const delivered = messages.get(address) ?? [];
    messages.set(address, [...delivered, body.text]);
  }

  if (body.to.includes("lost@example.test")) throw new Error("Lost provider reply");

  if (body.to.includes("limited@example.test")) {
    return Option.some(Response.json({}, { status: 429 }));
  }

  return Option.some(Response.json({ id: "fixture-delivery" }));
});

const operatorApplications = new Map([
  ["/beta-assertion", { email: "beta@example.test", audience: "fixture-beta" }],
  ["/support-assertion", { email: "operator@example.test", audience: "fixture-support" }],
  ["/reviewer-assertion", { email: "reviewer@example.test", audience: "fixture-review" }],
  ["/erasure-assertion", { email: "obarboza@fidyapp.com", audience: "fixture-erasure" }],
]);

const supportAndMailbox = Effect.fn(function* (request: Request) {
  if (request.url === "https://api.resend.com/emails") return yield* acceptMail(request);

  if (new URL(request.url).hostname === "mailbox.fixture.invalid") {
    return Option.some(
      Response.json(messages.get(new URL(request.url).searchParams.get("to") ?? "") ?? [])
    );
  }

  const url = new URL(request.url);
  const application = operatorApplications.get(url.pathname);
  const scenario = url.searchParams.get("scenario");

  if (url.hostname === "fixture.invalid" && application !== undefined) {
    const keys = yield* Effect.tryPromise(() => signingKeys(keyId));
    const now = Math.floor((yield* Clock.currentTimeMillis) / millisecondsPerSecond);

    return Option.some(
      new Response(
        yield* Effect.tryPromise(() =>
          new SignJWT({
            type: scenario === "organization" ? "org" : "app",
            email: scenario === "unassigned" ? "operator@example.test" : application.email,
          })
            .setProtectedHeader({ alg: "RS256", kid: keyId })
            .setIssuer(
              scenario === "redirected-issuer"
                ? "https://redirected.cloudflareaccess.com"
                : "https://fixture.cloudflareaccess.com"
            )
            .setAudience(
              scenario === "multiple"
                ? ["fixture-review", "fixture-support"]
                : [application.audience]
            )
            .setSubject("fixture-operator")
            .setIssuedAt(now)
            .setExpirationTime(now + tokenLifetimeSeconds)
            .sign(keys.privateKey)
        )
      )
    );
  }

  return Option.none<Response>();
});

const invitationReply = Effect.fn(function* (request: Request) {
  const message = yield* Effect.tryPromise(() => request.text());

  if (message.includes("573001234599")) {
    return Response.json({ error: "invalid recipient" }, { status: 403 });
  }

  if (message.includes("573001234598")) {
    return new Response(null, { status: 503 });
  }

  return Response.json({
    messaging_product: "whatsapp",
    messages: [{ id: "wamid.signup" }],
  });
});

const redirectStatus = 302;

const redirectedIssuerResponse = (url: string): Option.Option<Response> => {
  if (url === "https://redirected.cloudflareaccess.com/cdn-cgi/access/certs") {
    return Option.some(Response.redirect(redirectedKeyTarget, redirectStatus));
  }

  if (url === "https://fixture.invalid/followed-key-count") {
    return Option.some(Response.json(redirectedKeys));
  }

  if (url === redirectedKeyTarget) redirectedKeys += 1;

  return Option.none();
};

export class BrowserOidcFixture extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const redirect = redirectedIssuerResponse(request.url);

        if (Option.isSome(redirect)) return redirect.value;
        const simulated = yield* supportAndMailbox(request);

        if (Option.isSome(simulated)) return simulated.value;

        if (new URL(request.url).hostname === "api.kapso.ai") {
          return yield* invitationReply(request);
        }

        if (tokens.has(request.url) && request.method === "POST") return yield* makeToken(request);

        if (!certs.has(request.url)) return new Response(null, { status: 404 });

        if (stalledLookup) yield* Effect.sleep("30 seconds");
        const keys = yield* Effect.tryPromise(() => signingKeys(keyId));
        const jwk = yield* Effect.tryPromise(() => exportJWK(keys.publicKey));

        return Response.json({
          keys: [{ ...jwk, kid: keyId, alg: "RS256", use: "sig", issuer: issuerOf(jwksTenant) }],
        });
      })
    );
  }
}
