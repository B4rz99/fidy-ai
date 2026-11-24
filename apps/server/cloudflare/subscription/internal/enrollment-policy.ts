import { Data, Effect, Exit, Option, type Redacted, Schema } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import {
  BillingAttemptId,
  DaviplataOtpPolicy,
  type EnrollmentMethod,
  type PaymentRequestId,
  type RecurringDisclosure,
} from "../../../src/core/subscription/contract";
import type { SubmitPaymentEnrollmentPayload } from "../../../src/shell/subscription/contract";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import { wompiCredentialPrefixes } from "../../../src/shell/secret-material/operations";
import { browserOrigins } from "../../runtime/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";

const hexBase = 16;

const Origin = Schema.Literals([
  browserOrigins.production,
  browserOrigins.local,
  browserOrigins.acceptance,
]);

export const WompiConfiguration = Schema.Struct({
  BROWSER_ORIGIN: Origin,
  WOMPI_ENVIRONMENT: WompiEnvironment,
  WOMPI_PUBLIC_KEY: Schema.String.check(Schema.isPattern(/^pub_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)),
  WOMPI_PRIVATE_KEY: Schema.String.check(
    Schema.isPattern(/^prv_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)
  ),
  WOMPI_INTEGRITY_SECRET: Schema.String.check(
    Schema.isPattern(/^(?:test|prod)_integrity_[A-Za-z0-9_-]{8,}$/u)
  ),
});

export const enrollmentDisclosureRevisions = {
  card: "wompi-card-enrollment-v2",
  nequi: "wompi-nequi-enrollment-v1",
  daviplata: "wompi-daviplata-enrollment-v1",
} as const satisfies Readonly<Record<EnrollmentMethod, RecurringDisclosure["revision"]>>;

export const submittedToken = (
  input: Extract<SubmitPaymentEnrollmentPayload, { paymentSourceMode: "create" }>
): Redacted.Redacted<string> => {
  switch (input.method) {
    case "card":
      return input.cardToken;
    case "nequi":
      return input.nequiToken;
    case "daviplata":
      return input.daviplataToken;
  }
};

export const walletTokenPatterns = {
  sandbox: { nequi: /^nequi_test_/u, daviplata: /^daviplata_(?:test|devtest|devint)_/u },
  production: { nequi: /^nequi_prod_/u, daviplata: /^daviplata_prod_/u },
} as const;

const uuidByteCount = 16;

const uuidVersionByte = 6;

const uuidVariantByte = 8;

const versionMask = 0x0f;

const versionBits = 0x40;

const variantMask = 0x3f;

const variantBits = 0x80;

const firstGroupEnd = 8;

const secondGroupEnd = 12;

const thirdGroupEnd = 16;

const fourthGroupEnd = 20;

const jsonPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 6144,
  deadlineMilliseconds: 2000,
});

export const enrollmentDigest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));

export const billingAttemptIdFor = (
  input: Readonly<{ userId: UserId; requestId: PaymentRequestId }>
): Promise<BillingAttemptId> =>
  enrollmentDigest(`billing-attempt-v1:${input.userId}:${input.requestId}`).then((hash) => {
    const bytes = hash.slice(0, uuidByteCount);
    bytes[uuidVersionByte] = ((bytes[uuidVersionByte] ?? 0) & versionMask) | versionBits;
    bytes[uuidVariantByte] = ((bytes[uuidVariantByte] ?? 0) & variantMask) | variantBits;
    const hex = Array.from(bytes, (byte) => byte.toString(hexBase).padStart(2, "0")).join("");

    return BillingAttemptId.make(
      `${hex.slice(0, firstGroupEnd)}-${hex.slice(firstGroupEnd, secondGroupEnd)}-${hex.slice(secondGroupEnd, thirdGroupEnd)}-${hex.slice(thirdGroupEnd, fourthGroupEnd)}-${hex.slice(fourthGroupEnd)}`
    );
  });

export const enrollmentConfigured = (environment: unknown): boolean => {
  const config = Schema.decodeUnknownOption(WompiConfiguration)(environment);

  if (Option.isNone(config)) return false;
  const prefixes = wompiCredentialPrefixes(config.value.WOMPI_ENVIRONMENT);

  return (
    config.value.WOMPI_PUBLIC_KEY.startsWith(prefixes.publicKey) &&
    config.value.WOMPI_PRIVATE_KEY.startsWith(prefixes.privateKey) &&
    config.value.WOMPI_INTEGRITY_SECRET.startsWith(prefixes.integritySecret)
  );
};

export const daviplataPolicy = (
  environment: Readonly<{ WOMPI_ENVIRONMENT: string }> &
    Partial<
      Readonly<{
        WOMPI_DAVIPLATA_ACTIVATED: string;
        WOMPI_DAVIPLATA_OTP_SEND_URL: string;
        WOMPI_DAVIPLATA_OTP_CONFIRM_URL: string;
      }>
    >
): Option.Option<DaviplataOtpPolicy> => {
  if (
    environment.WOMPI_ENVIRONMENT === "production" &&
    environment.WOMPI_DAVIPLATA_ACTIVATED !== "enabled"
  ) {
    return Option.none();
  }

  const policy = Schema.decodeUnknownOption(DaviplataOtpPolicy)({
    sendUrl: environment.WOMPI_DAVIPLATA_OTP_SEND_URL,
    confirmUrl: environment.WOMPI_DAVIPLATA_OTP_CONFIRM_URL,
  });

  const origin =
    environment.WOMPI_ENVIRONMENT === "sandbox"
      ? "https://sandbox.wompi.co/"
      : "https://production.wompi.co/";

  return Option.filter(policy, (value) =>
    [value.sendUrl, value.confirmUrl].every(
      (url) =>
        url.startsWith(origin) ||
        (environment.WOMPI_ENVIRONMENT === "sandbox" &&
          url === "https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox")
    )
  );
};

class EnrollmentBodyMalformed extends Data.TaggedError("EnrollmentBodyMalformed")<{}> {}

export const readEnrollmentBody = <A, E>({
  request,
  schema,
}: {
  request: Request;
  schema: Schema.Codec<A, E>;
}): Effect.Effect<Option.Option<A>> =>
  Effect.gen(function* () {
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      return Option.none();
    }

    const result = yield* Effect.exit(readBoundedRequestBody(request, jsonPolicy));

    if (Exit.isFailure(result)) {
      yield* Effect.logDebug(result.cause);

      return Option.none();
    }

    return yield* Effect.try({
      try: () =>
        Schema.decodeOption(Schema.fromJsonString(schema), { onExcessProperty: "error" })(
          new TextDecoder("utf-8", { fatal: true }).decode(result.value)
        ),
      catch: () => new EnrollmentBodyMalformed(),
    }).pipe(
      Effect.tapError(Effect.logDebug),
      Effect.catchTag("EnrollmentBodyMalformed", () => Effect.succeedNone)
    );
  });
