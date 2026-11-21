import { BackupRecoveryCode } from "../../../src/core/recovery/contract";
import { recoveryCodeDigest } from "./material";
import { type JWKSCacheInput, createRemoteJWKSet, customFetch, jwksCache, jwtVerify } from "jose";
import { type OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import { Clock, Data, DateTime, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { OutboundHttpRequest } from "../../../src/shell/outbound-http/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";

const Payload = Schema.Struct({
  pairingCode: Schema.String.check(Schema.isPattern(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u)),
  backupRecoveryCode: BackupRecoveryCode,
});

const Claims = Schema.Struct({
  sub: Schema.String.check(Schema.isNonEmpty()),
  iat: Schema.Int.check(Schema.isGreaterThan(0)),
  exp: Schema.Int.check(Schema.isGreaterThan(0)),
});

type VerifiedOperator = Readonly<{
  issuer: string;
  subject: string;
  issuedAtMs: number;
  expiresAtMs: number;
}>;

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 256,
  deadlineMilliseconds: 2_000,
});

const signingKeysRuntime = ManagedRuntime.make(Layer.empty);

let cachedKeys: Option.Option<Readonly<{ issuer: string; data: JWKSCacheInput }>> = Option.none();

const signingKeys = (
  issuer: string,
  http: OutboundHttpService,
  signal: AbortSignal
): ReturnType<typeof createRemoteJWKSet> => {
  const retained =
    Option.isSome(cachedKeys) && cachedKeys.value.issuer === issuer
      ? cachedKeys.value
      : { issuer, data: {} satisfies JWKSCacheInput };

  cachedKeys = Option.some(retained);

  return createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    [jwksCache]: retained.data,
    [customFetch]: (_url, options): Promise<Response> =>
      signingKeysRuntime.runPromise(
        http.execute(OutboundHttpRequest.CloudflareAccessSigningKeys()).pipe(
          Effect.timeout("5 seconds"),
          Effect.map(
            (response) =>
              new Response(new Uint8Array(response.body), {
                status: response.status,
                headers: { "content-type": "application/json" },
              })
          )
        ),
        { signal: AbortSignal.any([signal, options.signal]) }
      ),
  });
};

const httpBadRequest = 400;

const httpUnauthorized = 401;

const httpTooManyRequests = 429;

const httpServiceUnavailable = 503;

const maximumAssertionLength = 8192;

const maximumAssertionLifetimeSeconds = 900;

const millisecondsPerSecond = 1_000;

const response = (status: number, body: Readonly<{ status: string }>): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const notApproved = (): Response => response(httpBadRequest, { status: "not_approved" });

const unavailable = (): Response => response(httpServiceUnavailable, { status: "unavailable" });

const eligibleAssertion = (
  assertion: Option.Option<string>,
  issuer: string,
  audience: string
): boolean =>
  Option.isSome(assertion) &&
  assertion.value.length > 0 &&
  assertion.value.length <= maximumAssertionLength &&
  /^https:\/\/[^/]+\.cloudflareaccess\.com$/u.test(issuer) &&
  audience.length > 0;

const currentClaims = (claims: Option.Option<typeof Claims.Type>, now: number): boolean =>
  Option.isSome(claims) &&
  claims.value.iat <= now &&
  claims.value.exp > now &&
  claims.value.exp > claims.value.iat &&
  claims.value.exp - claims.value.iat <= maximumAssertionLifetimeSeconds &&
  claims.value.exp - now <= maximumAssertionLifetimeSeconds;

