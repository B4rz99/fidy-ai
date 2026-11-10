import { PendingRead } from "@/ui/components/pending-read";

import { useAtomValue } from "@effect/atom-react";
import { Link, useRouter, useSearch } from "@tanstack/react-router";
import { Effect, Option, Schema } from "effect";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { PATPairingPublicCode, type PATPairingReview } from "@/transport/client";
import { FidyWordmark } from "@/ui/components/wordmark";
import { Button } from "@/ui/components/button";
import { PATPairingView } from "./pairing-view";
import { usePATPairing } from "./pairing";

const PairingTask = ({
  initialReview,
  publicCode,
}: Readonly<{
  initialReview: Option.Option<PATPairingReview>;
  publicCode: Option.Option<string>;
}>): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const { state, actions, lifecycleRef } = usePATPairing({ apiClient, initialReview, publicCode });
  return (
    <section ref={lifecycleRef}>
      <PATPairingView state={state} actions={actions} />
    </section>
  );
};
const CLIApproval = ({
  code,
}: Readonly<{ code: Option.Option<PATPairingPublicCode> }>): JSX.Element =>
  Option.isSome(code) ? (
    <PreselectedApproval code={code.value} />
  ) : (
    <PairingTask initialReview={Option.none()} publicCode={Option.none()} />
  );
const PreselectedApproval = ({
  code,
}: Readonly<{
  code: PATPairingPublicCode;
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
  if (result._tag === "Initial") return <PendingRead label="Cargando solicitud" />;
  if (result._tag === "Failure") {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert">
          La solicitud venció, no está disponible o necesitas iniciar sesión. Inicia sesión de nuevo
          o ejecuta fidy login para comenzar otra conexión.
        </p>
        <Button render={<Link to="/login" reloadDocument search={{ cliCode: code }} />}>
          Iniciar sesión de nuevo
        </Button>
      </div>
    );
  }
  return (
    <PairingTask
      key={code}
      initialReview={Option.some(result.value.data)}
      publicCode={Option.some(code)}
    />
  );
};
/** Public links select a request; only an explicit approval click grants access. */
export const CLIConnectionFeature = (): JSX.Element => {
  const search = useSearch({ strict: false });
  const { sessionBinding } = useRouter().options.context;
  const code = Schema.decodeUnknownOption(PATPairingPublicCode)(search.cliCode);
  return (
    <main className="signed-in-theme flex min-h-svh justify-center bg-background px-5 py-10">
      <section className="flex w-full max-w-xl flex-col gap-6">
        <FidyWordmark />
        <h1 className="text-2xl font-semibold">Conectar la CLI</h1>
        <p className="text-sm text-muted-foreground">
          Autoriza únicamente una conexión que hayas iniciado con fidy login.
        </p>
        <CLIApproval
          key={`${sessionBinding}:${Option.getOrElse(code, () => "manual")}`}
          code={code}
        />
      </section>
    </main>
  );
};
