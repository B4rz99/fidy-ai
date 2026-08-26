import { createHmac } from "node:crypto";
import { Config, ConfigProvider, Effect, Redacted } from "effect";

const emailAdmissionHmacKeyPattern = /^[0-9a-f]{64}$/u;
const invalidEmailAdmissionHmacKey = (): Config.ConfigError =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message: "EMAIL_ADMISSION_HMAC_KEY must be a 32-byte lowercase hexadecimal key",
    })
  );

/** Produces the non-reversible stable scope key shared by all bounded email-proof workflows. */
export const emailDeliveryBudgetKey = Effect.fn("EmailAuthentication.deliveryBudgetKey")(function* (
  scope: string
) {
  const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
  let secret = Redacted.make("local-email-admission-key-not-for-production");
  if (environment === "production") {
    secret = yield* Config.redacted("EMAIL_ADMISSION_HMAC_KEY");
    if (!emailAdmissionHmacKeyPattern.test(Redacted.value(secret))) {
      return yield* Effect.fail(invalidEmailAdmissionHmacKey());
    }
  }
  return createHmac("sha256", Redacted.value(secret)).update(scope).digest("hex");
});
