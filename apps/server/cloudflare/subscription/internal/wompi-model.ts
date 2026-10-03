import { Schema } from "effect";

/** Private Wompi merchant reference used only to correlate authenticated provider evidence. */
export const WompiTransactionReference = Schema.String.check(
  Schema.isPattern(/^fidy-[0-9a-f-]{36}$/u)
)
  .pipe(Schema.brand("WompiTransactionReference"))
  .annotate({ identifier: "WompiTransactionReference" });
export type WompiTransactionReference = typeof WompiTransactionReference.Type;

const maximumWompiTransactionIdCharacters = 128;

/** Private Wompi transaction identity retained only behind the Subscription shell seam. */
export const WompiTransactionId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumWompiTransactionIdCharacters)
)
  .pipe(Schema.brand("WompiTransactionId"))
  .annotate({ identifier: "WompiTransactionId" });
export type WompiTransactionId = typeof WompiTransactionId.Type;

/** Provider transaction state accepted from bounded Wompi responses and signed events. */
export const WompiBillingStatus = Schema.Literals([
  "PENDING",
  "APPROVED",
  "DECLINED",
  "VOIDED",
  "ERROR",
]);
export type WompiBillingStatus = typeof WompiBillingStatus.Type;

/** Private Wompi identity retained only behind the Subscription shell boundary. */
export const WompiSourceId = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("WompiSourceId"))
  .annotate({ identifier: "WompiSourceId" });
export type WompiSourceId = typeof WompiSourceId.Type;

/** Private Fidy identity of one reusable card payment source. */
export const PaymentSourceId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PaymentSourceId"))
  .annotate({ identifier: "PaymentSourceId" });
export type PaymentSourceId = typeof PaymentSourceId.Type;
