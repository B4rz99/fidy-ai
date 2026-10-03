import type { OwnedStatement } from "~/shell/owner-write/contract";
import { Data, type Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { BrowserLoginPairingInvalidApi } from "~/shell/browser-login/contract";
import { BrowserLoginPairingId, BrowserLoginPrivateVerifier } from "~/core/browser-login/contract";

import {
  EmailAddress,
  type EmailProofPurpose,
  EmailVerificationCode,
  browserPairingEmailRetryAfterSeconds,
} from "~/core/email-authentication/contract";
import type { UserId } from "~/core/identity/contract";
import { BackupRecoveryCode } from "~/core/recovery/contract";
import {
  AtomicBatchEligible,
  freshWebSessionOnly,
  operationPolicy,
} from "~/shell/canonical-policy/contract";
import { OperationResponse } from "~/shell/public-http/contract";

/** Canonical replacement paths shared by the declared operations and the edge policy. */
export const emailReplacementPath = "/email/replacement";
export const emailReplacementCompletionPath = "/web/email/replacement/verify";

/** Candidate mailbox supplied for one verified-email replacement request. */
export const RequestEmailReplacementPayload = Schema.Struct({
  candidateEmail: EmailAddress,
}).annotate({ identifier: "RequestEmailReplacementPayload" });

/** Uniform response after a replacement request is accepted or safely suppressed. */
export const EmailReplacementPending = Schema.Struct({
  status: Schema.Literal("pending"),
}).annotate({ identifier: "EmailReplacementPending" });

const emailVerificationInvalidError = {
  code: "verification_invalid",
  message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
} as const;

/** One bounded raw browser field; proof parsing remains internal to the handler. */
export const VerifyEmailEnrollmentPayload = Schema.Struct({
  combinedCode: Schema.Unknown,
});
export type VerifyEmailEnrollmentPayload = typeof VerifyEmailEnrollmentPayload.Type;

/** One-time no-store disclosure of the Recovery-owned emergency credential. */
export const CreatedVerifiedOnboarding = Schema.Struct({
  status: Schema.Literal("created"),
  backupRecoveryCode: Schema.RedactedFromValue(BackupRecoveryCode),
}).annotate({ identifier: "CreatedVerifiedOnboarding" });

export class EmailVerificationInvalidApi extends Schema.Error<EmailVerificationInvalidApi>(
  "EmailVerificationInvalidApi"
)(
  {
    error: Schema.Struct({
      code: Schema.Literal(emailVerificationInvalidError.code),
      message: Schema.Literal(emailVerificationInvalidError.message),
    }),
  },
  { httpApiStatus: 400 }
) {}

export const emailVerificationInvalidBody = { error: emailVerificationInvalidError } as const;

export const EmailOnboardingWebAuthGroup = HttpApiGroup.make("emailOnboarding").add(
  HttpApiEndpoint.post("verifyEmail", "/web/onboarding/email/verify", {
    payload: VerifyEmailEnrollmentPayload,
    success: CreatedVerifiedOnboarding,
    error: EmailVerificationInvalidApi,
  }).annotate(
    OpenApi.Description,
    "Verify one mailbox proof and atomically create the complete stable User state."
  )
);

const emailReplacementInvalidError = {
  code: "verification_invalid",
  message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
} as const;
const emailReplacementFreshError = {
  code: "fresh_pairing_required",
  message: "Vincula el navegador de nuevo antes de cambiar tu correo.",
} as const;

/** Body accepted by the first-party browser replacement-completion endpoint. */
export const CompleteEmailReplacementPayload = Schema.Struct({
  combinedCode: EmailVerificationCode,
});
/** Decoded browser replacement-completion body. */
export type CompleteEmailReplacementPayload = typeof CompleteEmailReplacementPayload.Type;

/** Bounded success response for a completed credential replacement. */
export const CompletedEmailReplacement = Schema.Struct({
  status: Schema.Literal("replaced"),
}).annotate({ identifier: "CompletedEmailReplacement" });

const emailReplacementInvalidFields = {
  error: Schema.Struct({
    code: Schema.Literal(emailReplacementInvalidError.code),
    message: Schema.Literal(emailReplacementInvalidError.message),
  }),
};

/** Generic browser response for an invalid or unavailable replacement proof. */
export class EmailReplacementInvalidApi extends Schema.Error<EmailReplacementInvalidApi>(
  "EmailReplacementInvalidApi"
)(emailReplacementInvalidFields, { httpApiStatus: 400 }) {}

/** Browser response when replacement completion does not come from the first-party origin. */
export class EmailReplacementOriginRejectedApi extends Schema.Error<EmailReplacementOriginRejectedApi>(
  "EmailReplacementOriginRejectedApi"
)(emailReplacementInvalidFields, { httpApiStatus: 403 }) {}

/** Browser response when the replacement-completion body exceeds its fixed bound. */
export class EmailReplacementPayloadTooLargeApi extends Schema.Error<EmailReplacementPayloadTooLargeApi>(
  "EmailReplacementPayloadTooLargeApi"
)(emailReplacementInvalidFields, { httpApiStatus: 413 }) {}

/** Browser response when replacement completion is not encoded as JSON. */
export class EmailReplacementUnsupportedMediaTypeApi extends Schema.Error<EmailReplacementUnsupportedMediaTypeApi>(
  "EmailReplacementUnsupportedMediaTypeApi"
)(emailReplacementInvalidFields, { httpApiStatus: 415 }) {}

/** Browser response requiring the User to establish fresh WebSession authority again. */
export class EmailReplacementFreshPairingRequiredApi extends Schema.Error<EmailReplacementFreshPairingRequiredApi>(
  "EmailReplacementFreshPairingRequiredApi"
)(
  {
    error: Schema.Struct({
      code: Schema.Literal(emailReplacementFreshError.code),
      message: Schema.Literal(emailReplacementFreshError.message),
    }),
  },
  { httpApiStatus: 401 }
) {}

/** Shared bounded invalid-proof payload used by raw browser handlers. */
export const emailReplacementInvalidBody = { error: emailReplacementInvalidError } as const;
/** Shared bounded stale-authority payload used by raw browser handlers. */
export const emailReplacementFreshBody = { error: emailReplacementFreshError } as const;

const browserPairingEmailAuthenticationInvalidError = {
  code: "authentication_invalid",
  message: "El código no es válido. Inicia de nuevo o solicita otro correo.",
} as const;
const BrowserPairingEmailAuthenticationInvalidFields = {
  error: Schema.Struct({
    code: Schema.Literal(browserPairingEmailAuthenticationInvalidError.code),
    message: Schema.Literal(browserPairingEmailAuthenticationInvalidError.message),
  }),
};

/** Stable non-enumerating browser error body shared by every email-authentication failure. */
export const browserPairingEmailAuthenticationInvalidBody = {
  error: browserPairingEmailAuthenticationInvalidError,
} as const;

/** Browser start request proving a live pairing while naming the already-verified mailbox. */
export const StartBrowserPairingEmailAuthenticationPayload = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: BrowserLoginPrivateVerifier,
  email: EmailAddress,
});
/** Decoded, branded start request accepted by the direct browser transport. */
export type StartBrowserPairingEmailAuthenticationPayload =
  typeof StartBrowserPairingEmailAuthenticationPayload.Type;

