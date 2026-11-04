import { useSearch } from "@tanstack/react-router";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effect, Exit, Option } from "effect";
import { Atom } from "effect/reactivity";
import { type ComponentType, type JSX, type ReactNode, useState } from "react";
import type { FidyClient } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { PendingRead } from "@/ui/components/pending-read";
import { dashboardHtmlQuery } from "./html-query";

const initialization = Atom.family((apiClient: FidyClient) =>
  apiClient.runtime.fn<void>()(() =>
    Effect.gen(function* () {
      const client = yield* apiClient;
      return yield* client.dashboard.initializeDashboard();
    })
  )
);
type EditorProps = Readonly<{ apiClient: FidyClient; onRefreshHtml: () => void }>;
type Props = Readonly<{
  apiClient: FidyClient;
  children: ReactNode;
  editor: ComponentType<EditorProps>;
}>;
const InitializeDashboard = ({
  apiClient,
  onRefresh,
}: Readonly<{ apiClient: FidyClient; onRefresh: () => void }>): JSX.Element => {
  const atom = initialization(apiClient);
  const state = useAtomValue(atom);
  const initialize = useAtomSet(atom, { mode: "promiseExit" });
  return (
    <main>
      <h1>Tu tablero</h1>
      <p>Crea tu tablero para empezar.</p>
      {state._tag === "Failure" ? (
        <p role="alert">No pudimos crear tu tablero. Intenta de nuevo.</p>
      ) : null}
      <Button
        disabled={state.waiting}
        onClick={() =>
          initialize().then((exit) => {
            if (Exit.isSuccess(exit)) onRefresh();
          })
        }
      >
        Crear tablero
      </Button>
    </main>
  );
};
const ReadFailure = ({ onRefresh }: Readonly<{ onRefresh: () => void }>): JSX.Element => (
  <main role="alert">
    <h1>No pudimos cargar tu tablero</h1>
    <Button onClick={onRefresh}>Reintentar carga del tablero</Button>
  </main>
);

const DashboardHtmlRead = ({ apiClient, children }: Props): JSX.Element => {
  const [query] = useState(() => dashboardHtmlQuery(apiClient));
  const result = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const state = presentCanonicalQuery(result);
  if (state._tag === "Initial" || state.waiting) {
    return (
      <div data-dashboard-read-state="pending">
        <PendingRead label="Cargando tablero" />
      </div>
    );
  }
  if (state._tag === "Failure" || Option.isSome(state.refreshFailure)) {
    return <ReadFailure onRefresh={refresh} />;
  }
  if (state.value.status === "uninitialized") {
    return <InitializeDashboard apiClient={apiClient} onRefresh={refresh} />;
  }
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: state.value.html }} />
      {children}
    </>
  );
};

const noRefresh = (): void => undefined;
export const DashboardHtmlFeature = (props: Props): JSX.Element => {
  const customizing = useSearch({ strict: false }).customize === 1;
  const Editor = props.editor;
  return customizing ? (
    <Editor apiClient={props.apiClient} onRefreshHtml={noRefresh} />
  ) : (
    <DashboardHtmlRead {...props} />
  );
};
