import { BackupRecoveryCode, StartedBrowserLoginPairing } from "@fidy/server/client";
import { Data, type Effect, type Redacted, Schema } from "effect";

export const recoveryOperatorUrl = "https://api.fidyapp.com/internal/support-recovery";

/** Private operator input; the browser verifier is never collected by support. */
export const RecoveryInput = Schema.Struct({
  pairingCode: StartedBrowserLoginPairing.fields.publicCode,
  backupRecoveryCode: Schema.RedactedFromValue(BackupRecoveryCode),
});
export type RecoveryInput = typeof RecoveryInput.Type;
export type RecoveryOutcome = "approved" | "not_approved" | "unavailable" | "uncertain";

/** Closed local failures contain neither operator assertion nor claimant proof. */
export class RecoveryFailure extends Data.TaggedError("RecoveryFailure")<{
  reason: "InvalidInput" | "AccessUnavailable" | "Cancelled";
}> {}

/** Interactive operator transport, independent of saved PAT authority and local User storage. */
export type RecoveryOperator = Readonly<{
  interactive: boolean;
  authenticate: Effect.Effect<Redacted.Redacted<string>, RecoveryFailure>;
  readPairing: Effect.Effect<string, RecoveryFailure>;
  readCode: Effect.Effect<Redacted.Redacted<string>, RecoveryFailure>;
  submit: (
    input: RecoveryInput,
    assertion: Redacted.Redacted<string>
  ) => Effect.Effect<RecoveryOutcome>;
  write: (text: string) => Effect.Effect<void>;
}>;
