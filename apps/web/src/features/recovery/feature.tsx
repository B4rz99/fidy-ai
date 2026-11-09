import { BackupRecoveryRotationPresentation, type RotationState } from "./view";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option, Redacted } from "effect";
import {
  type Dispatch,
  type JSX,
  type RefCallback,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";
import { type SensitiveClipboard, sensitiveClipboardLifetime } from "@/browser/sensitive-clipboard";
import { SensitiveClipboardBoundary } from "@/browser/use-sensitive-clipboard";
import { authenticationEndedEvent } from "@/session/authentication-channel";
import type { BackupRecoveryCode, FidyClient } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { makeRotateCommand } from "./command";

type DisclosureState =
  | Exclude<RotationState, { _tag: "Disclosed" }>
  | Readonly<{ _tag: "Disclosed"; code: Redacted.Redacted<BackupRecoveryCode>; copied: boolean }>;

type RotationViewProps = Readonly<{
  apiClient: FidyClient;
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

type RecoveryOwner = { current: DisclosureState; active: boolean };

const mountRecoveryTask =
  (
    owner: RecoveryOwner,
    clipboard: SensitiveClipboard,
    setState: Dispatch<SetStateAction<DisclosureState>>
  ): RefCallback<HTMLDivElement> =>
  (node) => {
    if (node === null) return;
    owner.active = true;
    if (owner.current._tag === "Disposed") {
      owner.current = { _tag: "Idle" };
      setState(owner.current);
    }
    const dispose = (): void => {
      owner.active = false;
      const previous = owner.current;
      owner.current = { _tag: "Disposed" };
      if (previous._tag === "Disclosed") {
        clipboard.clear(Redacted.value(previous.code));
        Redacted.wipeUnsafe(previous.code);
      }
    };
    const hide = (): void => {
      dispose();
      setState({ _tag: "Disposed" });
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener(authenticationEndedEvent, hide);
    return (): void => {
      dispose();
      window.removeEventListener("pagehide", hide);
      window.removeEventListener(authenticationEndedEvent, hide);
    };
  };

/** Mounted disclosure view; replacing its React identity irreversibly drops the code state. */
const MountedRecoveryTask = ({ apiClient, clipboard }: RotationViewProps): JSX.Element => {
  const [state, setState] = useState<DisclosureState>({ _tag: "Idle" });
  const owner = useRef<RecoveryOwner>({ current: state, active: false }).current;
  const lifecycleRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => mountRecoveryTask(owner, clipboard, setState)(node),
    [owner, clipboard]
  );
  const [rotateAtom] = useState(() => makeRotateCommand({ apiClient }));
  const rotate = useAtomSet(rotateAtom);
  const publish = (next: DisclosureState): void => {
    if (!owner.active) return;
    owner.current = next;
    setState(next);
  };
  const review = (): void => {
    if (!owner.active || owner.current._tag !== "Idle") return;
    publish({ _tag: "Reviewing" });
  };
  const cancel = (): void => {
    if (!owner.active || state._tag !== "Reviewing" || owner.current !== state) return;
    publish({ _tag: "Idle" });
  };
  const confirm = (): void => {
    if (!owner.active || state._tag !== "Reviewing" || owner.current !== state) return;
    const submitting = { _tag: "Rotating" } as const;
    publish(submitting);
    const complete = (next: DisclosureState): void => {
      if (owner.active && owner.current === submitting) publish(next);
      else if (next._tag === "Disclosed") Redacted.wipeUnsafe(next.code);
    };
    rotate({
      onRotated: (code) => complete({ _tag: "Disclosed", code, copied: false }),
      onUncertain: () => complete({ _tag: "Uncertain" }),
      onUnauthenticated: () => complete({ _tag: "Unauthenticated" }),
      onFreshSessionRequired: () => complete({ _tag: "FreshSessionRequired" }),
    });
  };
  const copyCode = (): void => {
    if (!owner.active || state._tag !== "Disclosed" || owner.current !== state) return;
    clipboard.copy(Redacted.value(state.code), () => {
      if (owner.active && owner.current === state) publish({ ...state, copied: true });
    });
  };
  const view: RotationState =
    state._tag === "Disclosed" ? { _tag: "Disclosed", copied: state.copied } : state;

  return (
    <div ref={lifecycleRef}>
      <BackupRecoveryRotationPresentation
        state={view}
        disclosure={state._tag === "Disclosed" ? <RecoveryDisclosure code={state.code} /> : null}
        onStart={review}
        onConfirm={confirm}
        onCancel={cancel}
        onCopy={copyCode}
      />
    </div>
  );
};

export const BackupRecoveryFeature = (): JSX.Element => {
  const router = useRouter();
  return (
    <SensitiveClipboardBoundary className={Option.none()} lifetime={sensitiveClipboardLifetime}>
      {(clipboard) => (
        <MountedRecoveryTask clipboard={clipboard} apiClient={router.options.context.apiClient} />
      )}
    </SensitiveClipboardBoundary>
  );
};
