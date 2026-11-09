import { Effect, Redacted, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import type { BackupRecoveryCode, FidyClient } from "@/transport/client";

export type RotateBackupRecoveryCommand = Readonly<{
  onRotated: (code: BackupRecoveryCode) => void;
  onFailed: () => void;
  onFreshSessionRequired: () => void;
}>;

const FreshSessionRequired = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("user_action_required") }),
});

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
        yield* Effect.sync(() =>
          command.onRotated(Redacted.value(response.data.backupRecoveryCode))
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(
            Schema.is(FreshSessionRequired)(error)
              ? command.onFreshSessionRequired
              : command.onFailed
          )
        )
      ),
    { concurrent: false }
  );