/** Browser completion request carrying both the private pairing verifier and mailbox proof. */
export const CompleteBrowserPairingEmailAuthenticationPayload = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: BrowserLoginPrivateVerifier,
  combinedCode: EmailVerificationCode,
});
/** Decoded, branded completion request accepted by the direct browser transport. */
export type CompleteBrowserPairingEmailAuthenticationPayload =
  typeof CompleteBrowserPairingEmailAuthenticationPayload.Type;

/** Fixed accepted response; it reveals neither credential existence nor delivery state. */
export const PendingBrowserPairingEmailAuthentication = Schema.Struct({
  status: Schema.Literal("pending"),
  retryAfterSeconds: Schema.Literal(browserPairingEmailRetryAfterSeconds),
}).annotate({ identifier: "PendingBrowserPairingEmailAuthentication", httpApiStatus: 202 });

/** Completion response confirming only that the existing pairing is now redeemable. */
export const ApprovedBrowserPairingEmailAuthentication = Schema.Struct({
  status: Schema.Literal("pairing_approved"),
}).annotate({ identifier: "ApprovedBrowserPairingEmailAuthentication" });

/** Generic malformed, mismatched, expired, or exhausted email-authentication failure. */
export class BrowserPairingEmailAuthenticationInvalidApi extends Schema.Error<BrowserPairingEmailAuthenticationInvalidApi>(
  "BrowserPairingEmailAuthenticationInvalidApi"
)(BrowserPairingEmailAuthenticationInvalidFields, { httpApiStatus: 400 }) {}
/** Exact-origin rejection projected through the same non-enumerating error body. */
export class BrowserPairingEmailAuthenticationOriginRejectedApi extends Schema.Error<BrowserPairingEmailAuthenticationOriginRejectedApi>(
  "BrowserPairingEmailAuthenticationOriginRejectedApi"
)(BrowserPairingEmailAuthenticationInvalidFields, { httpApiStatus: 403 }) {}
/** Bounded-body rejection projected through the same non-enumerating error body. */
export class BrowserPairingEmailAuthenticationPayloadTooLargeApi extends Schema.Error<BrowserPairingEmailAuthenticationPayloadTooLargeApi>(
  "BrowserPairingEmailAuthenticationPayloadTooLargeApi"
)(BrowserPairingEmailAuthenticationInvalidFields, { httpApiStatus: 413 }) {}
/** Non-JSON request rejection projected through the same non-enumerating error body. */
export class BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi extends Schema.Error<BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi>(
  "BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi"
)(BrowserPairingEmailAuthenticationInvalidFields, { httpApiStatus: 415 }) {}
/** Local concurrency rejection projected through the same non-enumerating error body. */
export class BrowserPairingEmailAuthenticationUnavailableApi extends Schema.Error<BrowserPairingEmailAuthenticationUnavailableApi>(
  "BrowserPairingEmailAuthenticationUnavailableApi"
)(BrowserPairingEmailAuthenticationInvalidFields, { httpApiStatus: 503 }) {}

