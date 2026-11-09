import { BackupRecoveryRotationPresentation, type RotationState } from "./view";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option, Redacted } from "effect";
import { type JSX, useRef, useState } from "react";
import { type SensitiveClipboard, sensitiveClipboardLifetime } from "@/browser/sensitive-clipboard";
import { SensitiveClipboardBoundary } from "@/browser/use-sensitive-clipboard";
import type { BackupRecoveryCode } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { type RotateBackupRecoveryCommand, makeRotateCommand } from "./command";

type DisclosureState =
  | Exclude<RotationState, { _tag: "Disclosed" }>
  | Readonly<{ _tag: "Disclosed"; code: Redacted.Redacted<BackupRecoveryCode>; copied: boolean }>;

type RotationViewProps = Readonly<{
  rotate: (command: RotateBackupRecoveryCommand) => void;
  clipboard: SensitiveClipboard;
}>;

const RecoveryDisclosure = ({
  code,
}: Readonly<{ code: Redacted.Redacted<BackupRecoveryCode> }>): JSX.Element => (
  <Alert>
    <AlertTitle>Guárdalo ahora</AlertTitle>
    <AlertDescription className="flex flex-col gap-3">
      <span>Este código se muestra una sola vez. Guárdalo fuera de Fidy y no lo compartas.</span>
      <code className="break-all text-base font-semibold">{Redacted.value(code)}</code>
    </AlertDescription>
  </Alert>
);

/** Mounted disclosure view; replacing its React identity irreversibly drops the code state. */
export const BackupRecoveryRotationView = ({
  rotate,
  clipboard,
}: RotationViewProps): JSX.Element => {
  const [state, setState] = useState<DisclosureState>({ _tag: "Idle" });
  const admission = useRef<DisclosureState>(state);
  const publish = (next: DisclosureState): void => {
    admission.current = next;
    setState(next);
  };
  const review = (): void => {
    if (admission.current._tag !== "Idle" && admission.current._tag !== "Failed") return;
    publish({ _tag: "Reviewing" });
  };
  const cancel = (): void => {
    if (state._tag !== "Reviewing" || admission.current !== state) return;
    publish({ _tag: "Idle" });
  };
  const confirm = (): void => {
    if (state._tag !== "Reviewing" || admission.current !== state) return;
    const submitting = { _tag: "Rotating" } as const;
    publish(submitting);
    const complete = (next: DisclosureState): void => {
      if (admission.current === submitting) publish(next);
    };
    rotate({
      onRotated: (code) => complete({ _tag: "Disclosed", code, copied: false }),
      onFailed: () => complete({ _tag: "Failed" }),
      onFreshSessionRequired: () => complete({ _tag: "FreshSessionRequired" }),
    });
  };
  const copyCode = (): void => {
    if (state._tag !== "Disclosed" || admission.current !== state) return;
    clipboard.copy(Redacted.value(state.code), () => {
      if (admission.current === state) publish({ ...state, copied: true });
    });
  };
  const view: RotationState =
    state._tag === "Disclosed" ? { _tag: "Disclosed", copied: state.copied } : state;

  return (
    <BackupRecoveryRotationPresentation
      state={view}
      disclosure={state._tag === "Disclosed" ? <RecoveryDisclosure code={state.code} /> : null}
      onStart={review}
      onConfirm={confirm}
      onCancel={cancel}
      onCopy={copyCode}
    />
  );
};

export const BackupRecoveryFeature = (): JSX.Element => {
  const router = useRouter();
  const [rotateAtom] = useState(() =>
    makeRotateCommand({ apiClient: router.options.context.apiClient })
  );
  const rotate = useAtomSet(rotateAtom);
  return (
    <SensitiveClipboardBoundary className={Option.none()} lifetime={sensitiveClipboardLifetime}>
      {(clipboard) => <BackupRecoveryRotationView clipboard={clipboard} rotate={rotate} />}
    </SensitiveClipboardBoundary>
  );
};
