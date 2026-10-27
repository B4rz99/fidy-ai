import { type FidyClient, RecurringDigestReportParams } from "@/transport/client";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useParams, useRouter } from "@tanstack/react-router";
import type { JSX, ReactNode } from "react";
import { Option, Schema } from "effect";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { HistoricalReport } from "./report";
import { InvalidReport, ReportLoading, ReportRefreshFailure, UnavailableReport } from "./status";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";

const ReportWorkspace = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => (
  <main className="settings-workspace recurring-report-workspace">
    <WorkspaceHeader title="Reporte de recurrentes" context={null}>
      {null}
    </WorkspaceHeader>
    {children}
  </main>
);

const ReportContent = (): JSX.Element => {
  const { id } = useParams({ strict: false });
  const router = useRouter();
  const params = Schema.decodeUnknownOption(RecurringDigestReportParams)({ id });
  if (Option.isNone(params)) return <InvalidReport />;
  return (
    <RecurringDigestReportView
      key={params.value.id}
      apiClient={router.options.context.apiClient}
      params={params.value}
    />
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
  if (state._tag === "Initial") return <ReportLoading />;
  if (state._tag === "Failure") {
    return <UnavailableReport onRetry={refresh} waiting={state.waiting} />;
  }
  return (
    <HistoricalReport
      report={state.value.data}
      recovery={
        Option.isSome(state.refreshFailure) ? (
          <ReportRefreshFailure onRetry={refresh} waiting={state.waiting} />
        ) : null
      }
    />
  );
};

export const RecurringDigestFeature = (): JSX.Element => (
  <ReportWorkspace>
    <ReportContent />
  </ReportWorkspace>
);
