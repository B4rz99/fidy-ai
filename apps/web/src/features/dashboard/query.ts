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

export const dashboardQuery = (apiClient: FidyClient): DashboardLoad => {
  const phase = Atom.make<DashboardLoadPhase>("reading");
  const result = apiClient.runtime
    .atom((get) => loadDashboard(apiClient, (value) => get.set(phase, value)))
    .pipe(apiClient.runtime.factory.withReactivity(["dashboard"]));
  return { phase, result };
};
