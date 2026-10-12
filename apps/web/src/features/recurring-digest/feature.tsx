import { type FidyClient, RecurringDigestReportParams } from "@/transport/client";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useParams, useRouter } from "@tanstack/react-router";
import type { JSX } from "react";
import { Option, Schema } from "effect";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { formatMoney } from "@/transport/money";

const UnavailableReport = ({
  onRetry,
  waiting,
}: Readonly<{
  onRetry: () => void;
  waiting: boolean;
}>): JSX.Element => (
  <CanonicalQueryRetry
    onRetry={onRetry}
    waiting={waiting}
    title="Informe no disponible"
    description="Inicia sesión con tu usuario de Fidy para consultar este informe. Si ya lo hiciste, vuelve a intentar."
    retryLabel="Reintentar"
    retryingLabel="Reintentando…"
  />
);

/** Authenticated complete historical facts, preserving every item and exact Currency without active-charge inference. */
export const RecurringDigestFeature = (): JSX.Element => {
  const { id } = useParams({ strict: false });
  const router = useRouter();
  const params = Schema.decodeUnknownOption(RecurringDigestReportParams)({ id });
  if (Option.isNone(params)) {
    return <UnavailableReport onRetry={() => undefined} waiting={false} />;
  }
  return (
    <RecurringDigestReportView apiClient={router.options.context.apiClient} params={params.value} />
  );
};

const RecurringDigestReportView = ({
  apiClient,
  params,
}: Readonly<{
  apiClient: FidyClient;
  params: typeof RecurringDigestReportParams.Type;
}>): JSX.Element => {
  const query = apiClient.query("insights", "getRecurringDigestReport", {
    params,
  });
  const result = useAtomValue(query);
  const state = presentCanonicalQuery(result);
  const refresh = useAtomRefresh(query);
  if (state._tag === "Initial") return <output>Cargando informe…</output>;
  if (state._tag === "Failure") {
    return <UnavailableReport onRetry={refresh} waiting={state.waiting} />;
  }
  const report = state.value.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Patrones históricos de cargos recurrentes</CardTitle>
        <CardDescription>
          {report.payload.confirmationDay.localDate} · {report.payload.confirmationDay.timeZone}.
          Estos patrones no indican que los cargos sigan activos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {Option.isSome(state.refreshFailure) && (
          <UnavailableReport onRetry={refresh} waiting={state.waiting} />
        )}
        <ul className="flex flex-col gap-4" aria-label="Todos los patrones confirmados">
          {report.payload.items.map((item) => (
            <li key={item.confirmationId} className="flex flex-wrap justify-between gap-2">
              <span>{item.counterparty} · mensual</span>
              <span className="font-medium tabular-nums">
                {formatMoney({ locale: report.locale, money: item.money })}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
};
