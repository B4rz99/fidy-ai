import type { Effect } from "effect";
import type { BackupRecoveryCode } from "../../src/core/recovery/contract";
import type {
  InitialRecoveryEnrollment,
  RecoveryRequest,
  SupportRecoveryRequest,
} from "./contract";
import { issueInitialCode } from "./internal/enrollment";
import { rotateBackupRecoveryCode as rotate } from "./internal/rotation";
import { handleSupportRecovery as handleSupport } from "./internal/support-recovery";

/**
 * Generate emergency proof for this verified new User, disclosing it only after the caller's
 * complete enrollment unit commits. Only its digest enters storage; send the returned code once
 * in the immediate no-store enrollment response, never to logs, durable work or another owner.
 */
export const issueInitialBackupRecoveryCode = (
  input: InitialRecoveryEnrollment
): Promise<BackupRecoveryCode> => issueInitialCode(input);

/** Replace the exact User's emergency proof under current fresh-session authority, disclosed once. */
export const rotateBackupRecoveryCode = (input: RecoveryRequest): Promise<Response> =>
  rotate(input);

/**
 * Verify the operator and consume an unused code in the exact pending pairing's atomic tracked
 * decision. The code's existing User cannot be substituted; approval never creates a User,
 * changes WhatsAppIdentity or creates a session without the browser's independent verifier.
 */
export const handleSupportRecovery = (input: SupportRecoveryRequest): Effect.Effect<Response> =>
  handleSupport(input);
