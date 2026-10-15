import { Data, Effect, Option, Redacted, Schema } from "effect";
import { DaviplataOtpPolicy, type PaymentEnrollment } from "../../src/core/subscription/contract";
import { UnknownJsonString } from "../../src/shell/schema-codecs/contract";
import type { OutboundHttpResponse } from "../../src/shell/outbound-http/contract";
import type { OutboundHttpService } from "../../src/shell/outbound-http/operations";

/** Live proof failures contain no provider payload, identity, URL, token or underlying cause. */
export class DaviplataSandboxProofFailure extends Data.TaggedError("DaviplataSandboxProofFailure")<{
  readonly stage:
    | "configuration"
    | "policy"
    | "enrollment"
    | "tokenization-request"
    | "tokenization-response"
    | "destinations"
    | "otp-send-request"
    | "otp-send-response"
    | "otp-send-identity"
    | "otp-confirm-request"
    | "otp-confirm-response"
    | "otp-confirm-identity"
    | "preparation"
    | "submission"
    | "source-recovery"
    | "source-unavailable"
    | "settlement"
    | "unexpected";
}> {}

/** Require explicit, reviewed Sandbox destinations before even tokenizing synthetic data. */
export const requireDaviplataSandboxPolicy = Effect.fnUntraced(function* (
  input: Readonly<{
    environment: string;
    sendUrl: Option.Option<string>;
    confirmUrl: Option.Option<string>;
  }>
) {
  if (input.environment !== "sandbox") {
    return yield* new DaviplataSandboxProofFailure({ stage: "policy" });
  }
  const policy = yield* Schema.decodeUnknownEffect(DaviplataOtpPolicy)({
    sendUrl: Option.getOrNull(input.sendUrl),
    confirmUrl: Option.getOrNull(input.confirmUrl),
  }).pipe(Effect.mapError(() => new DaviplataSandboxProofFailure({ stage: "policy" })));
  if (
    [policy.sendUrl, policy.confirmUrl].some(
      (url) =>
        !url.startsWith("https://sandbox.wompi.co/") &&
        url !== "https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox"
    )
  ) {
    return yield* new DaviplataSandboxProofFailure({ stage: "policy" });
  }
  return policy;
});

/** Bind the prepared server intent to the same reviewed proof destinations without displaying it. */
export const requireDaviplataSandboxEnrollment = Effect.fnUntraced(function* (
  input: Readonly<{ enrollment: PaymentEnrollment; policy: DaviplataOtpPolicy }>
) {
  const { enrollment, policy } = input;
  if (
    enrollment.status !== "prepared" ||
    enrollment.method !== "daviplata" ||
    enrollment.daviplataOtpPolicy.sendUrl !== policy.sendUrl ||
    enrollment.daviplataOtpPolicy.confirmUrl !== policy.confirmUrl
  ) {
    return yield* new DaviplataSandboxProofFailure({ stage: "enrollment" });
  }
  return enrollment;
});

const maximumProofTokenCharacters = 4096;
const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;
const secret = Schema.RedactedFromValue(
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumProofTokenCharacters))
);
const tokenResponse = Schema.Struct({
  data: Schema.Struct({
    id: secret,
    status: Schema.Literal("PENDING"),
    url_services: Schema.Struct({
      token: secret,
      code_otp_send: Schema.String,
      code_otp_validate: Schema.String,
    }),
  }),
});
const sentResponse = Schema.Struct({
  data: Schema.Struct({
    subscription: Schema.Struct({ PK: secret, status: Schema.Literal("PENDING") }),
    authorization: Schema.Struct({ access_token: secret }),
  }),
});
const confirmedResponse = Schema.Struct({
  data: Schema.Struct({
    subscription: Schema.Struct({ PK: secret, status: Schema.Literal("APPROVED") }),
  }),
});
const json = Effect.fnUntraced(function* (
  response: OutboundHttpResponse,
  stage: "tokenization-response" | "otp-send-response" | "otp-confirm-response"
) {
  if (
    response.status < successfulStatusMinimum ||
    response.status >= successfulStatusMaximumExclusive
  ) {
    return yield* new DaviplataSandboxProofFailure({ stage });
  }
  return yield* Schema.decodeEffect(UnknownJsonString)(
    new TextDecoder().decode(response.body)
  ).pipe(Effect.mapError(() => new DaviplataSandboxProofFailure({ stage })));
});

