import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useRouter, useSearch } from "@tanstack/react-router";
import { Effect, Option, Schema } from "effect";
import { type Atom } from "effect/reactivity";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { type FidyClient, PATPairingPublicCode } from "@/transport/client";
import { FidyWordmark } from "@/ui/components/wordmark";
import { Button } from "@/ui/components/button";
import {
  type ApprovePATPairingCommand,
  type InspectPATPairingCommand,
  PATPairingView,
} from "./pairing-view";

const makeInspectPairingCommand = (
  apiClient: FidyClient
): Atom.AtomResultFn<InspectPATPairingCommand, void, never> =>
  apiClient.runtime.fn<InspectPATPairingCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        const response = yield* client.pats.inspectPATPairing({
          payload: { publicCode: command.publicCode },
        });
        yield* Effect.sync(() => command.onInspected(response.data));
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );

const makeApprovePairingCommand = (
  apiClient: FidyClient
): Atom.AtomResultFn<ApprovePATPairingCommand, void, never> =>
  apiClient.runtime.fn<ApprovePATPairingCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        yield* client.pats.approvePATPairing({
          payload: { pairingId: command.pairingId },
        });
        yield* Effect.sync(command.onApproved);
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );

const CLIApproval = ({
  code,
}: Readonly<{ code: Option.Option<PATPairingPublicCode> }>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [inspectAtom] = useState(() => makeInspectPairingCommand(client));
  const [approveAtom] = useState(() => makeApprovePairingCommand(client));
  const inspect = useAtomSet(inspectAtom);
  const approve = useAtomSet(approveAtom);
  return Option.isSome(code) ? (
    <PreselectedApproval code={code.value} inspect={inspect} approve={approve} />
  ) : (
    <PATPairingView
      initialReview={Option.none()}
      publicCode={Option.none()}
      inspect={inspect}
      approve={approve}
    />
  );
};
const PreselectedApproval = ({
  code,
  inspect,
  approve,
}: Readonly<{
  code: PATPairingPublicCode;
  inspect: (command: InspectPATPairingCommand) => void;
  approve: (command: ApprovePATPairingCommand) => void;
}>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [request] = useState(() =>
    client.runtime.atom(
      client.pipe(
        Effect.flatMap((api) => api.pats.inspectPATPairing({ payload: { publicCode: code } }))
      )
    )
  );
  const result = useAtomValue(request).pipe(presentCanonicalQuery);
  if (result._tag === "Initial") return <output>Cargando solicitud…</output>;
  if (result._tag === "Failure") {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert">
          La solicitud venció, no está disponible o requiere una sesión reciente. Inicia sesión de
          nuevo o ejecuta fidy login para comenzar otra conexión.
        </p>
        <Button render={<Link to="/auth/pair" search={{ cliCode: code }} />}>
          Iniciar sesión de nuevo
        </Button>
      </div>
    );
  }
  return (
    <PATPairingView
      key={code}
      initialReview={Option.some(result.value.data)}
      publicCode={Option.some(code)}
      inspect={inspect}
      approve={approve}
    />
  );
};
/** Dedicated browser approval. Public links select a request; only an explicit click grants access. */
export const CLIConnectionFeature = (): JSX.Element => {
  const search = useSearch({ strict: false });
  const code = Schema.decodeUnknownOption(PATPairingPublicCode)(search.cliCode);
  return (
    <main className="signed-in-theme flex min-h-svh justify-center bg-background px-5 py-10">
      <section className="flex w-full max-w-xl flex-col gap-6">
        <FidyWordmark />
        <h1 className="text-2xl font-semibold">Conectar la CLI</h1>
        <p className="text-sm text-muted-foreground">
          Autoriza únicamente una conexión que hayas iniciado con fidy login.
        </p>
        <CLIApproval key={Option.getOrElse(code, () => "manual")} code={code} />
      </section>
    </main>
  );
};
