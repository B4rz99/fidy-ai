import { revalidateWorkspaceQuery, workspaceQueryRetention } from "@/transport/workspace-query";
import { Effect, Schema } from "effect";
import { HttpClientError } from "effect/http";
import { type AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";

export type DashboardLoadPhase = "reading" | "initializing" | "reading-initialized";
type DashboardLoad = Readonly<{
  phase: Atom.Atom<DashboardLoadPhase>;
  result: Atom.Atom<
    AsyncResult.AsyncResult<CanonicalSuccess<"dashboard.getDashboardView">, unknown>
  >;
}>;

/** Only declared absence permits initialization. Initialization and reread failures propagate;
 * refresh never treats unavailability as absence or recursively initializes.
 */
const loadDashboard = Effect.fnUntraced(function* (
  apiClient: FidyClient,
  setPhase: (phase: DashboardLoadPhase) => void
) {
  setPhase("reading");
  const client = yield* apiClient;
  return yield* client.dashboard.getDashboardView().pipe(
    Effect.catchTag("DashboardUninitialized", () =>
      Effect.gen(function* () {
        setPhase("initializing");
        yield* client.dashboard.initializeDashboard();
        setPhase("reading-initialized");
        return yield* client.dashboard.getDashboardView();
      })
    ),
    Effect.catchIf(
      (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
      Effect.die
    )
  );
});

const dashboardPhase = Atom.family((_apiClient: FidyClient) =>
  Atom.make<DashboardLoadPhase>("reading")
);
const retainedDashboardQuery = Atom.family((apiClient: FidyClient): DashboardLoad["result"] => {
  const phase = dashboardPhase(apiClient);
  const result = apiClient.runtime
    .atom((get) => loadDashboard(apiClient, (value) => get.set(phase, value)))
    .pipe(
      Atom.setIdleTTL(workspaceQueryRetention.timeToLive),
      apiClient.runtime.factory.withReactivity(["dashboard"]),
      Atom.setIdleTTL(workspaceQueryRetention.timeToLive)
    );
  return result;
});

export const dashboardQuery = (apiClient: FidyClient): DashboardLoad => {
  const query = retainedDashboardQuery(apiClient);
  return { phase: dashboardPhase(apiClient), result: revalidateWorkspaceQuery(query) };
};
