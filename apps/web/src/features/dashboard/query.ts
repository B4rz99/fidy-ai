import { Effect } from "effect";
import { type AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";

/** Customization observes current structured state; creating a Dashboard is always explicit. */
export const dashboardQuery: (
  apiClient: FidyClient
) => Atom.Atom<AsyncResult.AsyncResult<CanonicalSuccess<"dashboard.getDashboardView">, unknown>> =
  Atom.family((apiClient: FidyClient) =>
    apiClient.runtime
      .atom(() =>
        Effect.gen(function* () {
          const client = yield* apiClient;
          return yield* client.dashboard.getDashboardView();
        })
      )
      .pipe(apiClient.runtime.factory.withReactivity(["dashboard"]), Atom.setIdleTTL(0))
  );
