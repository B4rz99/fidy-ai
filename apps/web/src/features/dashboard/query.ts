import { revalidateWorkspaceQuery, workspaceQueryRetention } from "@/transport/workspace-query";
import { Data, Effect, Option, Schema } from "effect";
import type { AnyRouter } from "@tanstack/react-router";
import { HttpClientError } from "effect/http";
import { type AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";

export type DashboardLoadPhase = "reading" | "initializing" | "reading-initialized";
type DashboardReadRequest = Readonly<{
  attempt: DashboardReadAttempt;
  claim: () => Option.Option<() => void>;
}>;
export type DashboardReadAttempt = Readonly<{ completed: () => boolean }>;
/** Claim in the actual loader, never on an Atom emission. A superseding invocation
 * cannot certify this attempt, and interruption cannot reach its completion callback.
 * Completed recovery remains valid across later ordinary display refreshes.
 */
const makeReadRequest = (): DashboardReadRequest => {
  let completed = false;
  const attempt = { completed: (): boolean => completed };
  let started = false;
  const complete = (): void => {
    completed = true;
  };
  return {
    attempt,
    claim: () => {
      if (started) return Option.none();
      started = true;
      return Option.some(complete);
    },
  };
};
export type DashboardRead = CanonicalSuccess<"dashboard.getDashboardView">;
type DashboardLoad = Readonly<{
  refresh: (registry: AtomRegistry.AtomRegistry) => DashboardReadAttempt;
  phase: Atom.Atom<DashboardLoadPhase>;
  result: Atom.Atom<AsyncResult.AsyncResult<DashboardRead, unknown>>;
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

const loadObservedDashboard = Effect.fnUntraced(function* ({
  apiClient,
  setPhase,
  isVisiting,
  request,
}: Readonly<{
  apiClient: FidyClient;
  setPhase: (phase: DashboardLoadPhase) => void;
  isVisiting: () => boolean;
  request: Option.Option<DashboardReadRequest>;
}>) {
  const completion = Option.flatMap(request, (value) => value.claim());
  const value = yield* loadDashboard(apiClient, setPhase, isVisiting);
  if (Option.isSome(completion)) {
    completion.value();
  }
  return value;
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
const dashboardRequest = Atom.family((_key: DashboardQueryKey) =>
  Atom.make(Option.none<DashboardReadRequest>())
);
const retainedDashboardQuery = Atom.family(
  ({ apiClient, isVisiting }: DashboardQueryKey): DashboardLoad["result"] => {
    const phase = dashboardPhase(apiClient);
    const result = apiClient.runtime
      .atom((get) => {
        const request = get(dashboardRequest(new DashboardQueryKey({ apiClient, isVisiting })));
        return loadObservedDashboard({
          apiClient,
          setPhase: (value) => get.set(phase, value),
          isVisiting,
          request,
        });
      })
      .pipe(
        Atom.setIdleTTL(workspaceQueryRetention.timeToLive),
        apiClient.runtime.factory.withReactivity(["dashboard"]),
        Atom.setIdleTTL(workspaceQueryRetention.timeToLive)
      );
    return result;
  }
);

export const dashboardQuery = (input: DashboardQueryContext): DashboardLoad => {
  const query = retainedDashboardQuery(
    new DashboardQueryKey({ apiClient: input.apiClient, isVisiting: dashboardVisit(input.router) })
  );
  return {
    phase: dashboardPhase(input.apiClient),
    result: revalidateWorkspaceQuery(query),
    refresh: (registry) => {
      const request = makeReadRequest();
      registry.set(
        dashboardRequest(
          new DashboardQueryKey({
            apiClient: input.apiClient,
            isVisiting: dashboardVisit(input.router),
          })
        ),
        Option.some(request)
      );
      return request.attempt;
    },
  };
};
