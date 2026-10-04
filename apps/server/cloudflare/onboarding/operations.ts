import { UserId } from "../../src/core/identity/contract";
import { prepareVerifiedIdentity } from "../identity/operations";
import { recordOnboardingConsent } from "../consent/operations";
import { verifyOnboardingEmail } from "../email-authentication/operations";
import { issueInitialBackupRecoveryCode } from "../recovery/operations";
import { newId } from "../secret-material/operations";
import type { OnboardingRequest } from "./contract";

/**
 * Create one stable User only after mandatory mailbox proof, composing all owners in one atomic
 * unit. On rejection nothing stable is created; success discloses one recovery code without
 * issuing a WebSession. Origin and ingress policy must already have run.
 */
export const completeOnboarding = ({ db, request }: OnboardingRequest): Promise<Response> =>
  verifyOnboardingEmail({
    db,
    request,
    complete: ({ exchangeId, verifiedAtMs, commit }) => {
      const userId = UserId.make(newId());
      const identity = prepareVerifiedIdentity({
        db,
        userId,
        exchangeId,
        createdAtMs: verifiedAtMs,
      });
      return issueInitialBackupRecoveryCode({
        db,
        userId,
        createdAtMs: verifiedAtMs,
        commit: (credential) =>
          commit({
            userId,
            statements: [
              identity.createUser,
              identity.associateCaller,
              recordOnboardingConsent({ db, userId, exchangeId }),
              identity.startTrial,
              credential,
            ],
          }),
      }).then((recoveryCode) =>
        Response.json(
          { status: "created", backupRecoveryCode: recoveryCode },
          { headers: { "cache-control": "no-store" } }
        )
      );
    },
  });
