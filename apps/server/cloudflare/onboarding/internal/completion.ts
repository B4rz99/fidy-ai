import { UserId } from "@fidy/server/identity-reference";
import { prepareVerifiedIdentity } from "../../identity/operations";
import { recordOnboardingConsent } from "../../consent/operations";
import { verifyOnboardingEmail } from "../../email-authentication/operations";
import { issueInitialBackupRecoveryCode } from "../../recovery/operations";
import { newId } from "../../secret-material/operations";
import type { OnboardingRequest } from "../contract";

export const complete = ({ db, request }: OnboardingRequest): Promise<Response> =>
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
