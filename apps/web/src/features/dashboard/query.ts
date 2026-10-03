import { Effect } from "effect";
import { type AsyncResult, Atom } from "effect/unstable/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";

export type DashboardLoadPhase = "reading" | "initializing" | "reading-initialized";
type DashboardLoad = Readonly<{
  phase: Atom.Atom<DashboardLoadPhase>;
  result: Atom.Atom<
    AsyncResult.AsyncResult<CanonicalSuccess<"dashboard.getDashboardView">, unknown>
  >;
}>;

/** Opening the Dashboard explicitly composes observation, safe initialization, and a fresh read.
 * Only declared absence permits initialization. Its failure and the second read propagate;
 * refreshing never retries initialization recursively or interprets unavailability as absence.
 * Phase is workflow feedback, not a command or a second owner of the server result.
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
