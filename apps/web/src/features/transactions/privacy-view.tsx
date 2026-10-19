import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { TransactionWorkspace } from "./workspace";
import { privacyTransactionHistory } from "./privacy-history";

const ReadOnlyNotice = (): JSX.Element => (
  <div className="m-5">
    <Alert>
      <AlertTitle>Solo lectura</AlertTitle>
      <AlertDescription>
        Tu autorización está retirada. Puedes consultar tus transacciones guardadas sin reactivar el
        tratamiento. Esta consulta es gratuita. Para solicitar una corrección u otros datos,{" "}
        <Link to="/settings/privacy" className="underline">
          contacta a Fidy
        </Link>
        .
      </AlertDescription>
    </Alert>
  </div>
);

/** Read-only Transaction access grants neither mutation nor hosted-agent authority. */
export const PrivacyTransactions = (): JSX.Element => {
  const [date, setDate] = useState("");
  const router = useRouter();
  const [historyResource] = useState(() =>
    privacyTransactionHistory(router.options.context.webAuthClient)
  );
  const history = useAtomValue(historyResource.state);
  const dispatch = useAtomSet(historyResource.action);
  const state = history.query;
  if (state._tag === "Initial") {
    return <output className="p-5">Cargando transacciones…</output>;
  }
  if (state._tag === "Failure" || Option.isSome(state.refreshFailure)) {
    return (
      <main className="p-5">
        <Alert variant="destructive">
          <AlertTitle>No pudimos consultar tus transacciones</AlertTitle>
          <AlertDescription>
            Necesitas un inicio de sesión reciente. Tu autorización no se ha reactivado.
          </AlertDescription>
        </Alert>
        <Button variant="outline" render={<Link to="/login" />}>
          Iniciar sesión
        </Button>
        <Button variant="outline" onClick={() => dispatch("reset")}>
          Reintentar
        </Button>
      </main>
    );
  }
  return (
    <TransactionWorkspace
      key={history.generation}
      readOnly
      dateFilter={{ value: date, onChange: setDate }}
      editable={false}
      apiClient={router.options.context.apiClient}
      currentUser={state.value.presentation}
      categories={state.value.categories}
      transactions={state.value.data}
      period={{
        monthLabel: "Transacciones guardadas",
        timeZone: state.value.presentation.timeZone,
      }}
      continuation={history.continuation}
      onMore={() => dispatch("more")}
      onRetryMore={() => dispatch("retry")}
      onRefresh={() => dispatch("reset")}
      queryNotice={<ReadOnlyNotice />}
    />
  );
};
