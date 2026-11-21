import { sampleOutcome, sampleReply, sampleStatus } from "./sample-response";
import { withdrawArtifact } from "./sample-publication";
import { Clock, Effect, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { SampleReviewCommand } from "../../../src/core/ingestion/contract";
import { accessSigningKeysOutboundHttp } from "../../../src/shell/outbound-http/operations";
import type { CoreHttpEnvironment } from "../../core-http/contract";
import { boundedJsonBody } from "../../http/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { authenticateOperator } from "../../operator-access/operations";
import { localSampleReviewUrl } from "../contract";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 5000,
});

const admissionLifetime = 5000;

const authenticateReviewer = Effect.fn(function* (
  request: Request,
  environment: CoreHttpEnvironment,
  issuer: string
) {
  const reviewerEmail = environment.SAMPLE_REVIEWER_EMAIL ?? "";

  if (reviewerEmail === "") return Option.none();

  return yield* authenticateOperator({
    request,
    configuration: {
      issuer,
      requiredEmail: Option.some(reviewerEmail),
      audience: environment.SAMPLE_REVIEW_AUDIENCE ?? "",
      otherAudiences: [
        environment.BETA_PRO_AUDIENCE ?? "",
        environment.CLOUDFLARE_ACCESS_AUDIENCE,
        environment.BILLING_SUPPORT_AUDIENCE ?? "",
        environment.PRICING_PUBLISH_AUDIENCE ?? "",
        environment.ERASURE_SUPPORT_AUDIENCE ?? "",
      ],
    },
    http: accessSigningKeysOutboundHttp({ issuer, httpClient: yield* HttpClient.HttpClient }),
  });
});

const dispatch = Effect.fn(function* (
  input: typeof SampleReviewCommand.Type,
  environment: CoreHttpEnvironment,
  { operator, now }: { operator: { operatorRef: string; expiresAtMs: number }; now: number }
) {
  const issuer = environment.CLOUDFLARE_ACCESS_ISSUER;

  const authority = {
    permission: "ingestion.reviewSample",
    issuer,
    operator: operator.operatorRef,
    deadline: Math.min(now + admissionLifetime, operator.expiresAtMs),
  };

  if (input.action === "withdraw") {
    const { EMAIL_BUCKET, SAMPLE_BUCKET } = environment;

    if (EMAIL_BUCKET === undefined || SAMPLE_BUCKET === undefined) {
      return sampleReply(sampleStatus.unavailable);
    }

    yield* withdrawArtifact(
      input.sampleId,
      { EMAIL_BUCKET, SAMPLE_BUCKET },
      { issuer, operator: operator.operatorRef, at: now }
    );

    return sampleOutcome({ status: "withdrawn" });
  }

  const owner = environment.USER_STORE;

  if (owner === undefined) return sampleReply(sampleStatus.unavailable);

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    command: input,
    authority,
  });

  return yield* Effect.tryPromise(() =>
    owner.getByName(input.userId).fetch(localSampleReviewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encoded,
    })
  );
});

export const reviewRequest = Effect.fn(
  function* (request: Request, environment: CoreHttpEnvironment) {
    if (
      request.method !== "POST" ||
      request.headers.has("origin") ||
      new URL(request.url).search !== ""
    ) {
      return sampleReply(sampleStatus.forbidden);
    }

    const issuer = environment.CLOUDFLARE_ACCESS_ISSUER;
    const operator = yield* authenticateReviewer(request, environment, issuer);

    if (Option.isNone(operator)) return sampleReply(sampleStatus.unauthorized);
    const body = yield* boundedJsonBody({ request, policy, schema: Schema.Unknown });

    const command = Option.flatMap(
      body,
      Schema.decodeUnknownOption(SampleReviewCommand, { onExcessProperty: "error" })
    );

    if (Option.isNone(command)) return sampleReply(sampleStatus.invalid);
    const now = yield* Clock.currentTimeMillis;

    if (now >= operator.value.expiresAtMs) return sampleReply(sampleStatus.unauthorized);

    return yield* dispatch(command.value, environment, { operator: operator.value, now });
  },
  Effect.orElseSucceed(() => sampleReply(sampleStatus.unavailable))
);
