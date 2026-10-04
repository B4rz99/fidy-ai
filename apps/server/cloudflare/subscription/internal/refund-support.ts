import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { Effect, Option, Schema } from "effect";
import { StartRefundInput } from "../../../src/core/subscription/contract";
import { type OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import {
  type RefundAuthority,
  RefundSupportAdmission,
  type RefundSupportEnvironment,
  maximumRefundOperatorIdLength,
} from "../contract";
import { getRefund } from "./refund-acceptance";
import { refundFailureResponse, refundResultResponse } from "./refund-http-response";

const maximumAssertionCharacters = 8192;
const millisecondsPerSecond = 1000;
const readStatus = 200;
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
let cachedKeys: Option.Option<Readonly<{ issuer: string; keys: KeyLookup }>> = Option.none();
const signingKeys = (issuer: string, http: OutboundHttpService): KeyLookup => {
  if (Option.isSome(cachedKeys) && cachedKeys.value.issuer === issuer) return cachedKeys.value.keys;
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    [customFetch]: () =>
      Effect.runPromise(
        http.execute({ _tag: "CloudflareAccessSigningKeys" }).pipe(
          Effect.timeout("5 seconds"),
          Effect.map(
            (response) =>
              new Response(new Uint8Array(response.body), {
                status: response.status,
                headers: { "content-type": "application/json" },
              })
          )
        )
      ),
  });
  cachedKeys = Option.some({ issuer, keys });
  return keys;
};
const validSupportConfiguration = (environment: RefundSupportEnvironment): boolean =>
  /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(environment.CLOUDFLARE_ACCESS_ISSUER) &&
  (environment.BILLING_SUPPORT_AUDIENCE ?? "").length > 0 &&
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
    const verified = yield* Effect.tryPromise(() =>
      jwtVerify(token, signingKeys(issuer, input.http), {
        issuer,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat", "email"],
        clockTolerance: 0,
      })
    );
    // Service-token assertions cannot become attributable human refund permission.
    if (verified.payload["common_name"] !== undefined) return Option.none();
    const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload);
    return Option.some({
      operatorId: claims.sub,
      expiresAtMs: claims.exp * millisecondsPerSecond,
      permission: "billing.refund" as const,
    });
  }).pipe(Effect.catch(() => Effect.succeedNone));
const submit = (
  input: Readonly<{
    request: Request;
    environment: RefundSupportEnvironment;
    authority: RefundAuthority;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const body = yield* Effect.tryPromise(() =>
      boundedJsonBody({
        request: input.request,
        policy: bodyPolicy,
        schema: Schema.toEncoded(StartRefundInput),
      })
    );
    if (Option.isNone(body)) {
      return Response.json(
        { error: { code: "invalid-request" } },
        { status: 400, headers: { "cache-control": "no-store" } }
      );
    }
    const admission = RefundSupportAdmission.make({
      _tag: "BillingRefundSupport",
      authority: input.authority,
      input: body.value,
    });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RefundSupportAdmission))(
      admission
    );
    const response = yield* Effect.tryPromise(() =>
      input.environment.USER_TRANSACTION_COORDINATOR.getByName(body.value.userId).fetch(
        new Request("https://coordinator.internal/billing-refund-work", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encoded,
        })
      )
    );
    // Acceptance is already durable. Cron owns publication, so no failed handoff can reverse it.
    return response;
  }).pipe(Effect.orElseSucceed(() => refundFailureResponse("unavailable")));
/** Authentication is reverified at Core even when Access/ingress has already checked the assertion. */
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
    return yield* refundResultResponse({
      status: readStatus,
      result: getRefund({
        db: input.environment.DB,
        authority: authority.value,
        userId,
        refundAttemptId,
      }),
    });
  });
