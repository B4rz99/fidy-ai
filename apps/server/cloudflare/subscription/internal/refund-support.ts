import { captureTraceHeaders } from "../../runtime/telemetry/operations";
import { OutboundHttpRequest } from "../../../src/shell/outbound-http/contract";
import { type JWKSCacheInput, createRemoteJWKSet, customFetch, jwksCache, jwtVerify } from "jose";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { StartRefundInput } from "../../../src/core/subscription/contract";
import { type OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import {
  type RefundAuthority,
  RefundRead,
  RefundSupportAdmission,
  type RefundSupportEnvironment,
  maximumRefundOperatorIdLength,
} from "../contract";
import { refundFailureResponse } from "./refund-http-response";

const boundaryRuntime = ManagedRuntime.make(Layer.empty);

const RefundReadTarget = Schema.Struct({
  userId: RefundRead.fields.userId,
  refundAttemptId: RefundRead.fields.refundAttemptId,
});

const maximumAssertionCharacters = 8192;

const millisecondsPerSecond = 1000;

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 4096,
  deadlineMilliseconds: 5000,
});

const Claims = Schema.Struct({
  sub: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumRefundOperatorIdLength)),
  exp: Schema.Int,
  email: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/u)),
});

type KeyLookup = ReturnType<typeof createRemoteJWKSet>;

let cachedKeyData: Option.Option<Readonly<{ issuer: string; data: JWKSCacheInput }>> =
  Option.none();

const signingKeys = (issuer: string, http: OutboundHttpService, signal: AbortSignal): KeyLookup => {
  const retained =
    Option.isSome(cachedKeyData) && cachedKeyData.value.issuer === issuer
      ? cachedKeyData.value
      : { issuer, data: {} satisfies JWKSCacheInput };

  cachedKeyData = Option.some(retained);

  return createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    [jwksCache]: retained.data,
    [customFetch]: (_url, options): Promise<Response> =>
      boundaryRuntime.runPromise(
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

const validSupportConfiguration = (environment: RefundSupportEnvironment): boolean =>
  /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(environment.CLOUDFLARE_ACCESS_ISSUER) &&
  (environment.BILLING_SUPPORT_AUDIENCE ?? "").length > 0 &&
  environment.BILLING_SUPPORT_AUDIENCE !== environment.BETA_PRO_AUDIENCE &&
  environment.BILLING_SUPPORT_AUDIENCE !== environment.CLOUDFLARE_ACCESS_AUDIENCE;

const userPathPosition = -2;

const authorize = (
  input: Readonly<{
    request: Request;
    environment: RefundSupportEnvironment;
    http: OutboundHttpService;
  }>
): Effect.Effect<Option.Option<RefundAuthority>> =>
  Effect.gen(function* () {
    const { environment, request } = input;
    const audience = environment.BILLING_SUPPORT_AUDIENCE ?? "";
    const issuer = environment.CLOUDFLARE_ACCESS_ISSUER;
    const token = request.headers.get("cf-access-jwt-assertion") ?? "";

    if (
      !validSupportConfiguration(environment) ||
      token.length === 0 ||
      token.length > maximumAssertionCharacters
    ) {
      return Option.none();
    }

    const verified = yield* Effect.tryPromise((signal) =>
      jwtVerify(token, signingKeys(issuer, input.http, signal), {
        issuer,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat", "email"],
        clockTolerance: 0,
      })
    );

    if (verified.payload["common_name"] !== undefined) return Option.none();
    const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload);

    return Option.some({
      operatorId: claims.sub,
      expiresAtMs: claims.exp * millisecondsPerSecond,
      permission: "billing.refund" as const,
    });
  }).pipe(Effect.tapError(Effect.logDebug), Effect.orElseSucceed(Option.none));

const routeOwner = Effect.fnUntraced(function* (
  environment: RefundSupportEnvironment,
  user: string,
  body: string
) {
  const owners = environment.USER_STORE;

  if (owners === undefined) return refundFailureResponse("unavailable");
  const trace = yield* captureTraceHeaders;

  return yield* Effect.tryPromise((signal) =>
    owners.getByName(user).fetch(
      new Request("https://user.invalid/billing/refund-support", {
        method: "POST",
        headers: { "content-type": "application/json", ...trace },
        body,
        signal,
      })
    )
  );
});

const submit = (
  input: Readonly<{
    request: Request;
    environment: RefundSupportEnvironment;
    authority: RefundAuthority;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const body = yield* boundedJsonBody({
      request: input.request,
      policy: bodyPolicy,
      schema: StartRefundInput,
    });

    if (Option.isNone(body)) {
      return Response.json(
        { error: { code: "invalid-request" } },
        { status: 400, headers: { "cache-control": "no-store" } }
      );
    }

    const encodedInput = yield* Schema.encodeEffect(StartRefundInput)(body.value);

    const admission = RefundSupportAdmission.make({
      authority: input.authority,
      input: encodedInput,
    });

    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RefundSupportAdmission))(
      admission
    );

    return yield* routeOwner(input.environment, body.value.userId, encoded);
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.orElseSucceed(() => refundFailureResponse("unavailable"))
  );

export const handleRefundSupport = (
  input: Readonly<{
    request: Request;
    environment: RefundSupportEnvironment;
    http: OutboundHttpService;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const authority = yield* authorize(input);

    if (Option.isNone(authority)) {
      return Response.json(
        { error: { code: "unauthenticated" } },
        { status: 401, headers: { "cache-control": "no-store" } }
      );
    }

    const path = new URL(input.request.url).pathname;

    if (path === "/internal/support/billing-refunds" && input.request.method === "POST") {
      return yield* submit({ ...input, authority: authority.value });
    }

    if (input.request.method !== "GET") {
      return Response.json({ error: { code: "method-not-allowed" } }, { status: 405 });
    }

    const userId = path.split("/").at(userPathPosition) ?? "";
    const refundAttemptId = path.split("/").at(-1) ?? "";

    const read = Schema.decodeOption(RefundReadTarget)({ userId, refundAttemptId }).pipe(
      Option.flatMap((target) => RefundRead.makeOption({ authority: authority.value, ...target }))
    );

    if (Option.isNone(read)) return refundFailureResponse("charge-unavailable");
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(RefundRead))(read.value);

    return yield* routeOwner(input.environment, userId, body);
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.orElseSucceed(() => refundFailureResponse("unavailable"))
  );
