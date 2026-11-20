import { BackupRecoveryCode, StartedBrowserLoginPairing } from "@fidy/server/client";
import { Data, type Effect, type Redacted, Schema } from "effect";

export const recoveryOperatorUrl = "https://api.fidyapp.com/internal/support-recovery";

export const RecoveryInput = Schema.Struct({
  pairingCode: StartedBrowserLoginPairing.fields.publicCode,
  backupRecoveryCode: Schema.RedactedFromValue(BackupRecoveryCode),
});
export type RecoveryInput = typeof RecoveryInput.Type;
export type RecoveryOutcome = "approved" | "not_approved" | "unavailable" | "uncertain";

export class RecoveryFailure extends Data.TaggedError("RecoveryFailure")<{
  reason: "InvalidInput" | "AccessUnavailable" | "Cancelled";
}> {}

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
