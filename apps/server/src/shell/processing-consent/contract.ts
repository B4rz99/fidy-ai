import { ErasureReceipt, ErasureRequest } from "~/core/erasure/contract";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import {
  DisclosureSnapshot,
  OnboardingConsentGrantId,
  Sha256Digest,
} from "~/core/consent/contract";
import { Transaction } from "~/core/transactions/contract";
import { UserPreferences } from "~/core/identity/contract";
import { Category } from "~/core/categories/contract";
import { ResourceLimited } from "~/shell/public-http/contract";

/** A pagination position conveys no authority; every page authenticates the same browser afresh. */
export const PrivacyTransactionCursor = Schema.Struct({
  occurredAt: Transaction.fields.occurredAt,
  createdAt: Transaction.fields.createdAt,
  id: Transaction.fields.id,
});
export const PrivacyTransactionRequest = Schema.Struct({
  cursor: Schema.NullOr(PrivacyTransactionCursor),
});
/** One bounded owner result for the explicit Transactions scope, with its metadata-only Audit reference. */
export const PrivacyTransactionPage = Schema.Struct({
  reference: Schema.String.check(Schema.isUUID()),
  scope: Schema.Literal("transactions"),
  data: Schema.Array(Transaction).check(Schema.isMaxLength(100)),
  presentation: UserPreferences,
  categories: Schema.Array(Category).check(Schema.isMaxLength(100)),
  next: Schema.NullOr(PrivacyTransactionCursor),
});
export type PrivacyTransactionPage = typeof PrivacyTransactionPage.Type;

const maximumPublicEpochMs = 253402300799999;
const publicReceiptTime = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumPublicEpochMs })
);

/** Exact saved onboarding authorization for this User; historical evidence is not current processing authority. */
export const ProcessingAuthorization = Schema.Struct({
  authorization: Schema.NullOr(
    Schema.Struct({
      reference: OnboardingConsentGrantId,
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

/** Explicit reacceptance of the saved disclosure, bound to one current withdrawal. */
export const ProcessingConsentRenewal = Schema.Struct({
  confirm: Schema.Literal(true),
  withdrawalReference: Schema.String.check(Schema.isUUID()),
  authorizationReference: OnboardingConsentGrantId,
  disclosureSha256: Sha256Digest,
});
export const ProcessingConsentRenewalReceipt = Schema.Struct({
  status: Schema.Literal("Granted"),
  renewal: Schema.Struct({
    reference: Schema.String.check(Schema.isUUID()),
    withdrawalReference: Schema.String.check(Schema.isUUID()),
    acceptedAtMs: publicReceiptTime,
  }),
});

const acceptedStatus = 202;

/** Cookie-only privacy controls, available after withdrawal and outside agent operations. */
export const ProcessingConsentGroup = HttpApiGroup.make("processingConsent").add(
  HttpApiEndpoint.post("erase", "/web/privacy/erasure", {
    payload: ErasureRequest,
    success: ErasureReceipt.pipe(HttpApiSchema.status(acceptedStatus)),
  }),
  HttpApiEndpoint.post("renew", "/web/consent/renew", {
    payload: ProcessingConsentRenewal,
    success: ProcessingConsentRenewalReceipt,
  }),
  HttpApiEndpoint.get("status", "/web/consent", {
    success: ProcessingConsentStatus,
    error: ResourceLimited,
  }),
  HttpApiEndpoint.get("authorization", "/web/consent/authorization", {
    success: ProcessingAuthorization,
    error: ResourceLimited,
  }),
  HttpApiEndpoint.post("transactions", "/web/privacy/transactions", {
    payload: PrivacyTransactionRequest,
    success: PrivacyTransactionPage,
  }),
  HttpApiEndpoint.post("withdraw", "/web/consent/withdraw", {
    payload: ProcessingConsentWithdrawal,
    success: ProcessingConsentStatus,
  })
);