const verifySupportAccess = ({
  assertion,
  issuer,
  audience,
  clock,
  http,
  signal,
}: {
  assertion: Option.Option<string>;
  issuer: string;
  audience: string;
  clock: Clock.Clock;
  http: OutboundHttpService;
  signal: AbortSignal;
}): Promise<Option.Option<VerifiedOperator>> => {
  if (!eligibleAssertion(assertion, issuer, audience) || Option.isNone(assertion)) {
    return Promise.resolve(Option.none());
  }

  return Promise.resolve()
    .then(() =>
      jwtVerify(assertion.value, signingKeys(issuer, http, signal), {
        issuer,
        audience,
        algorithms: ["RS256"],
        get currentDate(): Date {
          return DateTime.toDateUtc(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
        },
      })
    )
    .then(({ payload }) => {
      const claims = Schema.decodeUnknownOption(Claims)(payload);
      const now = Math.floor(clock.currentTimeMillisUnsafe() / millisecondsPerSecond);

      if (!currentClaims(claims, now) || Option.isNone(claims)) {
        return Option.none<VerifiedOperator>();
      }

      return Option.some({
        issuer,
        subject: claims.value.sub,
        issuedAtMs: claims.value.iat * millisecondsPerSecond,
        expiresAtMs: claims.value.exp * millisecondsPerSecond,
      });
    })
    .catch(() => Option.none());
};

type CaseDecision = Readonly<{
  operator: { issuer: string; subject: string };
  codeDigest: Uint8Array;
  publicCode: string;
  now: number;
}>;

const configuredAccess = (config: {
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
}): boolean =>
  config.CLOUDFLARE_ACCESS_ISSUER.length > 0 && config.CLOUDFLARE_ACCESS_AUDIENCE.length > 0;

const admissionResponse = (admission: "limited" | "unavailable"): Response =>
  admission === "limited" ? response(httpTooManyRequests, { status: "limited" }) : unavailable();

class SupportBoundaryFailure extends Data.TaggedError("SupportBoundaryFailure")<{}> {}

const waitFor = <A>(run: () => Promise<A>): Effect.Effect<A, SupportBoundaryFailure> =>
  Effect.tryPromise({
    try: run,
    catch: () => new SupportBoundaryFailure(),
  });

export const handleSupportProof = ({
  request,
  admit,
  approve,
  config,
  http,
}: {
  request: Request;
  admit: (
    operator: VerifiedOperator,
    now: number
  ) => Promise<"allowed" | "limited" | "unavailable">;
  approve: (decision: CaseDecision & { operator: VerifiedOperator }) => Promise<Response>;
  http: OutboundHttpService;
  config: { CLOUDFLARE_ACCESS_ISSUER: string; CLOUDFLARE_ACCESS_AUDIENCE: string };
}): Effect.Effect<Response> => {
  if (!configuredAccess(config)) return Effect.succeed(unavailable());

  return Effect.gen(function* () {
    const clock = yield* Clock.Clock;

    const operator = yield* Effect.tryPromise({
      try: (signal) =>
        verifySupportAccess({
          assertion: Option.fromNullishOr(request.headers.get("cf-access-jwt-assertion")),
          issuer: config.CLOUDFLARE_ACCESS_ISSUER,
          audience: config.CLOUDFLARE_ACCESS_AUDIENCE,
          clock,
          http,
          signal: AbortSignal.any([signal, request.signal]),
        }),
      catch: () => new SupportBoundaryFailure(),
    });

    if (Option.isNone(operator)) return response(httpUnauthorized, { status: "unauthorized" });
    const now = yield* Clock.currentTimeMillis;
    const admission = yield* waitFor(() => admit(operator.value, now));

    if (admission !== "allowed") return admissionResponse(admission);
    const payload = yield* boundedJsonBody({ request, policy, schema: Payload });

    if (Option.isNone(payload)) return notApproved();
    const codeDigest = yield* waitFor(() => recoveryCodeDigest(payload.value.backupRecoveryCode));
    const decisionAt = yield* Clock.currentTimeMillis;

    if (operator.value.expiresAtMs <= decisionAt || operator.value.issuedAtMs > decisionAt) {
      return response(httpUnauthorized, { status: "unauthorized" });
    }

    const decision = {
      operator: operator.value,
      codeDigest,
      publicCode: payload.value.pairingCode,
      now: decisionAt,
    };

    return yield* waitFor(() => approve(decision));
  }).pipe(Effect.catchTag("SupportBoundaryFailure", () => Effect.succeed(unavailable())));
};
