import { completeProviderAuthentication } from "../provider-authentication/operations";
import { prepareOnboardingWhatsAppAssociation } from "../identity/operations";
import { recordOnboardingConsent, recordWebOnboardingConsent } from "../consent/operations";
import { verifyOnboardingEmail } from "../email-authentication/operations";
import type { OnboardingRequest } from "./contract";
import { completeEnrollment } from "./internal/completion";

/**
 * Create one stable User only after mandatory mailbox proof, composing all owners in one atomic
 * unit. On rejection nothing stable is created; success discloses one recovery code without
 * issuing a WebSession. Origin and ingress policy must already have run.
 */
export const completeOnboarding = ({ db, request }: OnboardingRequest): Promise<Response> =>
  verifyOnboardingEmail({
    db,
    request,
    complete: ({ exchangeId, verifiedAtMs, commit }) =>
      completeEnrollment({
        db,
        createdAtMs: verifiedAtMs,
        prepareEvidence: (userId) => [
          prepareOnboardingWhatsAppAssociation({
            db,
            userId,
            exchangeId,
            createdAtMs: verifiedAtMs,
          }),
          recordOnboardingConsent({ db, userId, exchangeId }),
        ],
        commit,
      }),
  });

/** Complete only the proven Google web origin, with atomic Consent, credential, TrialPeriod and recovery creation and separate Browser Login approval. */
export const completeGoogleOnboarding = ({ db, request }: OnboardingRequest): Promise<Response> =>
  completeProviderAuthentication({
    db,
    request,
    complete: (proof) =>
      completeEnrollment({
        db,
        createdAtMs: proof.verifiedAtMs,
        prepareEvidence: (userId) => [
          recordWebOnboardingConsent({
            db,
            userId,
            attemptId: proof.attemptId,
            disclosure: proof.disclosure,
            acceptedAtMs: proof.acceptedAtMs,
          }),
        ],
        commit: proof.commit,
      }),
  });
