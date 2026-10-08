import { completeProviderAuthentication } from "../provider-authentication/operations";
import { recordOnboardingConsent, recordWebOnboardingConsent } from "../consent/operations";
import type { OnboardingRequest } from "./contract";
import { completeEnrollment } from "./internal/completion";

/** Complete the proven provider origin and any explicitly confirmed initial WhatsApp association, with atomic Consent, credential, TrialPeriod and recovery creation and separate Browser Login approval. */
export const completeProviderOnboarding = ({ db, request }: OnboardingRequest): Promise<Response> =>
  completeProviderAuthentication({
    db,
    request,
    complete: (proof) =>
      completeEnrollment({
        db,
        createdAtMs: proof.verifiedAtMs,
        prepareEvidence: (userId) => [
          proof.origin._tag === "WhatsApp"
            ? recordOnboardingConsent({ db, userId, exchangeId: proof.origin.exchangeId })
            : recordWebOnboardingConsent({
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
