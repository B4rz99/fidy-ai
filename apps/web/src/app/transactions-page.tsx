import { PendingRead } from "@/ui/components/pending-read";

import {
  consumeInitialTransactionConsent,
  transactionEntryConsent,
} from "@/session/transaction-entry";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, type LoaderFnContext, useRouter } from "@tanstack/react-router";
import { Effect, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { type JSX, useState } from "react";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import type { ProcessingConsentStatus } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { AccessRefused, SignedInContent } from "@/features/signed-in/feature";
import { HostedAgentFeature } from "@/features/agent/feature";
import {
  PrivacyTransactionFeature,
  TransactionListFeature,
  type TransactionSearch,
} from "@/features/transactions/feature";
import { preparationActive, prepareQuery } from "@/transport/query-preparation";
import type { WebRouterContext } from "./router-context";

// Fetch presentation with this route's code while its unchanged query owners check live access.
TransactionListFeature.preload().catch(() => undefined);

const currentConsent = <E,>(
  state: CanonicalQueryState<ProcessingConsentStatus, E>
): Option.Option<ProcessingConsentStatus> =>
  state._tag === "Ready" && !state.waiting && Option.isNone(state.refreshFailure)
    ? Option.some(state.value)
    : Option.none();

/** Privacy reads use their own cookie proof after ordinary access ends; product views retain SignedInContent. */
export const TransactionsPage = (): JSX.Element => {
  const { webAuthClient: client, sessionBinding } = useRouter().options.context;
  const [query] = useState(() => transactionEntryConsent(client));
  const status = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  if (status._tag === "Failure" && sessionBinding === "none") {
    return <AccessRefused />;
  }
  const consent = currentConsent(status);
  if (Option.isSome(consent)) {
    if (consent.value.status === "Granted") {
      return (
        <SignedInContent>
          <TransactionListFeature>{null}</TransactionListFeature>
          <HostedAgentFeature />
        </SignedInContent>
      );
    }
    if (consent.value.status === "Revoked") return <PrivacyTransactionFeature />;
  }
  if (status._tag === "Initial") {
    return <PendingRead label="Cargando transacciones" />;
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

TransactionsPage.preloadData = TransactionListFeature.preloadData;

/** Await entry authority; return ordinary preparation separately so it can finish after route reveal. */
TransactionsPage.prepareEntry = ({
  context,
  search,
  preload,
  cause,
  signal,
}: Readonly<{
  context: WebRouterContext;
  search: TransactionSearch;
  preload: boolean;
  cause: LoaderFnContext["cause"];
  signal: AbortSignal;
}>): Promise<Readonly<{ preparation: Promise<void> }> | void> => {
  if (preload || !preparationActive(signal)) return Promise.resolve();
  return Effect.runPromise(
    Effect.gen(function* () {
      const consent = transactionEntryConsent(context.webAuthClient);
      const initial = consumeInitialTransactionConsent(context.registry);
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry: context.registry,
          query: consent,
          options: {
            mode: initial || cause === "stay" ? "cached" : "fresh",
            signal: Option.some(signal),
          },
        })
      );
      if (!preparationActive(signal)) return;
      const status = context.registry.get(consent);
      if (AsyncResult.isSuccess(status) && status.value.status === "Revoked") {
        yield* Effect.tryPromise(() => PrivacyTransactionFeature.preload());
      }
      if (AsyncResult.isSuccess(status) && !status.waiting && status.value.status === "Granted") {
        return {
          preparation: TransactionsPage.preloadData({
            search,
            apiClient: context.apiClient,
            registry: context.registry,
            signal,
          }).catch(() => undefined),
        };
      }
      return undefined;
    })
  );
};
