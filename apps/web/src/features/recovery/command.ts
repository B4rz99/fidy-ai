import { Effect, type Redacted } from "effect";
import type { Atom } from "effect/reactivity";
import type { BackupRecoveryCode, FidyClient } from "@/transport/client";

export type RotateBackupRecoveryCommand = Readonly<{
  onRotated: (code: Redacted.Redacted<BackupRecoveryCode>) => void;
  onUncertain: () => void;
  onUnauthenticated: () => void;
  onFreshSessionRequired: () => void;
}>;

export const makeRotateCommand = ({
  apiClient,
}: Readonly<{ apiClient: FidyClient }>): Atom.AtomResultFn<
  RotateBackupRecoveryCommand,
  void,
  never
> =>
  apiClient.runtime.fn<RotateBackupRecoveryCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        const response = yield* client.recovery.rotateBackupRecoveryCode();
        yield* Effect.sync(() => command.onRotated(response.data.backupRecoveryCode));
      }).pipe(
        Effect.catchTags({
          UserActionRequired: () => Effect.sync(command.onFreshSessionRequired),
          Unauthenticated: () => Effect.sync(command.onUnauthenticated),
        }),
        Effect.catchCause(() => Effect.sync(command.onUncertain))
      ),
    { concurrent: false }
  );
