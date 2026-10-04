import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Effect, Option } from "effect";
import { type Atom, Reactivity } from "effect/reactivity";
import { type JSX, useState } from "react";
import type { OAuthConnectionId, OAuthConnectionList, WebAuthClient } from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { OAuthManagementView } from "./management-view";

const connectionKey = "oauth-connections";
const makeRevocation = (
  client: WebAuthClient
): Atom.AtomResultFn<Option.Option<OAuthConnectionId>, boolean, never> =>
  client.runtime.fn<Option.Option<OAuthConnectionId>>()((id) =>
    client.pipe(
      Effect.flatMap((api) =>
        Option.match(id, {
          onNone: () => api.oauthConnections.revokeAll({ payload: {} }),
          onSome: (connectionId) => api.oauthConnections.revoke({ payload: { connectionId } }),
        })
      ),
      Effect.andThen(Reactivity.invalidate([connectionKey])),
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false))
    )
  );
const ManagementContent = ({
  listing,
  busy,
  revoke,
  next,
}: Readonly<{
  listing: CanonicalQueryState<OAuthConnectionList, unknown>;
  busy: boolean;
  revoke: (id: Option.Option<OAuthConnectionId>) => void;
  next: (id: OAuthConnectionId) => void;
}>): JSX.Element => {
  if (listing._tag === "Initial") return <output>Cargando agentes…</output>;
  if (listing._tag === "Failure") {
    return (
      <section>
        <p role="alert">
          No pudimos consultar los agentes. Puede que necesites iniciar sesión de nuevo; no
          mostramos una lista vacía ni confirmamos revocaciones.
        </p>
        <Button variant="outline" render={<Link to="/auth/pair" />}>
          Iniciar sesión de nuevo
        </Button>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3">
      {Option.isSome(listing.refreshFailure) ? (
        <p role="alert">
          No pudimos actualizar la lista. La información anterior puede haber cambiado.
        </p>
      ) : null}
      <OAuthManagementView
        list={listing.value}
        busy={busy || listing.waiting || Option.isSome(listing.refreshFailure)}
        revoke={(id) => revoke(Option.some(id))}
        revokeAll={() => revoke(Option.none())}
        next={next}
      />
    </section>
  );
};
export const ManagementPage = ({
  after,
}: Readonly<{ after: Option.Option<OAuthConnectionId> }>): JSX.Element => {
  const router = useRouter();
  const client = router.options.context.webAuthClient;
  const [query] = useState(() =>
    client.query("oauthConnections", "list", {
      query: { after },
      reactivityKeys: [connectionKey],
      timeToLive: "0 seconds",
    })
  );
  const listingResult = useAtomValue(query);
  const listing = presentCanonicalQuery(listingResult);
  const refresh = useAtomRefresh(query);
  const [command] = useState(() => makeRevocation(client));
  const result = useAtomValue(command);
  const revoke = useAtomSet(command);
  const next = (id: OAuthConnectionId): void => {
    router.navigate({ to: "/settings/agents", search: { after: id } }).catch(() => undefined);
  };
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="font-heading text-2xl font-semibold">Agentes conectados</h1>
      {result._tag === "Success" && !result.waiting ? (
        <p role={result.value ? "status" : "alert"}>
          {result.value
            ? "Acceso revocado. Las acciones ya realizadas se conservan."
            : "No pudimos confirmar la revocación. Actualiza la lista antes de intentar de nuevo."}
        </p>
      ) : null}
      <ManagementContent listing={listing} busy={result.waiting} revoke={revoke} next={next} />
      <Button type="button" variant="outline" disabled={result.waiting} onClick={refresh}>
        Actualizar lista
      </Button>
      {Option.isSome(after) ? (
        <Button variant="outline" render={<Link to="/settings/agents" search={{}} />}>
          Primera página
        </Button>
      ) : null}
    </main>
  );
};
