import { createHmac } from "node:crypto";
import { Config, ConfigProvider, DateTime, Effect, Redacted, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  type EmailAddress,
  maximumEmailDeliveryGenerations,
} from "~/core/email-authentication/model";
import type {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";

const emailAdmissionHmacKeyPattern = /^[0-9a-f]{64}$/u;
const requiredAdmissionBudgetCount = 2;
const invalidEmailAdmissionHmacKey = (): Config.ConfigError =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message: "EMAIL_ADMISSION_HMAC_KEY must be a 32-byte lowercase hexadecimal key",
    })
  );

const credentialLookupHmacKeyPattern = /^[0-9a-f]{64}$/u;
const invalidCredentialLookupHmacKey = (): Config.ConfigError =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message: "EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY must be a 32-byte lowercase hexadecimal key",
    })
  );

export const emailCredentialLookupKey = Effect.fn(function* (email: EmailAddress) {
  const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
  let secret = Redacted.make("local-email-credential-lookup-key-not-for-production");
  if (environment === "production") {
    secret = yield* Config.redacted("EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY");
    if (!credentialLookupHmacKeyPattern.test(Redacted.value(secret))) {
      return yield* Effect.fail(invalidCredentialLookupHmacKey());
    }
  }
  return createHmac("sha256", Redacted.value(secret))
    .update(`verified-email-credential:${email}`)
    .digest("hex");
});

export const emailAuthenticationHmacKey = Effect.fn(function* (scope: string) {
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

export type EmailDeliveryRequester =
  | Readonly<{ _tag: "User"; userId: UserId }>
  | Readonly<{
      _tag: "WhatsAppCaller";
      businessPortfolioId: WhatsAppBusinessPortfolioId;
      businessScopedUserId: WhatsAppBusinessScopedUserId;
    }>;

const requesterScope = (requester: EmailDeliveryRequester): string => {
  switch (requester._tag) {
    case "User":
      return `user:${requester.userId}`;
    case "WhatsAppCaller":
      return `caller:${requester.businessPortfolioId}:${requester.businessScopedUserId}`;
  }
};

/**
 * Atomically admits one email delivery against both the requester's rolling allowance and the
 * recipient mailbox's shared rolling allowance. The caller must run this inside its owning
 * transaction and supply the authoritative attempt time. `false` leaves both allowances unchanged;
 * `true` consumes one delivery from each allowance.
 */
export const admitEmailDeliveryInScope = Effect.fn("EmailAuthentication.admitDeliveryInScope")(
  function* (input: {
    requester: EmailDeliveryRequester;
    recipient: EmailAddress;
    attemptedAt: DateTime.Utc;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const requesterBudgetKey = yield* emailAuthenticationHmacKey(
      requesterScope(input.requester)
    ).pipe(Effect.orDie);
    const recipientBudgetKey = yield* emailAuthenticationHmacKey(
      `recipient:${input.recipient}`
    ).pipe(Effect.orDie);
    yield* sql`
      INSERT INTO email_delivery_admission_budgets (scope_key, delivery_count, expires_at)
      VALUES (${requesterBudgetKey}, 0, ${input.attemptedAt}),
        (${recipientBudgetKey}, 0, ${input.attemptedAt})
      ON CONFLICT (scope_key) DO NOTHING
    `.pipe(Effect.orDie);
    const admitted = yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ count: Schema.Int }),
      execute: () => sql`
        WITH locked AS MATERIALIZED (
          SELECT scope_key, delivery_count, expires_at FROM email_delivery_admission_budgets
          WHERE scope_key IN (${requesterBudgetKey}, ${recipientBudgetKey})
          ORDER BY scope_key FOR UPDATE
        ), eligible AS (
          SELECT count(*) = ${requiredAdmissionBudgetCount}
            AND bool_and(expires_at <= ${input.attemptedAt}
              OR delivery_count < ${maximumEmailDeliveryGenerations}) AS admitted FROM locked
        ), updated_budgets AS (
          UPDATE email_delivery_admission_budgets budget SET
            delivery_count = CASE WHEN expires_at <= ${input.attemptedAt}
              THEN 1 ELSE delivery_count + 1 END,
            expires_at = CASE WHEN expires_at <= ${input.attemptedAt}
              THEN ${DateTime.add(input.attemptedAt, { hours: 24 })} ELSE expires_at END
          WHERE scope_key IN (${requesterBudgetKey}, ${recipientBudgetKey})
            AND (SELECT admitted FROM eligible) RETURNING scope_key
        ) SELECT count(*)::int AS count FROM updated_budgets
      `,
    })(undefined).pipe(Effect.orDie);
    return admitted.count === requiredAdmissionBudgetCount;
  }
);
