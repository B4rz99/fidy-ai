import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Redacted } from "effect";
import type { Atom } from "effect/unstable/reactivity";
import { type JSX, useState } from "react";
import type { BackupRecoveryCode, FidyClient } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/ui/components/card";

/** Terminal callbacks for one fresh-WebSession credential rotation. */
export type RotateBackupRecoveryCommand = Readonly<{
  onRotated: (code: BackupRecoveryCode) => void;
  onFailed: () => void;
}>;

type RotationState =
  | Readonly<{ _tag: "Idle" }>
  | Readonly<{ _tag: "Rotating" }>
  | Readonly<{ _tag: "Disclosed"; code: BackupRecoveryCode; copied: boolean }>
  | Readonly<{ _tag: "Failed" }>;

type RotationViewProps = Readonly<{
  rotate: (command: RotateBackupRecoveryCommand) => void;
  copy: (code: BackupRecoveryCode) => void;
}>;

const RotationFeedback = ({ state }: { state: RotationState }): JSX.Element => (
  <CardContent className="flex flex-col gap-4">
    {state._tag === "Disclosed" ? (
      <Alert>
        <AlertTitle>Guárdalo ahora</AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <span>
            Este código se muestra una sola vez. Guárdalo fuera de Fidy y no lo compartas.
          </span>
          <code className="break-all text-base font-semibold">{state.code}</code>
        </AlertDescription>
      </Alert>
    ) : null}
    {state._tag === "Failed" ? (
      <Alert variant="destructive">
        <AlertTitle>No pudimos confirmar el código nuevo.</AlertTitle>
        <AlertDescription>
          Intenta crear otro código antes de cerrar esta página. Usa únicamente el último código que
          veas.
        </AlertDescription>
      </Alert>
    ) : null}
  </CardContent>
);

const actionLabel = (state: RotationState): string => {
  if (state._tag === "Rotating") return "Creando código…";
  if (state._tag === "Failed") return "Intentar de nuevo";
  return "Crear un código nuevo";
};

const RotationAction = (props: {
  state: RotationState;
  onStart: () => void;
  onCopy: () => void;
}): JSX.Element => (
  <CardFooter className="flex flex-wrap gap-2">
    {props.state._tag === "Disclosed" ? (
      <Button onClick={props.onCopy} type="button">
        {props.state.copied ? "Copiado" : "Copiar código"}
      </Button>
    ) : (
      <Button disabled={props.state._tag === "Rotating"} onClick={props.onStart} type="button">
        {actionLabel(props.state)}
      </Button>
    )}
  </CardFooter>
);

/** Mounted disclosure view; replacing its React identity irreversibly drops the raw code state. */
export const BackupRecoveryRotationView = ({ rotate, copy }: RotationViewProps): JSX.Element => {
  const [state, setState] = useState<RotationState>({ _tag: "Idle" });
  const start = (): void => {
    setState({ _tag: "Rotating" });
    rotate({
      onRotated: (code) => setState({ _tag: "Disclosed", code, copied: false }),
      onFailed: () => setState({ _tag: "Failed" }),
    });
  };
  const copyCode = (): void => {
    if (state._tag !== "Disclosed") return;
    copy(state.code);
    setState({ ...state, copied: true });
  };

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Código de recuperación</CardTitle>
          <CardDescription>
            Reemplaza el código anterior después de recuperar tu acceso. El código anterior dejará
            de funcionar de inmediato.
          </CardDescription>
        </CardHeader>
        <RotationFeedback state={state} />
        <RotationAction onCopy={copyCode} onStart={start} state={state} />
      </Card>
    </main>
  );
};

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
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );

const copyRecoveryCode = (code: BackupRecoveryCode): void => {
  Effect.runFork(Effect.promise(() => navigator.clipboard.writeText(code)).pipe(Effect.ignore));
};

/** Coordinates the canonical mutation without retaining its raw response in shared Atom state. */
export const BackupRecoveryFeature = (): JSX.Element => {
  const router = useRouter();
  const [rotateAtom] = useState(() => makeRotateCommand(router.options.context.apiClient));
  return <BackupRecoveryRotationView copy={copyRecoveryCode} rotate={useAtomSet(rotateAtom)} />;
};
