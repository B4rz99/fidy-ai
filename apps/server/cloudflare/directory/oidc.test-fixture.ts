import { WorkerEntrypoint } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Clock, Effect } from "effect";

const millisecondsPerSecond = 1000;
const tokenLifetimeSeconds = 600;
const keyId = "browser-bootstrap-fixture";
const tokens = new Set([
  "https://oauth2.googleapis.com/token",
  "https://login.microsoftonline.com/common/oauth2/v2.0/token",
]);
const certs = new Set([
  "https://www.googleapis.com/oauth2/v3/certs",
  "https://login.microsoftonline.com/common/discovery/v2.0/keys",
]);
const tenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
const enterpriseTenant = "aabbccdd-eeff-4567-8123-1234567890ab";
let stalledLookup = false;
let jwksTenant = "{tenantid}";
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
const providerClaims = (nonce: string, tid: string, scenario: string): Record<string, string> => {
  const claims = {
    nonce: scenario === "nonce" ? "wrong" : nonce,
    ver: scenario === "version" ? "1.0" : "2.0",
    tid: tenantClaims.get(scenario) ?? tid,
    ...(scenario === "missingEmail"
      ? {}
      : { email: scenario === "changedEmail" ? "changed@example.test" : "shared@example.test" }),
  };
  return claims;
};
const issuedToken = ({
  claims,
  issuer,
  subject,
  now,
  scenario,
}: Readonly<{
  claims: Record<string, string>;
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
/** Local signed responses exercise production provider, nonce, lifetime and browser proof checks. */
export class BrowserOidcFixture extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    return Effect.runPromise(
      Effect.gen(function* () {
        if (new URL(request.url).hostname === "api.kapso.ai") {
          if ((yield* Effect.tryPromise(() => request.text())).includes("573001234598")) {
            return new Response(null, { status: 503 });
          }
          return Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.signup" }],
          });
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
