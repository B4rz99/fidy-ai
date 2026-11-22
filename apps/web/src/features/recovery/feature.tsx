import { BackupRecoveryRotationPresentation } from "./view";
import { DisclosureState, RotationState } from "./view-state";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option, Redacted } from "effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import {
  type Dispatch,
  type JSX,
  type RefCallback,
  type SetStateAction,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import {
  type CopyRelease,
  type SensitiveClipboard,
  sensitiveClipboardLifetime,
} from "@/browser/sensitive-clipboard";
import { SensitiveClipboardBoundary } from "@/browser/use-sensitive-clipboard";
import { authenticationEndedEvent } from "@/session/authentication-channel";
import type { BackupRecoveryCode, FidyClient } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { type RotateBackupRecoveryCommand, createRotateCommand } from "./command";

const rotationUnresolved = Atom.make(false).pipe(Atom.keepAlive);

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

type RecoveryOwner = {
  current: DisclosureState;
  copyRelease: Option.Option<CopyRelease>;
  active: boolean;
  setState: Dispatch<SetStateAction<DisclosureState>>;
};

const publish = (owner: RecoveryOwner, next: DisclosureState): void => {
  if (!owner.active) {
    return;
  }

  owner.current = next;
  owner.setState(next);
};

const confirmRotation = (
  owner: RecoveryOwner,
  review: DisclosureState,
  operation: Readonly<{
    registry: AtomRegistry.AtomRegistry;
    rotate: (command: RotateBackupRecoveryCommand) => void;
  }>
): void => {
  if (
    !owner.active ||
    !DisclosureState.$is("Reviewing")(review) ||
    owner.current !== review ||
    operation.registry.get(rotationUnresolved)
  ) {
    return;
  }

  const submitting = DisclosureState.Rotating();
  operation.registry.set(rotationUnresolved, true);
  publish(owner, submitting);

  const complete = (next: DisclosureState): void => {
    if (owner.active && owner.current === submitting) {
      if (!DisclosureState.$is("Uncertain")(next)) {
        operation.registry.set(rotationUnresolved, false);
      }

      publish(owner, next);
    } else if (DisclosureState.$is("Disclosed")(next)) {
      Redacted.wipeUnsafe(next.code);
    }
  };

  operation.rotate({
    onRotated: (code) => complete(DisclosureState.Disclosed({ code, copied: false })),
    onUncertain: () => complete(DisclosureState.Uncertain()),
    onUnauthenticated: () => complete(DisclosureState.Unauthenticated()),
    onFreshSessionRequired: () => complete(DisclosureState.FreshSessionRequired()),
  });
};

const mountRecoveryTask =
  (owner: RecoveryOwner, requiresObservation: boolean): RefCallback<HTMLDivElement> =>
  (node) => {
    if (node === null) {
      return;
    }

    owner.active = true;

    if (DisclosureState.$is("Disposed")(owner.current)) {
      owner.current = requiresObservation ? DisclosureState.Uncertain() : DisclosureState.Idle();
      owner.setState(owner.current);
    }

    const dispose = (): void => {
      owner.active = false;
      const previous = owner.current;
      owner.current = DisclosureState.Disposed();
      const copyRelease = owner.copyRelease;
      owner.copyRelease = Option.none();

      if (DisclosureState.$is("Disclosed")(previous)) {
        Redacted.wipeUnsafe(previous.code);
      }

      if (Option.isSome(copyRelease)) {
        copyRelease.value.release();
      }
    };

    const hide = (): void => {
      dispose();
      owner.setState(DisclosureState.Disposed());
    };

    window.addEventListener("pagehide", hide);
    window.addEventListener(authenticationEndedEvent, hide);

    return (): void => {
      dispose();
      window.removeEventListener("pagehide", hide);
      window.removeEventListener(authenticationEndedEvent, hide);
    };
  };

const beginReview = (owner: RecoveryOwner, unresolved: boolean): void => {
  if (!owner.active || !DisclosureState.$is("Idle")(owner.current) || unresolved) {
    return;
  }

  publish(owner, DisclosureState.Reviewing());
};

const rotationView = (state: DisclosureState): RotationState =>
  DisclosureState.$is("Disclosed")(state)
    ? RotationState.Disclosed({ copied: state.copied })
    : state;

const MountedRecoveryTask = ({ apiClient, clipboard }: RotationViewProps): JSX.Element => {
  const registry = useContext(RegistryContext);

  const [state, setState] = useState<DisclosureState>(() =>
    registry.get(rotationUnresolved) ? DisclosureState.Uncertain() : DisclosureState.Idle()
  );

  const owner = useRef<RecoveryOwner>({
    current: state,
    copyRelease: Option.none(),
    active: false,
    setState,
  }).current;

  const lifecycleRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => mountRecoveryTask(owner, registry.get(rotationUnresolved))(node),
    [owner, registry]
  );

  const [rotateAtom] = useState(() => createRotateCommand({ apiClient }));
  const rotate = useAtomSet(rotateAtom);

  const review = (): void => beginReview(owner, registry.get(rotationUnresolved));

  const cancel = (): void => {
    if (!owner.active || !DisclosureState.$is("Reviewing")(state) || owner.current !== state) {
      return;
    }

    publish(owner, DisclosureState.Idle());
  };

  const confirm = (): void => confirmRotation(owner, state, { registry, rotate });

  const copyCode = (): void => {
    if (!owner.active || !DisclosureState.$is("Disclosed")(state) || owner.current !== state) {
      return;
    }

    owner.copyRelease = Option.some(
      clipboard.copy(Redacted.value(state.code), () => {
        if (owner.active && owner.current === state) {
          publish(owner, DisclosureState.Disclosed({ code: state.code, copied: true }));
        }
      })
    );
  };

  return (
    <div ref={lifecycleRef}>
      <BackupRecoveryRotationPresentation
        state={rotationView(state)}
        disclosure={
          DisclosureState.$is("Disclosed")(state) ? <RecoveryDisclosure code={state.code} /> : null
        }
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
