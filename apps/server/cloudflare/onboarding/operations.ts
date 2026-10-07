import { prepareOnboardingWhatsAppAssociation } from "../identity/operations";
import { recordOnboardingConsent } from "../consent/operations";
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
