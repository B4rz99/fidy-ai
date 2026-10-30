import { TransactionPrivacyNotice } from "@/ui/components/transaction-privacy-notice";
import { TransactionsSkeleton } from "@/ui/components/transaction-loading";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, lazyRouteComponent, useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, Suspense, useState } from "react";
import { Button } from "@/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { privacyTransactionHistory } from "./privacy-history";

const TransactionWorkspace = lazyRouteComponent(
  () => import("./workspace"),
  "TransactionWorkspace"
);

const ReadOnlyNotice = (): JSX.Element => (
  <TransactionPrivacyNotice
    privacyLink={
      <Link to="/settings/privacy" className="underline">
        contacta a Fidy
      </Link>
    }
  />
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
    return <TransactionsSkeleton readOnly={true} notice={<ReadOnlyNotice />} />;
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
        <Button variant="outline" render={<Link to="/login" reloadDocument />}>
          Iniciar sesión
        </Button>
        <Button variant="outline" onClick={() => dispatch("reset")}>
          Reintentar
        </Button>
      </main>
    );
  }
  return (
    <Suspense fallback={<TransactionsSkeleton readOnly={true} notice={<ReadOnlyNotice />} />}>
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
    </Suspense>
  );
};
