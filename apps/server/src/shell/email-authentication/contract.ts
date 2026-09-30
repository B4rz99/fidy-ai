import type { Effect } from "effect";

import { Schema } from "effect";

import type { EmailProofPurpose } from "~/core/email-authentication/contract";

import { EmailAddress, EmailVerificationCode } from "~/core/email-authentication/contract";

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import {
  AtomicBatchEligible,
  freshWebSessionOnly,
  operationPolicy,
} from "~/shell/_shared/operation-policy";

import { OperationResponse } from "~/shell/public-http/contract";

/** Candidate mailbox supplied for one verified-email replacement request. */
export const RequestEmailReplacementPayload = Schema.Struct({
  candidateEmail: EmailAddress,
}).annotate({ identifier: "RequestEmailReplacementPayload" });

/** Uniform response after a replacement request is accepted or safely suppressed. */
export const EmailReplacementPending = Schema.Struct({
  status: Schema.Literal("pending"),
}).annotate({ identifier: "EmailReplacementPending" });

/** Canonical replacement paths shared by the declared operations and the edge policy. */
export const emailReplacementPath = "/email/replacement";

export const emailReplacementCompletionPath = "/web/email/replacement/verify";

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

export type EmailDeliveryPortService = {
  readonly send: (input: {
    readonly purpose: EmailProofPurpose;
    readonly to: EmailAddress;
    readonly combinedCode: EmailVerificationCode;
    readonly idempotencyKey: string;
  }) => Effect.Effect<
    void,
    { readonly certainty: "rejected" | "ambiguous"; readonly retryable: boolean }
  >;
};
