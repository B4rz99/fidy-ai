import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import type { ProcessingConsentStatus } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { AccessRefused, SignedInContent } from "@/features/signed-in/feature";
import { HostedAgentFeature } from "@/features/agent/feature";
import { PrivacyTransactionFeature, TransactionListFeature } from "@/features/transactions/feature";

const currentConsent = <E,>(
  state: CanonicalQueryState<ProcessingConsentStatus, E>
): Option.Option<ProcessingConsentStatus> =>
  state._tag === "Ready" && !state.waiting && Option.isNone(state.refreshFailure)
    ? Option.some(state.value)
    : Option.none();

/** Privacy reads use their own cookie proof after ordinary access ends; product views retain SignedInContent. */
export const TransactionsPage = (): JSX.Element => {
  const { webAuthClient: client, initialSessionBinding } = useRouter().options.context;
  const [query] = useState(() =>
    client.query("processingConsent", "status", {
      timeToLive: "0 seconds",
      reactivityKeys: ["processing-consent"],
    })
  );
  const status = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  if (status._tag === "Failure" && initialSessionBinding === "none") {
    return <AccessRefused />;
  }
  const consent = currentConsent(status);
  if (Option.isSome(consent)) {
    if (consent.value.status === "Granted") {
      return (
        <SignedInContent>
          <TransactionListFeature />
          <HostedAgentFeature />
        </SignedInContent>
      );
    }
    if (consent.value.status === "Revoked") return <PrivacyTransactionFeature />;
  }
  if (status._tag === "Initial") {
    return <p className="p-5">Verificando acceso…</p>;
  }
  return (
    <main className="p-5">
      <p>No pudimos verificar tu acceso a las transacciones.</p>
      <Button variant="outline" render={<Link to="/login" reloadDocument />}>
        Iniciar sesión
      </Button>
      <Button variant="outline" onClick={refresh}>
        Reintentar
      </Button>
    </main>
  );
};
