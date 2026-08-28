import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { RotatedBackupRecoveryCode } from "~/core/recovery/model";
import {
  AtomicBatchEligible,
  freshWebSessionOnly,
  operationPolicy,
} from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

const rotateBackupRecoveryCode = HttpApiEndpoint.post(
  "rotateBackupRecoveryCode",
  "/recovery/backup-code/rotate",
  { success: OperationResponse(RotatedBackupRecoveryCode) }
)
  .annotate(
    OpenApi.Description,
    "Replace the User's one-time BackupRecoveryCode from a freshly paired browser session and disclose the new code once."
  )
  .annotate(AtomicBatchEligible, false)
  .annotateMerge(
    operationPolicy({
      access: freshWebSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

/** Fresh first-party browser operation for replacing consumed or exposed recovery authority. */
export const RecoveryGroup = HttpApiGroup.make("recovery").add(rotateBackupRecoveryCode);
