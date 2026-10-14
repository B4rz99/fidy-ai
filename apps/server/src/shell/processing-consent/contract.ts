import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ConsentRecordId, DisclosureSnapshot } from "~/core/consent/contract";

const maximumPublicEpochMs = 253402300799999;
const publicReceiptTime = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumPublicEpochMs })
);

/** Exact saved onboarding authorization for this User; historical evidence is not current processing authority. */
export const ProcessingAuthorization = Schema.Struct({
  authorization: Schema.NullOr(
    Schema.Struct({
      reference: ConsentRecordId,
      acceptedAtMs: publicReceiptTime,
      disclosure: DisclosureSnapshot,
    })
  ),
});
export type ProcessingAuthorization = typeof ProcessingAuthorization.Type;

/** Same-User withdrawal receipt; this records processing authority, never physical erasure. */
export const ProcessingConsentStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("Granted"), withdrawal: Schema.Null }),
  Schema.Struct({ status: Schema.Literal("Missing"), withdrawal: Schema.Null }),
  Schema.Struct({
    status: Schema.Literal("Revoked"),
    withdrawal: Schema.Struct({
      reference: Schema.String.check(Schema.isUUID()),
      occurredAtMs: publicReceiptTime,
    }),
  }),
]);

export type ProcessingConsentStatus = typeof ProcessingConsentStatus.Type;

export const ProcessingConsentWithdrawal = Schema.Struct({ confirm: Schema.Literal(true) });

/** Cookie-only privacy controls, available after withdrawal and outside agent operations. */
export const ProcessingConsentGroup = HttpApiGroup.make("processingConsent").add(
  HttpApiEndpoint.get("status", "/web/consent", { success: ProcessingConsentStatus }),
  HttpApiEndpoint.get("authorization", "/web/consent/authorization", {
    success: ProcessingAuthorization,
  }),
  HttpApiEndpoint.post("withdraw", "/web/consent/withdraw", {
    payload: ProcessingConsentWithdrawal,
    success: ProcessingConsentStatus,
  })
);
