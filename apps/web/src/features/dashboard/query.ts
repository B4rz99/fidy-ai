import { activeWorkspaceQuery } from "@/transport/workspace-query";
import { Data, Effect, Schema } from "effect";
import type { AnyRouter } from "@tanstack/react-router";
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
  setPhase: (phase: DashboardLoadPhase) => void,
  isVisiting: () => boolean
) {
  setPhase("reading");
  const client = yield* apiClient;
  return yield* client.dashboard.getDashboardView().pipe(
    Effect.catchTag("DashboardUninitialized", (failure) =>
      !isVisiting()
        ? Effect.fail(failure)
        : Effect.gen(function* () {
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
type DashboardQueryContext = Readonly<{ apiClient: FidyClient; router: AnyRouter }>;
const dashboardVisits = new WeakMap<AnyRouter, () => boolean>();
const dashboardVisit = (router: AnyRouter): (() => boolean) => {
  const read =
    dashboardVisits.get(router) ??
    ((): boolean => router.state.location.pathname === "/app/dashboard");
  dashboardVisits.set(router, read);
  return read;
};
class DashboardQueryKey extends Data.Class<
  Readonly<{ apiClient: FidyClient; isVisiting: () => boolean }>
> {}
const dashboardReads = Atom.family(
  ({ apiClient, isVisiting }: DashboardQueryKey): DashboardLoad["result"] => {
    const phase = dashboardPhase(apiClient);
    const result = apiClient.runtime
      .atom((get) => loadDashboard(apiClient, (value) => get.set(phase, value), isVisiting))
      .pipe(
        Atom.setIdleTTL(0),
        apiClient.runtime.factory.withReactivity(["dashboard"]),
        Atom.setIdleTTL(0)
      );
    return result;
  }
);

export const dashboardQuery = (input: DashboardQueryContext): DashboardLoad => {
  const query = dashboardReads(
    new DashboardQueryKey({ apiClient: input.apiClient, isVisiting: dashboardVisit(input.router) })
  );
  return { phase: dashboardPhase(input.apiClient), result: activeWorkspaceQuery(query) };
};
