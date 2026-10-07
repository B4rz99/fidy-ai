import { UserId } from "../../../src/core/identity/contract";
import { prepareUserCreation } from "../../identity/operations";
import { issueInitialBackupRecoveryCode } from "../../recovery/operations";
import { newId } from "../../secret-material/operations";

type EnrollmentCompletion = Readonly<{
  db: D1Database;
  createdAtMs: number;
  prepareEvidence: (userId: UserId) => ReadonlyArray<D1PreparedStatement>;
  commit: (
    input: Readonly<{
      userId: UserId;
      statements: ReadonlyArray<D1PreparedStatement>;
    }>
  ) => Promise<void>;
}>;

/**
 * The private onboarding composition runs only inside an originating owner's verified-proof
 * callback. Its evidence preparation must bind Consent and any channel association to this new
 * User; its one-use commit must add and consume the exact current proof in the same atomic unit.
 * No prepared action may execute separately. Release recovery material only after that commit.
 */
export const completeEnrollment = ({
  db,
  createdAtMs,
  prepareEvidence,
  commit,
}: EnrollmentCompletion): Promise<Response> => {
  const userId = UserId.make(newId());
  const identity = prepareUserCreation({ db, userId, createdAtMs });
  return issueInitialBackupRecoveryCode({
    db,
    userId,
    createdAtMs,
    commit: (credential) =>
      commit({
        userId,
        statements: [
          identity.createUser,
          ...prepareEvidence(userId),
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
};