const requestEmailReplacement = HttpApiEndpoint.post(
  "requestEmailReplacement",
  emailReplacementPath,
  {
    payload: RequestEmailReplacementPayload,
    success: OperationResponse(EmailReplacementPending),
  }
)
  .annotate(
    OpenApi.Description,
    "Use after the User confirms replacing their verified email; sends a verification code to the candidate address."
  )
  // Standalone: the mailbox challenge and outbox share their own atomic unit (ADR 0027).
  .annotate(AtomicBatchEligible, false)
  .annotateMerge(
    operationPolicy({
      access: freshWebSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

const completeEmailReplacement = HttpApiEndpoint.post(
  "completeEmailReplacement",
  emailReplacementCompletionPath,
  {
    payload: CompleteEmailReplacementPayload,
    success: OperationResponse(CompletedEmailReplacement),
    error: [
      EmailReplacementInvalidApi,
      EmailReplacementFreshPairingRequiredApi,
      EmailReplacementOriginRejectedApi,
      EmailReplacementPayloadTooLargeApi,
      EmailReplacementUnsupportedMediaTypeApi,
    ],
  }
)
  .annotate(
    OpenApi.Description,
    "Verify the candidate mailbox and replace the one VerifiedEmailCredential under a fresh WebSession."
  )
  // Standalone: the single-use proof and credential swap share their own atomic unit (ADR 0027).
  .annotate(AtomicBatchEligible, false)
  .annotateMerge(
    operationPolicy({
      access: freshWebSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

/** Bounded verified-email account-security operations and their access policies. */
export const EmailAuthenticationGroup = HttpApiGroup.make("emailAuthentication")
  .add(requestEmailReplacement)
  .add(completeEmailReplacement);

/** Coordinate-free delivery failure for the durable owner; never an HTTP response. */
export class EmailSendFailed extends Data.TaggedError("EmailSendFailed")<{
  readonly certainty: "rejected" | "ambiguous";
  readonly retryable: boolean;
}> {}

export type EmailDeliveryPortService = {
  readonly send: (input: {
    readonly purpose: EmailProofPurpose;
    readonly to: EmailAddress;
    readonly combinedCode: EmailVerificationCode;
    readonly idempotencyKey: string;
  }) => Effect.Effect<void, EmailSendFailed>;
};

/** Cloudflare's transaction adapter; the canonical implementation owns the operation result. */
export type EmailReplacementMutationService = Readonly<{
  request: (subject: UserId, candidate: EmailAddress) => Effect.Effect<void>;
  complete: (subject: UserId, combinedCode: string) => Effect.Effect<boolean>;
}>;

/** Trusted static subject query carries exact pairingId/userId for live same-User composition. */
export type EmailPairingSubject = Readonly<{ subject: OwnedStatement }>;

/** Direct-browser start and completion operations; neither operation creates a WebSession. */
export const BrowserPairingEmailAuthenticationWebAuthGroup = HttpApiGroup.make(
  "browserPairingEmailAuthentication"
)
  .add(
    HttpApiEndpoint.post("start", "/web/email/authentication/start", {
      payload: StartBrowserPairingEmailAuthenticationPayload,
      success: PendingBrowserPairingEmailAuthentication,
      error: [
        BrowserLoginPairingInvalidApi,
        BrowserPairingEmailAuthenticationInvalidApi,
        BrowserPairingEmailAuthenticationOriginRejectedApi,
        BrowserPairingEmailAuthenticationPayloadTooLargeApi,
        BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi,
        BrowserPairingEmailAuthenticationUnavailableApi,
      ],
    })
  )
  .add(
    HttpApiEndpoint.post("complete", "/web/email/authentication/complete", {
      payload: CompleteBrowserPairingEmailAuthenticationPayload,
      success: ApprovedBrowserPairingEmailAuthentication,
      error: [
        BrowserPairingEmailAuthenticationInvalidApi,
        BrowserPairingEmailAuthenticationOriginRejectedApi,
        BrowserPairingEmailAuthenticationPayloadTooLargeApi,
        BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi,
        BrowserPairingEmailAuthenticationUnavailableApi,
      ],
    })
  );
