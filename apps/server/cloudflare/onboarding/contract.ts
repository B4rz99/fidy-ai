import type { BackupRecoveryCode } from "../../src/core/recovery/contract";

/**
 * Verification never establishes a browser session. Only a successful atomic completion discloses
 * the new User's one-time recovery code; rejected attempts disclose no owner state or proof material.
 */
export type OnboardingCompletion =
  | Readonly<{ _tag: "Created"; backupRecoveryCode: BackupRecoveryCode }>
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "Unavailable" }>;
