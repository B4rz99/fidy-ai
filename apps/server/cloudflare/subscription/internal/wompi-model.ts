import { Schema } from "effect";

export const WompiTransactionReference = Schema.String.check(
  Schema.isPattern(/^fidy-[0-9a-f-]{36}$/u)
)
  .pipe(Schema.brand("WompiTransactionReference"))
  .annotate({ identifier: "WompiTransactionReference" });

export type WompiTransactionReference = typeof WompiTransactionReference.Type;

const maximumWompiTransactionIdCharacters = 128;

export const WompiTransactionId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumWompiTransactionIdCharacters)
)
  .pipe(Schema.brand("WompiTransactionId"))
  .annotate({ identifier: "WompiTransactionId" });

export type WompiTransactionId = typeof WompiTransactionId.Type;

export const WompiBillingStatus = Schema.Literals([
  "PENDING",
  "APPROVED",
  "DECLINED",
  "VOIDED",
  "ERROR",
]);

export type WompiBillingStatus = typeof WompiBillingStatus.Type;

export const WompiSourceId = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("WompiSourceId"))
  .annotate({ identifier: "WompiSourceId" });

export type WompiSourceId = typeof WompiSourceId.Type;
