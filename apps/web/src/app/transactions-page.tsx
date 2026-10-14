import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { SignedInContent } from "@/features/signed-in/feature";
import { HostedAgentFeature } from "@/features/agent/feature";
import { PrivacyTransactionFeature, TransactionListFeature } from "@/features/transactions/feature";

/** Compose ordinary product and privacy-purpose Transactions without mounting agent access after withdrawal. */
export const TransactionsPage = (): JSX.Element => {
  const client = useRouter().options.context.webAuthClient;
  const [query] = useState(() =>
    client.query("processingConsent", "status", {
      timeToLive: "0 seconds",
      reactivityKeys: ["processing-consent"],
    })
  );
  const status = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  if (status._tag === "Ready" && !status.waiting && Option.isNone(status.refreshFailure)) {
    if (status.value.status === "Granted") {
      return (
        <SignedInContent>
          <TransactionListFeature />
          <HostedAgentFeature />
        </SignedInContent>
      );
    }
    if (status.value.status === "Revoked") return <PrivacyTransactionFeature />;
  }
  if (status._tag === "Initial") {
    return <p className="p-5">Verificando acceso…</p>;
  }
  return (
    <main className="p-5">
      <p>No pudimos verificar tu acceso a las transacciones.</p>
      <Button variant="outline" render={<Link to="/auth/pair" />}>
        Iniciar sesión
      </Button>
      <Button variant="outline" onClick={refresh}>
        Reintentar
      </Button>
    </main>
  );
};
