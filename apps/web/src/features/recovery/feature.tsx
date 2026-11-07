import { BackupRecoveryRotationPresentation, type RotationState } from "./view";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Option, Redacted, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import { type JSX, useState } from "react";
import { type SensitiveClipboard, sensitiveClipboardLifetime } from "@/browser/sensitive-clipboard";
import { SensitiveClipboardBoundary } from "@/browser/use-sensitive-clipboard";
import type { BackupRecoveryCode, FidyClient } from "@/transport/client";

export type RotateBackupRecoveryCommand = Readonly<{
  onRotated: (code: BackupRecoveryCode) => void;
  onFailed: () => void;
  onFreshSessionRequired: () => void;
}>;

type RotationViewProps = Readonly<{
  rotate: (command: RotateBackupRecoveryCommand) => void;
  clipboard: SensitiveClipboard;
}>;

/** Mounted disclosure view; replacing its React identity irreversibly drops the raw code state. */
export const BackupRecoveryRotationView = ({
  rotate,
  clipboard,
}: RotationViewProps): JSX.Element => {
  const [state, setState] = useState<RotationState>({ _tag: "Idle" });
  const start = (): void => {
    setState({ _tag: "Rotating" });
    rotate({
      onRotated: (code) => setState({ _tag: "Disclosed", code, copied: false }),
      onFailed: () => setState({ _tag: "Failed" }),
      onFreshSessionRequired: () => setState({ _tag: "FreshSessionRequired" }),
    });
  };
  const copyCode = (): void => {
    if (state._tag !== "Disclosed") return;
    clipboard.copy(state.code, () => setState({ ...state, copied: true }));
  };

  return <BackupRecoveryRotationPresentation state={state} onStart={start} onCopy={copyCode} />;
};

const FreshSessionRequired = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("user_action_required") }),
});

const makeRotateCommand = (
  apiClient: FidyClient
): Atom.AtomResultFn<RotateBackupRecoveryCommand, void, never> =>
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

export const BackupRecoveryFeature = (): JSX.Element => {
  const router = useRouter();
  const [rotateAtom] = useState(() => makeRotateCommand(router.options.context.apiClient));
  const rotate = useAtomSet(rotateAtom);
  return (
    <SensitiveClipboardBoundary className={Option.none()} lifetime={sensitiveClipboardLifetime}>
      {(clipboard) => <BackupRecoveryRotationView clipboard={clipboard} rotate={rotate} />}
    </SensitiveClipboardBoundary>
  );
};