const destination = (
  endpoint: string,
  id: string,
  operation: "RESEND_OTP" | "VALIDATE_OTP_API"
): string =>
  endpoint === "https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox"
    ? `${endpoint}?token=${id}&operation=${operation}`
    : endpoint;

const execute = (
  outbound: OutboundHttpService,
  request: Parameters<OutboundHttpService["execute"]>[0],
  stage: "tokenization-request" | "otp-send-request" | "otp-confirm-request"
): Effect.Effect<OutboundHttpResponse, DaviplataSandboxProofFailure> =>
  outbound
    .execute(request)
    .pipe(Effect.mapError(() => new DaviplataSandboxProofFailure({ stage })));

const otp = ({
  outbound,
  authorizationId,
  token,
  step,
}: Readonly<{
  outbound: OutboundHttpService;
  authorizationId: Redacted.Redacted<string>;
  token: Redacted.Redacted<string>;
  step: "send" | "confirm";
}>): Effect.Effect<unknown, DaviplataSandboxProofFailure> =>
  execute(
    outbound,
    {
      _tag: "WompiDaviplataSandboxOtp",
      step,
      authorizationId,
      token,
    },
    step === "send" ? "otp-send-request" : "otp-confirm-request"
  ).pipe(
    Effect.flatMap((response) =>
      json(response, step === "send" ? "otp-send-response" : "otp-confirm-response")
    )
  );

const verifyDestinations = (
  token: typeof tokenResponse.Type,
  policy: DaviplataOtpPolicy
): Effect.Effect<void, DaviplataSandboxProofFailure> => {
  const id = Redacted.value(token.data.id);
  return token.data.url_services.code_otp_send === destination(policy.sendUrl, id, "RESEND_OTP") &&
    token.data.url_services.code_otp_validate ===
      destination(policy.confirmUrl, id, "VALIDATE_OTP_API")
    ? Effect.void
    : Effect.fail(new DaviplataSandboxProofFailure({ stage: "destinations" }));
};

/** One tokenization/send/confirm sequence; never resend a one-use bearer or retry an ambiguous POST. */
export const authorizeDaviplataSandbox = Effect.fnUntraced(function* (
  input: Readonly<{
    outbound: OutboundHttpService;
    policy: DaviplataOtpPolicy;
    outcome: "approved" | "declined";
  }>
) {
  const policy = yield* requireDaviplataSandboxPolicy({
    environment: "sandbox",
    sendUrl: Option.some(input.policy.sendUrl),
    confirmUrl: Option.some(input.policy.confirmUrl),
  });
  const token = yield* execute(
    input.outbound,
    { _tag: "WompiDaviplataSandboxToken", outcome: input.outcome },
    "tokenization-request"
  ).pipe(
    Effect.flatMap((response) => json(response, "tokenization-response")),
    Effect.flatMap(Schema.decodeUnknownEffect(tokenResponse)),
    Effect.mapError((error) =>
      error instanceof DaviplataSandboxProofFailure
        ? error
        : new DaviplataSandboxProofFailure({ stage: "tokenization-response" })
    )
  );
  yield* verifyDestinations(token, policy);
  const sent = yield* otp({
    outbound: input.outbound,
    authorizationId: token.data.id,
    token: token.data.url_services.token,
    step: "send",
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(sentResponse)),
    Effect.mapError((error) =>
      error instanceof DaviplataSandboxProofFailure
        ? error
        : new DaviplataSandboxProofFailure({ stage: "otp-send-response" })
    )
  );
  if (Redacted.value(sent.data.subscription.PK) !== Redacted.value(token.data.id)) {
    return yield* new DaviplataSandboxProofFailure({ stage: "otp-send-identity" });
  }
  const confirmed = yield* otp({
    outbound: input.outbound,
    authorizationId: token.data.id,
    token: sent.data.authorization.access_token,
    step: "confirm",
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(confirmedResponse)),
    Effect.mapError((error) =>
      error instanceof DaviplataSandboxProofFailure
        ? error
        : new DaviplataSandboxProofFailure({ stage: "otp-confirm-response" })
    )
  );
  if (Redacted.value(confirmed.data.subscription.PK) !== Redacted.value(token.data.id)) {
    return yield* new DaviplataSandboxProofFailure({ stage: "otp-confirm-identity" });
  }
  return token.data.id;
});
