import { Data, Effect, Option, Redacted, Schema } from "effect";
import { DaviplataOtpPolicy, type PaymentEnrollment } from "../../src/core/subscription/contract";
import { UnknownJsonString } from "../../src/shell/schema-codecs/contract";
import type { OutboundHttpResponse } from "../../src/shell/outbound-http/contract";
import type { OutboundHttpService } from "../../src/shell/outbound-http/operations";

/** Live proof failures contain no provider payload, identity, URL, token or underlying cause. */
export class DaviplataSandboxProofFailure extends Data.TaggedError(
  "DaviplataSandboxProofFailure"
) {}

/** Require explicit, reviewed Sandbox destinations before even tokenizing synthetic data. */
export const requireDaviplataSandboxPolicy = Effect.fnUntraced(function* (
  input: Readonly<{
    environment: string;
    sendUrl: Option.Option<string>;
    confirmUrl: Option.Option<string>;
  }>
) {
  if (input.environment !== "sandbox") return yield* new DaviplataSandboxProofFailure();
  const policy = yield* Schema.decodeUnknownEffect(DaviplataOtpPolicy)({
    sendUrl: Option.getOrNull(input.sendUrl),
    confirmUrl: Option.getOrNull(input.confirmUrl),
  }).pipe(Effect.mapError(() => new DaviplataSandboxProofFailure()));
  if (
    !policy.sendUrl.startsWith("https://sandbox.wompi.co/") ||
    !policy.confirmUrl.startsWith("https://sandbox.wompi.co/")
  ) {
    return yield* new DaviplataSandboxProofFailure();
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
    return yield* new DaviplataSandboxProofFailure();
  }
  return enrollment;
});

const maximumProofTokenCharacters = 4096;
const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;
const secret = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumProofTokenCharacters)
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
const json = Effect.fnUntraced(function* (response: OutboundHttpResponse) {
  if (
    response.status < successfulStatusMinimum ||
    response.status >= successfulStatusMaximumExclusive
  ) {
    return yield* new DaviplataSandboxProofFailure();
  }
  return yield* Schema.decodeEffect(UnknownJsonString)(
    new TextDecoder().decode(response.body)
  ).pipe(Effect.mapError(() => new DaviplataSandboxProofFailure()));
});

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
  const execute = (
    request: Parameters<OutboundHttpService["execute"]>[0]
  ): Effect.Effect<OutboundHttpResponse, DaviplataSandboxProofFailure> =>
    input.outbound.execute(request).pipe(Effect.mapError(() => new DaviplataSandboxProofFailure()));
  const token = yield* execute({ _tag: "WompiDaviplataSandboxToken", outcome: input.outcome }).pipe(
    Effect.flatMap(json),
    Effect.flatMap(Schema.decodeUnknownEffect(tokenResponse)),
    Effect.mapError(() => new DaviplataSandboxProofFailure())
  );
  // Both URLs must match before either synthetic OTP or service bearer leaves this process.
  if (
    token.data.url_services.code_otp_send !== policy.sendUrl ||
    token.data.url_services.code_otp_validate !== policy.confirmUrl
  ) {
    return yield* new DaviplataSandboxProofFailure();
  }
  const sent = yield* execute({
    _tag: "WompiDaviplataSandboxOtp",
    step: "send",
    token: Redacted.make(token.data.url_services.token),
  }).pipe(
    Effect.flatMap(json),
    Effect.flatMap(Schema.decodeUnknownEffect(sentResponse)),
    Effect.mapError(() => new DaviplataSandboxProofFailure())
  );
  if (sent.data.subscription.PK !== token.data.id) return yield* new DaviplataSandboxProofFailure();
  const confirmed = yield* execute({
    _tag: "WompiDaviplataSandboxOtp",
    step: "confirm",
    token: Redacted.make(sent.data.authorization.access_token),
  }).pipe(
    Effect.flatMap(json),
    Effect.flatMap(Schema.decodeUnknownEffect(confirmedResponse)),
    Effect.mapError(() => new DaviplataSandboxProofFailure())
  );
  if (confirmed.data.subscription.PK !== token.data.id) {
    return yield* new DaviplataSandboxProofFailure();
  }
  return Redacted.make(token.data.id);
});
