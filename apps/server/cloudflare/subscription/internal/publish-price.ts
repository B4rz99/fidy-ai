import { Data, Effect, Option, Schema } from "effect";
import type { OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { authenticateOperator } from "../../operator-access/operations";
import {
  AdmittedPricePublication,
  PricePublication,
  type PricingEnvironment,
  pricingName,
} from "../contract";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 4096,
  deadlineMilliseconds: 5000,
});

class PricingOwnerUnbound extends Data.TaggedError("PricingOwnerUnbound") {}

export const pricingPeerAudiences = (environment: PricingEnvironment): ReadonlyArray<string> => [
  Option.getOrElse(Option.fromNullishOr(environment.BETA_PRO_AUDIENCE), () => ""),
  environment.CLOUDFLARE_ACCESS_AUDIENCE,
  environment.BILLING_SUPPORT_AUDIENCE ?? "",
  environment.ERASURE_SUPPORT_AUDIENCE ?? "",
  environment.SAMPLE_REVIEW_AUDIENCE ?? "",
];

const validRequest = (request: Request): boolean =>
  request.method === "POST" && !request.headers.has("origin") && new URL(request.url).search === "";

export const publishPrice = (
  input: Readonly<{ request: Request; environment: PricingEnvironment; http: OutboundHttpService }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { request, environment } = input;

    if (!validRequest(request)) {
      return new Response(null, { status: 403 });
    }

    const issuer = environment.CLOUDFLARE_ACCESS_ISSUER;

    const operator = yield* authenticateOperator({
      request,
      configuration: {
        issuer,
        requiredEmail: Option.none(),
        audience: environment.PRICING_PUBLISH_AUDIENCE ?? "",
        otherAudiences: pricingPeerAudiences(environment),
      },
      http: input.http,
    });

    if (Option.isNone(operator)) return new Response(null, { status: 401 });
    const body = yield* boundedJsonBody({ request, policy, schema: PricePublication });

    if (Option.isNone(body)) return new Response(null, { status: 400 });
    const owner = environment.PRICING;

    if (owner === undefined) return yield* new PricingOwnerUnbound();

    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(AdmittedPricePublication))({
      ...body.value,
      authority: {
        permission: "pricing.publish",
        operatorId: operator.value.operatorRef,
        expiresAtMs: operator.value.expiresAtMs,
      },
    });

    return yield* Effect.tryPromise(() =>
      owner.getByName(pricingName).fetch("https://pricing.internal/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encoded,
        signal: request.signal,
      })
    );
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.orElseSucceed(() => new Response(null, { status: 503 }))
  );
